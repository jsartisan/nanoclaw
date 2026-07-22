/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change to inbound.db here.
 */
import fs from 'fs';

import type Database from 'better-sqlite3';

import { wakeContainer } from '../../container-runner.js';
import { getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { cancelTask, insertTask, pauseTask, resumeTask, updateTask, type TaskUpdate } from './db.js';

/**
 * A scheduled task lives in exactly one session's inbound.db, but an agent
 * group can run many sessions (one per messaging group / thread). The agent
 * may call pause/cancel/resume/update from a *different* session than the one
 * that owns the task — e.g. paused from webchat a task that was scheduled in a
 * DM. Applying the change only to the caller's DB silently no-ops in that case.
 *
 * This fans the mutation out across every session in the agent group. The
 * caller's already-open connection is reused; sibling sessions get a short-
 * lived connection each. Returns the total rows touched so callers can detect
 * a no-match (task id that exists in no session).
 */
function applyAcrossGroupSessions(
  callerSession: Session,
  callerDb: Database.Database,
  apply: (db: Database.Database) => number,
): number {
  let touched = apply(callerDb);
  for (const sibling of getSessionsByAgentGroup(callerSession.agent_group_id)) {
    if (sibling.id === callerSession.id) continue;
    // openInboundDb would CREATE the file if the directory exists — an empty
    // shell DB the real session bootstrap should own. Skip absent siblings.
    if (!fs.existsSync(inboundDbPath(callerSession.agent_group_id, sibling.id))) continue;
    let db: Database.Database | undefined;
    try {
      db = openInboundDb(callerSession.agent_group_id, sibling.id);
      touched += apply(db);
    } catch (err) {
      // Best-effort fan-out — a broken sibling DB must not fail the caller's
      // mutation, but don't hide it entirely either.
      log.warn('Task fan-out skipped a sibling session', { siblingSessionId: sibling.id, err });
    } finally {
      db?.close();
    }
  }
  return touched;
}

/**
 * Tell the agent its task mutation matched nothing live, then wake it so the
 * message is seen. Mirrors update_task's long-standing behaviour for the other
 * verbs, so a mistyped or stale id surfaces instead of failing silently.
 */
function notifyNoMatch(session: Session, verb: string, taskId: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text: `${verb}: no live task matched id "${taskId}".`,
      sender: 'system',
      senderId: 'system',
    }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after task notification', { verb, err }));
  }
}

export async function handleScheduleTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = content.script as string | null;
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;

  insertTask(inDb, {
    id: taskId,
    processAfter,
    recurrence,
    platformId: (content.platformId as string) ?? null,
    channelType: (content.channelType as string) ?? null,
    threadId: (content.threadId as string) ?? null,
    content: JSON.stringify({ prompt, script }),
  });
  log.info('Scheduled task created', { taskId, processAfter, recurrence });
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const touched = applyAcrossGroupSessions(session, inDb, (db) => cancelTask(db, taskId));
  log.info('Task cancelled', { taskId, touched });
  if (touched === 0) notifyNoMatch(session, 'cancel_task', taskId);
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const touched = applyAcrossGroupSessions(session, inDb, (db) => pauseTask(db, taskId));
  log.info('Task paused', { taskId, touched });
  if (touched === 0) notifyNoMatch(session, 'pause_task', taskId);
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const touched = applyAcrossGroupSessions(session, inDb, (db) => resumeTask(db, taskId));
  log.info('Task resumed', { taskId, touched });
  if (touched === 0) notifyNoMatch(session, 'resume_task', taskId);
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const update: TaskUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }
  const touched = applyAcrossGroupSessions(session, inDb, (db) => updateTask(db, taskId, update));
  log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
  if (touched === 0) notifyNoMatch(session, 'update_task', taskId);
}
