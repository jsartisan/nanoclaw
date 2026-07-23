---
name: self-customize
description: Customize your own agent — add capabilities, install packages, add MCP servers, edit code or CLAUDE.md. Use when the user asks you to add a feature, install a tool, or modify how you work. For non-trivial code changes, delegate to the coder subagent (Task tool).
---

# Self-Customization

You can modify your own environment. Different kinds of changes have different workflows.

## Decision Tree

**What needs to change?**

- **Your persona / how you behave** (tone, standing instructions) → Edit `CLAUDE.local.md` directly, no approval needed. (The composed `CLAUDE.md` itself is read-only and regenerated every spawn — put custom instructions in `CLAUDE.local.md` instead.) Do NOT put memory here — facts about the user go in `USER.md`, project facts/lessons in `MEMORY.md`.
- **Other files in your workspace** → Edit directly, no approval needed. Your workspace (`/workspace/agent/`) is persisted on the host.
- **System package (apt) or global npm package** → `install_packages`. Requires admin approval. On approval, image rebuild + container restart happen automatically.
- **MCP server** → `add_mcp_server`. Requires admin approval. On approval, container restarts with the new server wired up (no rebuild — bun runs TS directly).
- **Your source code or Dockerfile** → Delegate to the `coder` subagent (see below).

## Workflow: Code Changes via the Coder Subagent

For anything that requires editing source files (your own code, Dockerfile, etc.), **do not edit directly in the main conversation** — delegate to the `coder` subagent (Task tool). It runs on a stronger model tuned for engineering work, and keeps your main session focused.

1. Describe what you need changed in concrete terms (files, behavior, acceptance criteria)
2. Launch a `coder` Task with that description, plus these scope rules in the prompt:
   - **Minimal scope.** Only change what was requested — no refactoring surrounding code or adding unrequested features.
   - **Diff size limit.** Keep a single task under ~200 new / 150 modified lines; a bigger feature should be split into sequential tasks, each with its own scope.
   - **Report back** what files changed, a summary, and any follow-up needed (rebuild, tests, migrations). No silent partial work.
   - **Safety:** never commit or push, never touch secrets/credentials/.env, stop and report if a change would break existing tests.
3. Review the subagent's summary and confirm with the user. Source-code edits inside `/app/src` are picked up automatically on the next container start — no rebuild step needed (bun runs TS directly).

## Diff Size Limits — Why

A 50-line focused change is reviewable. A 500-line sweep is not. Hard limits force work to decompose into reviewable chunks, which:

- Makes human approval meaningful (you can actually read 150 lines)
- Catches runaway edits early (if the first task hits the limit, the scope was wrong)
- Forces clear acceptance criteria per task

The limits are **per task**, not per session. A 500-line feature is fine as 4 sequential coder tasks of ~125 lines each, each with its own scope.

## Example: Adding a New MCP Tool to Yourself

User: "Can you add a tool for reading RSS feeds?"

1. Check [mcp.so](https://mcp.so) for an existing RSS MCP server
2. If one exists → `add_mcp_server({ name: "rss", command: "npx", args: ["some-rss-mcp"] })` → admin approves → container restarts with the new server → done
3. If nothing suitable exists → delegate to the `coder` subagent:
   - Task prompt: "Add an MCP tool 'read_rss' to container/agent-runner/src/mcp-tools/. It should fetch an RSS URL and return the latest N items. Register it in mcp-tools/index.ts. Target: <200 new lines."
   - Review its report — new tool code is picked up on the next container start (bun runs TS directly)

## Example: Installing a System Tool

User: "Can you transcribe audio?"

1. Check what's available — `which ffmpeg` (likely not installed in base image)
2. Decide approach: `@xenova/transformers` (npm, workspace-local) or `whisper.cpp` (apt + compile)
3. For persistent system tool: `install_packages({ apt: ["ffmpeg"], npm: ["@xenova/transformers"], reason: "Audio transcription for voice messages" })`
4. Wait for admin approval — on approve, the image is rebuilt and your container is restarted automatically
5. Test the new capability once the container restarts

## When NOT to Self-Customize

- **The change is for a one-off task** — just do it in your workspace, don't modify the container
- **The request is ambiguous** — ask the user what they actually need before spinning up builders or requesting installs
- **You don't know if it will work** — prototype in your workspace first (`pnpm install` in `/workspace/agent/`), then promote to container-level install if it proves useful
