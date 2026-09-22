# Codex Execution Provider + Recovery — Phase 3

Phase 3 adds a local Codex execution adapter without changing the Phase 1/2 sources of truth. The repository, Git and SQLite remain authoritative; Codex thread history is only a resumable reference.

## Zero-cost boundary

The production provider launches the locally installed Codex App Server and accepts only `account/read` auth mode `chatgpt`. API-key auth is rejected so this phase cannot silently fall back to usage-billed OpenAI API calls. Known external MCP servers used during the Phase 0 probe are disabled for this provider process. No paid API, SaaS, VPS or cloud runtime is required by the application.

## State machine

`checking → running → completed`

If Codex is unavailable before a run, the execution moves directly to `high_ready`. If an active Codex turn is interrupted or rate-limited, AI Company captures a Git checkpoint, marks the Core Run `interrupted`, moves the Task to `waiting_provider`, and creates a Phase 2 Handoff bundle. A non-limit provider failure with possible partial work is stored as `recovery_required` with the same checkpoint + Handoff protection.

On process restart, Core recovery first converts any active Core Run to `interrupted`; Phase 3 then converts `checking`/`running` execution rows to `recovery_required`. The explicit `recover` command creates a fresh checkpoint and Handoff bundle without overwriting project files.

## Safe resume rule

A previous Codex thread is reused only when the current Git HEAD, branch, changed-file list and full diff exactly match the recorded interruption checkpoint. This allows a rate-limited dirty workspace to continue in the same thread. If the repository changed and is clean, AI Company starts a safe new Codex thread. If it changed and remains dirty, resume is blocked for manual review rather than guessing which edits are authoritative.

## CLI

From a registered project root:

`npm run codex -- check`

`npm run codex -- run <taskId> [objective] [model] [effort]`

`npm run codex -- resume <executionId> [model] [effort]`

`npm run codex -- recover <executionId>`

`npm run codex -- status <executionId>`

`npm run codex -- list <projectId>`

Phase 3 does not auto-commit Codex changes and does not claim QA completion for a Codex turn. A completed Codex Run moves the Task to `reviewing` and stores the resulting Git checkpoint for later deterministic validation and review.
