/**
 * Post-session reflection pass — the host-side "janitor" half of the hybrid
 * memory model (see docs/memory.md).
 *
 * The agent maintains USER.md / MEMORY.md live during a session. After the
 * session goes quiet (container stopped), this pass reads only the messages
 * that arrived since the last run (a per-session timestamp watermark), asks an
 * LLM to extract anything the agent missed, and RECONCILES it into the existing
 * files — ADD new facts, UPDATE with more detail, DELETE contradictions, NOOP
 * duplicates. It returns the merged file contents, which we write atomically.
 *
 * Because it merges into whatever is already there (rather than regenerating
 * from scratch) it can't fight the agent's own edits, and because it only runs
 * when the container is stopped the two writers never overlap.
 *
 * Verified, reusable procedures are saved as skills — but only when the
 * transcript shows the procedure actually ran / was confirmed (Voyager rule).
 *
 * API routing: prefers the OneCLI gateway (HTTPS proxy that injects the vault's
 * Anthropic credential on the wire — same mechanism agent containers use),
 * which unlocks Sonnet as the reflection model. Falls back to a direct call
 * with ANTHROPIC_API_KEY (Haiku — the Claude Code OAuth token tier) when the
 * gateway is unreachable or the proxied call fails.
 */
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

import { readEnvFile } from './env.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb } from './session-manager.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getSession, updateSession } from './db/sessions.js';
import { GROUPS_DIR, ONECLI_API_KEY, ONECLI_URL } from './config.js';
import { requestApproval, registerApprovalHandler } from './modules/approvals/index.js';

const envConfig = readEnvFile(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'REFLECTION_MODEL']);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || envConfig.ANTHROPIC_API_KEY;
const ANTHROPIC_BASE_URL =
  process.env.ANTHROPIC_BASE_URL || envConfig.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

// Model for the reflection pass. Sonnet is the better choice on quality grounds
// — reflection's mistakes are persistent (written to disk, loaded into every
// future session) and the keep-vs-evict judgment is subtle — but the default
// Claude Code OAuth token only has working Haiku access via the direct
// Messages API (Sonnet 429s on that token tier). So the model follows the
// route: Sonnet through the OneCLI gateway (the vault's Anthropic credential
// is injected on the wire), Haiku on the direct-key fallback. Setting
// REFLECTION_MODEL overrides both routes.
const REFLECTION_MODEL_OVERRIDE = process.env.REFLECTION_MODEL || envConfig.REFLECTION_MODEL;
const GATEWAY_MODEL = REFLECTION_MODEL_OVERRIDE || 'claude-sonnet-4-6';
const DIRECT_MODEL = REFLECTION_MODEL_OVERRIDE || 'claude-haiku-4-5-20251001';
const MAX_CONVERSATION_CHARS = 40_000;
const USER_BUDGET_CHARS = 2000; // ~500 tokens
const MEMORY_BUDGET_CHARS = 3200; // ~800 tokens
// Soft-instruction budgets historically failed (files grew to 5-6x budget), so
// writes are also gated in code: anything over budget × this factor gets one
// forced consolidation pass before being written. The tolerance keeps us from
// burning an extra LLM call when a file is only marginally over.
const BUDGET_HARD_FACTOR = 1.25;

