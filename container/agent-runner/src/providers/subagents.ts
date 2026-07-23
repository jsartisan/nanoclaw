/**
 * Heavy-reasoning subagent definitions for the Claude provider.
 *
 * The main conversation loop runs on the group's configured model — typically
 * a cheap/fast one (`model` in container_configs, e.g. sonnet). These
 * subagents run on Opus at high reasoning effort, so complex engineering work
 * gets a stronger model without paying Opus prices for every chat turn.
 *
 * Claude routes work to them via the SDK `Task` tool by matching the task
 * against each `description`. Delegation guidance for the main agent lives in
 * the shared base prompt (`container/CLAUDE.md`, "Delegating heavy work").
 *
 * Deliberately NOT given clawie MCP tools (send_message etc.) — the main
 * agent owns all user communication and relays subagent results. No `Task`
 * either: subagents don't spawn subagents.
 */
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

/**
 * Pinned deliberately (repo convention) — bump when a newer Opus ships.
 * The alias 'opus' would auto-track the newest Opus instead.
 */
const HEAVY_MODEL = 'claude-opus-4-8';
const HEAVY_EFFORT = 'high';

/** Work tools only — file IO, shell, search. No messaging, no nesting. */
const WORK_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'NotebookEdit',
  'ToolSearch',
];

/**
 * Reviewer is read-only by design: findings go in its report, fixes go
 * through `coder`. Bash stays available for running tests/linters and
 * `git diff` — its prompt forbids mutations.
 */
const REVIEW_TOOLS = ['Bash', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch'];

const SHARED_RULES = `
Work autonomously — you cannot ask questions mid-task; make reasonable
decisions and flag assumptions in your report. You cannot message users:
report to the main agent, which relays results.

Rules:
- Read files fully before editing; follow the existing patterns of the codebase.
- Minimal scope: only what the task asks. No drive-by refactors or extras.
- Run relevant tests/builds when they exist; report their results honestly.
- Never commit or push. Never touch secrets, credentials, or .env files.
- Finish with a report: what changed (files), what you verified, what
  follow-up is needed. If you could not finish, say exactly what is missing —
  no silent partial work.`;

export const SUBAGENTS: Record<string, AgentDefinition> = {
  coder: {
    description:
      'Complex coding and engineering work: implementing features, writing scripts or full apps, ' +
      'multi-file changes or refactors, building and deploying websites. ' +
      'Use for any coding task beyond a trivial one-file tweak.',
    prompt: `You are a senior software engineer handling a delegated coding task.
${SHARED_RULES}`,
    tools: WORK_TOOLS,
    model: HEAVY_MODEL,
    effort: HEAVY_EFFORT,
  },
  debugger: {
    description:
      'Debugging and root-cause analysis: failing tests or builds, stack traces, crashes, ' +
      'wrong output, performance problems. Use when something is broken and the cause is not obvious.',
    prompt: `You are a senior engineer doing root-cause analysis on a delegated problem.

Method: reproduce the problem first, gather runtime evidence (logs, failing
tests, actual vs expected output), form a hypothesis, and verify it with
evidence before changing anything. Then apply the minimal fix and re-run the
reproduction to prove it is resolved. Report the root cause, the evidence,
and the fix — not just "it works now".
${SHARED_RULES}`,
    tools: WORK_TOOLS,
    model: HEAVY_MODEL,
    effort: HEAVY_EFFORT,
  },
  reviewer: {
    description:
      'Code review: inspecting a diff, branch, or set of files for bugs, security issues, ' +
      'missed edge cases, and consistency with the codebase. Use after coder finishes non-trivial ' +
      'work, or when asked to review existing code. Read-only — reports findings, never edits.',
    prompt: `You are a senior engineer reviewing code that someone else wrote.

You are READ-ONLY: never modify, create, or delete files, and never run
commands that mutate state (no installs, no git commit/push/checkout).
Running tests, linters, builds, and \`git diff\`/\`git log\` is fine.

Review for: real bugs and broken edge cases first, then security issues,
then divergence from the surrounding codebase's patterns. Read enough
context around each change to judge it — a diff alone is not context.
Do not pad the report with style nitpicks unless they hide bugs.

Report findings ordered by severity, each with file:line, what is wrong,
and a concrete suggested fix. End with a verdict: ship it, ship after
fixes, or needs rework. If everything is genuinely fine, say so briefly —
do not invent problems to look thorough.
${SHARED_RULES}`,
    tools: REVIEW_TOOLS,
    model: HEAVY_MODEL,
    effort: HEAVY_EFFORT,
  },
};