const REFLECTION_PROMPT = `You are the memory janitor for a personal-assistant agent. You maintain two markdown files that persist across sessions and are loaded into the agent's context every time:

- USER.md — WHO the user is: identity, durable preferences, communication style. Budget ~${USER_BUDGET_CHARS} chars.
- MEMORY.md — environment/project facts, conventions, lessons learned. Budget ~${MEMORY_BUDGET_CHARS} chars.

You are given the CURRENT contents of both files plus a NEW slice of conversation. Reconcile what the conversation reveals INTO the existing files. For each candidate fact, behave like:
- ADD — genuinely new info → add a concise bullet to the right file.
- UPDATE — you already knew something and now know more → merge into the existing line.
- DELETE — new info contradicts an old line → remove the stale line, keep the new truth. Latest info wins.
- NOOP — already captured → change nothing.

Rules, in priority order (when they conflict, the earlier rule wins):
1. BUDGETS ARE LIMITS, NOT SUGGESTIONS. Each file's measured size is given in its heading. If a file is over budget after merging, you MUST return it consolidated to under budget — staying under budget outranks preserving detail.
2. The test for every line: will it change the agent's behavior in a future, unrelated session? Durable facts, conventions, and lessons learned pass. EVICT lines that fail: completed work items (merged PRs, shipped fixes), dated snapshots ("user count: 53 on Jun 17"), status flags ("in progress", "pending", "awaiting"), one-off task state, todos, and anything easily re-discovered (GitHub, logs, one API call). When evicting an event, keep its distilled lesson if it has one.
3. Otherwise preserve existing facts. If new info contradicts an old line, latest truth wins.
4. Keep bullets concise and concrete. Merge overlapping bullets; deduplicate.
5. Only return a file's content if it CHANGED. If a file needs no change, return null for it.

SKILLS: If the conversation contains a non-trivial, reusable procedure AND the transcript shows it actually WORKED (a tool ran successfully, a test passed, or the user confirmed it), emit it as a skill. Do NOT emit skills for untested ideas, plans, or "this might be reusable" guesses — only verified procedures.

Return valid JSON only, no explanation, in this exact shape:
{
  "user_md": "full updated USER.md content" | null,
  "memory_md": "full updated MEMORY.md content" | null,
  "skills": [ { "name": "kebab-case-name", "description": "one line", "content": "full SKILL.md markdown body" } ]
}`;

interface ReflectionResult {
  user_md: string | null;
  memory_md: string | null;
  skills: Array<{ name: string; description: string; content: string }>;
}

export async function reflectOnSession(agentGroupId: string, sessionId: string): Promise<void> {
  if (!ANTHROPIC_API_KEY) {
    log.debug('Skipping reflection — ANTHROPIC_API_KEY not set');
    return;
  }

  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) return;
  const session = getSession(sessionId);
  if (!session) return;

  const since = session.last_reflected_at ?? null;
  const slice = buildConversationSlice(agentGroupId, sessionId, since);
  if (!slice || slice.text.length === 0) return; // nothing new — cheap no-op

  const groupDir = path.join(GROUPS_DIR, agentGroup.folder);
  const userPath = path.join(groupDir, 'USER.md');
  const memoryPath = path.join(groupDir, 'MEMORY.md');
  const currentUser = readFileOrEmpty(userPath);
  const currentMemory = readFileOrEmpty(memoryPath);

  let result: ReflectionResult;
  try {
    result = await callReflectionApi(currentUser, currentMemory, slice.text);
  } catch (err) {
    log.warn('Reflection API call failed', { sessionId, err });
    return; // leave watermark unadvanced so we retry next sweep
  }

  // Enforce the budget on the FINAL content — merged output when the merge
  // changed a file, the existing file otherwise. The "otherwise" leg is what
  // lets files that bloated before budget enforcement existed shrink
  // automatically: the next reflection after any session activity consolidates
  // them even if the session added nothing new.
  const candidateUser = result.user_md && result.user_md.trim() ? result.user_md : currentUser;
  const finalUser = await enforceBudget('USER.md', candidateUser, USER_BUDGET_CHARS);
  const userChanged = finalUser.trim().length > 0 && finalUser !== currentUser;
  if (userChanged) {
    writeAtomic(userPath, finalUser.trimEnd() + '\n');
  }

  const candidateMemory = result.memory_md && result.memory_md.trim() ? result.memory_md : currentMemory;
  const finalMemory = await enforceBudget('MEMORY.md', candidateMemory, MEMORY_BUDGET_CHARS);
  const memoryChanged = finalMemory.trim().length > 0 && finalMemory !== currentMemory;
  if (memoryChanged) {
    writeAtomic(memoryPath, finalMemory.trimEnd() + '\n');
  }

  // Learned skills are standing instructions auto-discovered by every future
  // session — and the transcript they're extracted from can contain untrusted
  // text (webpages, emails, other chat members). Never write them unattended;
  // route each through the admin approval flow instead.
  let skillsRequested = 0;
  for (const skill of result.skills) {
    if (skillFileExists(agentGroup.folder, skill.name)) continue;
    await requestApproval({
      session,
      agentName: agentGroup.name,
      action: 'save_learned_skill',
      payload: { folder: agentGroup.folder, ...skill },
      title: `Save learned skill "${skill.name}"?`,
      question: [
        `Reflection on a ${agentGroup.name} session extracted a reusable procedure:`,
        '',
        `**${skill.name}** — ${skill.description}`,
        '',
        '```',
        skill.content.length > 1500 ? skill.content.slice(0, 1500) + '\n…[truncated]' : skill.content,
        '```',
      ].join('\n'),
    }).catch((err) => log.warn('Failed to request skill approval', { name: skill.name, err }));
    skillsRequested++;
  }

  // Advance the watermark to the newest message we just processed.
  updateSession(sessionId, { last_reflected_at: slice.maxTimestamp });

  log.info('Session reflection complete', {
    sessionId,
    userChanged,
    memoryChanged,
    skillsRequested,
  });
}

// On approve, actually write the skill file. Registered at module load;
// src/index.ts imports this module at startup so the handler exists even if
// the approval is answered after a host restart.
registerApprovalHandler('save_learned_skill', async ({ payload, notify }) => {
  const folder = typeof payload.folder === 'string' ? payload.folder : '';
  const name = typeof payload.name === 'string' ? payload.name : '';
  const description = typeof payload.description === 'string' ? payload.description : '';
  const content = typeof payload.content === 'string' ? payload.content : '';
  if (!folder || !name || !content) {
    notify(`Learned skill could not be saved: malformed approval payload.`);
    return;
  }
  const written = writeSkillFile(folder, { name, description, content });
  notify(
    written ? `Learned skill "${name}" saved.` : `Learned skill "${name}" not saved (already exists or invalid name).`,
  );
});

interface ConversationSlice {
  text: string;
  maxTimestamp: string;
}

/**
 * Read messages newer than `since` from BOTH session DBs, interleaved in
 * timestamp order (so the dialogue reads naturally), and keep the most recent
 * tail if over the char cap.
 */
function buildConversationSlice(
  agentGroupId: string,
  sessionId: string,
  since: string | null,
): ConversationSlice | null {
  let inDb, outDb;
  try {
    inDb = openInboundDb(agentGroupId, sessionId);
    outDb = openOutboundDb(agentGroupId, sessionId);
  } catch {
    return null;
  }

  try {
    const cutoff = since ?? '';
    const inboundRows = inDb
      .prepare(
        `SELECT timestamp, content FROM messages_in
         WHERE kind IN ('chat','chat-sdk','task') AND timestamp > ?
         ORDER BY timestamp ASC`,
      )
      .all(cutoff) as Array<{ timestamp: string; content: string }>;

    const outboundRows = outDb
      .prepare(
        `SELECT timestamp, content FROM messages_out
         WHERE kind = 'chat' AND timestamp > ?
         ORDER BY timestamp ASC`,
      )
      .all(cutoff) as Array<{ timestamp: string; content: string }>;

    const merged = [
      ...inboundRows.map((r) => ({ ts: r.timestamp, line: `[User]: ${r.content}` })),
      ...outboundRows.map((r) => ({ ts: r.timestamp, line: `[Assistant]: ${r.content}` })),
    ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    if (merged.length === 0) return null;

    const maxTimestamp = merged[merged.length - 1].ts;
    let text = merged.map((m) => m.line).join('\n\n');
    // Keep the most-recent tail, not the oldest head.
    if (text.length > MAX_CONVERSATION_CHARS) {
      text = '...[earlier truncated]\n\n' + text.slice(text.length - MAX_CONVERSATION_CHARS);
    }
    return { text, maxTimestamp };
  } finally {
    inDb.close();
    outDb.close();
  }
}

async function callReflectionApi(
  currentUser: string,
  currentMemory: string,
  conversation: string,
): Promise<ReflectionResult> {
  // LLM output is non-deterministic — a malformed/truncated JSON response is
  // transient, so retry once before giving up (the caller leaves the watermark
  // unadvanced on a hard failure and re-tries next sweep anyway).
  try {
    return await attemptReflection(currentUser, currentMemory, conversation);
  } catch (err) {
    if (err instanceof SyntaxError || (err instanceof Error && err.message === 'truncated')) {
      return await attemptReflection(currentUser, currentMemory, conversation);
    }
    throw err;
  }
}

async function attemptReflection(
  currentUser: string,
  currentMemory: string,
  conversation: string,
): Promise<ReflectionResult> {
  // Models can't reliably count characters — hand them the measurement so
  // "over budget" is an observable fact, not a guess.
  const sizeLabel = (content: string, budget: number): string => {
    const over = content.length > budget;
    return `(currently ${content.length} chars; budget ${budget}${over ? ' — OVER BUDGET, consolidation required' : ''})`;
  };

  const userMessage = [
    `## Current USER.md ${sizeLabel(currentUser, USER_BUDGET_CHARS)}`,
    currentUser || '(empty)',
    '',
    `## Current MEMORY.md ${sizeLabel(currentMemory, MEMORY_BUDGET_CHARS)}`,
    currentMemory || '(empty)',
    '',
    '## New conversation',
    conversation,
  ].join('\n');

  const text = (await callAnthropic(REFLECTION_PROMPT, userMessage)) || '{}';

  const cleaned = text
    .replace(/^```json?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const parsed = JSON.parse(cleaned) as Partial<ReflectionResult>;

  return {
    user_md: typeof parsed.user_md === 'string' ? parsed.user_md : null,
    memory_md: typeof parsed.memory_md === 'string' ? parsed.memory_md : null,
    skills: Array.isArray(parsed.skills)
      ? parsed.skills.filter(
          (s) => s && typeof s.name === 'string' && typeof s.description === 'string' && typeof s.content === 'string',
        )
      : [],
  };
}

/**
 * Code-level backstop for the memory budgets. The reflection prompt already
 * asks for consolidation, but a soft instruction is what let these files grow
 * to 5-6x budget in the first place — so anything still meaningfully over
 * budget after the merge gets one focused consolidation call before we write.
 * If that call fails or doesn't help, we still write the merged content (losing
 * a session's facts is worse than a fat file) and log a warning so a human sees.
 */
async function enforceBudget(fileLabel: string, content: string, budget: number): Promise<string> {
  if (content.length <= budget * BUDGET_HARD_FACTOR) return content;

  const system = `You maintain ${fileLabel}, a memory file for a personal-assistant agent that is loaded into its context on every turn. Rewrite it to fit under ${budget} characters.

Keep (highest value first): durable facts, conventions, lessons learned, working preferences.
Evict: completed work items (merged PRs, shipped fixes), dated snapshots, status flags ("in progress", "pending"), one-off task state, anything easily re-discovered. When evicting an event, keep its distilled lesson if it has one.
Merge overlapping bullets. Keep section headings that still earn their place.

Return ONLY the rewritten markdown file content — no explanation, no code fences.`;

  try {
    const text = await callAnthropic(system, `${fileLabel} (${content.length} chars, budget ${budget}):\n\n${content}`);
    const cleaned = text
      .replace(/^```(?:markdown|md)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    if (cleaned && cleaned.length < content.length) {
      if (cleaned.length > budget * BUDGET_HARD_FACTOR) {
        log.warn('Memory file still over budget after consolidation', {
          fileLabel,
          size: cleaned.length,
          budget,
        });
      }
      return cleaned;
    }
  } catch (err) {
    log.warn('Budget consolidation call failed', { fileLabel, err });
  }

  log.warn('Writing memory file over budget (consolidation did not help)', {
    fileLabel,
    size: content.length,
    budget,
  });
  return content;
}

/** One non-streaming Messages API call; returns the text block. Throws 'truncated' on max_tokens so callers can retry. */
// ---------------------------------------------------------------------------
// Transport: OneCLI gateway (preferred) with direct-key fallback.
//
// The gateway is the same HTTPS forward proxy agent containers use: we ask it
// for its proxy config (proxy URL + CA cert), send the request through it to
// the real api.anthropic.com, and it swaps our auth header for the vault's
// Anthropic credential on the wire. That credential can be a real API key,
// which is what unlocks Sonnet. Config is fetched once and cached; any
// gateway-path failure drops the cache (so a restarted gateway is picked up
// next run) and the call retries directly with ANTHROPIC_API_KEY.
// ---------------------------------------------------------------------------

interface GatewayRoute {
  dispatcher: ProxyAgent;
}

let cachedGatewayRoute: GatewayRoute | null | undefined; // undefined = not yet probed

async function resolveGatewayRoute(): Promise<GatewayRoute | null> {
  if (cachedGatewayRoute !== undefined) return cachedGatewayRoute;
  if (!ONECLI_URL) {
    cachedGatewayRoute = null;
    return null;
  }
  try {
    const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
    const config = await onecli.getContainerConfig();
    const proxyUrl = config.env.HTTPS_PROXY || config.env.https_proxy;
    if (!proxyUrl || !config.caCertificate) {
      cachedGatewayRoute = null;
      return null;
    }
    cachedGatewayRoute = {
      dispatcher: new ProxyAgent({
        uri: proxyUrl,
        // The gateway MITMs the tunneled TLS with its own CA — trust it for
        // the proxied connection only (not process-wide).
        requestTls: { ca: config.caCertificate },
      }),
    };
    log.info('Reflection routing through OneCLI gateway', { model: GATEWAY_MODEL });
  } catch {
    cachedGatewayRoute = null; // gateway down — retry probe next reflection run
  }
  return cachedGatewayRoute;
}

async function callAnthropic(system: string, userMessage: string): Promise<string> {
  const gateway = await resolveGatewayRoute();
  if (gateway) {
    try {
      return await sendMessagesRequest(GATEWAY_MODEL, system, userMessage, gateway);
    } catch (err) {
      // Truncation is a model-output problem, not a routing problem — let the
      // caller's retry handle it on the same (better) model.
      if (err instanceof Error && err.message === 'truncated') throw err;
      // Anything else (proxy down, no Anthropic secret in the vault, 429 on
      // the injected credential): drop the cached route and fall through to
      // the direct path so reflection keeps working.
      cachedGatewayRoute = undefined;
      log.warn('Gateway reflection call failed — falling back to direct API', { err });
    }
  }
  return sendMessagesRequest(DIRECT_MODEL, system, userMessage, null);
}

async function sendMessagesRequest(
  model: string,
  system: string,
  userMessage: string,
  gateway: GatewayRoute | null,
): Promise<string> {
  // Bearer auth for OAuth tokens; x-api-key for raw API keys. On the gateway
  // path this header is a placeholder the proxy overwrites with the vault
  // credential (when one matches api.anthropic.com); sending our real token
  // means the request still works if the vault has no Anthropic secret.
  const authHeaders: Record<string, string> = ANTHROPIC_API_KEY!.startsWith('sk-ant-api')
    ? { 'x-api-key': ANTHROPIC_API_KEY! }
    : { Authorization: `Bearer ${ANTHROPIC_API_KEY}` };

  const requestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...authHeaders,
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  };

  // Node's global fetch ignores HTTPS_PROXY; undici's fetch takes an explicit
  // dispatcher. Gateway path always targets the real Anthropic host — the
  // proxy is the route, not the destination.
  const response = gateway
    ? await undiciFetch('https://api.anthropic.com/v1/messages', {
        ...requestInit,
        dispatcher: gateway.dispatcher,
      })
    : await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, requestInit);

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as {
    stop_reason?: string;
    content: Array<{ type: string; text: string }>;
  };
  // A truncated response yields incomplete output — fail fast so callers retry
  // rather than parse garbage.
  if (data.stop_reason === 'max_tokens') {
    throw new Error('truncated');
  }
  return data.content.find((b) => b.type === 'text')?.text ?? '';
}

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function sanitizeSkillName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 64);
}

function skillFileExists(agentFolder: string, rawName: string): boolean {
  const name = sanitizeSkillName(rawName);
  if (!name) return true; // unusable name — treat as "nothing to request"
  return fs.existsSync(path.join(GROUPS_DIR, agentFolder, 'skills', name, 'SKILL.md'));
}

function writeSkillFile(agentFolder: string, skill: { name: string; description: string; content: string }): boolean {
  const name = sanitizeSkillName(skill.name);
  if (!name) return false;

  const skillDir = path.join(GROUPS_DIR, agentFolder, 'skills', name);
  const skillFile = path.join(skillDir, 'SKILL.md');

  // Don't overwrite existing skills
  if (fs.existsSync(skillFile)) return false;

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    const frontmatter = `---\nname: ${name}\ndescription: ${skill.description.replace(/\n/g, ' ')}\n---\n\n`;
    writeAtomic(skillFile, frontmatter + skill.content);
    log.info('Wrote learned skill', { name, path: skillFile });
    return true;
  } catch (err) {
    log.warn('Failed to write skill file', { name, err });
    return false;
  }
}
