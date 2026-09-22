# Handoff Core protocol — Phase 2

## Scope

The Handoff Core is a local, manual bridge between ChatGPT Plus High, the repository, SQLite and future Codex work. It does **not** call ChatGPT Plus as an API and does not implement a Codex provider. A person copies the packet to High and saves High's JSON response to a local file. `HandoffProvider` defines packet publishing and response reading; `ManualHandoffProvider` is the Phase 2 implementation. No paid API, SaaS or MCP is used.

The Phase 1 Core remains the source of truth. Migration 3 adds only the `handoffs` table. Project, Task, Run and Git Manager behavior remains in their existing modules. The local SQLite database and bundle files normally live under `.ai-company/`, which Git ignores in this repository.

## Manual workflow

1. Register a local Git project through the Phase 1 API if it is not registered. Its project ID is shown by `GET /api/projects`.
2. From the project root, run `npm run handoff -- bundle <projectId> "Objective text" [taskId]`. The command returns a bundle path and handoff ID. Bundle creation can capture a dirty repository for analysis.
3. Review the bundle for sensitive material before copying it to ChatGPT Plus High. The packet includes `objective.md`, `context.md`, `decisions.md`, `completed.md`, `remaining.md`, `changed-files.json`, `git.diff`, `tests.json`, `build.json`, `errors.log` and `HANDOFF_PROMPT.md`. An absent test/build history is marked `NOT_RECORDED`; it is never shown as PASS.
4. Save High's JSON response inside the project workspace or alongside the bundle. Run `npm run handoff -- import <handoffId> <response.json>`. Import validates the schema and paths, records a preflight Git checkpoint, runs a Git dry-run, writes `preview.diff`, classifies command suggestions and creates pending Approval records for `DANGEROUS` commands. Import does not execute a command or change project files.
5. Inspect `npm run handoff -- preview <handoffId>` or `preview.diff`. An explicit `npm run handoff -- apply <handoffId>` rechecks Git HEAD, branch, clean state, paths and dry-run, then captures a second checkpoint immediately before changing files.
6. Apply runs the fixed local `typecheck → lint → test → build` scripts. The scripts in `package.json` must exist and remain identical to the prepatch scripts. On success, decisions are persisted and `codexTasks` become queued Phase 1 Tasks. They are **not** dispatched to Codex in Phase 2.
7. If validation fails, the touched files are restored from the SQLite checkpoint if their current hashes still match the applied files. The session becomes `failed`, with command results and `rollback=PASS`. If another process changed a file, HEAD or branch, or a validation script touched an unrelated file, the session becomes `recovery_required` and no user change is overwritten. Inspect it with `npm run handoff -- status <handoffId>` and use `npm run handoff -- rollback <handoffId>` only after resolving the conflict.

The packet's Git diff contains tracked changes; `changed-files.json` also lists untracked names. An empty `git.diff` is valid. Packet contents are local files, never uploaded by this module.

## HighResponse JSON schema

All keys below are required. Unknown keys are rejected. Strings, array lengths and total size are bounded in `src/handoff/schema.ts`.

```json
{
  "summary": "What was done or proposed",
  "decisions": ["Decision to record"],
  "patches": ["Git-format unified diff text"],
  "newFiles": [{ "path": "src/new-file.ts", "content": "full UTF-8 file content" }],
  "commands": ["suggested command, never automatically executed"],
  "tests": ["suggested tests"],
  "codexTasks": [{ "title": "Follow-up", "description": "Work description", "acceptanceCriteria": ["Observable check"] }],
  "remainingTasks": ["Remaining work"],
  "questions": ["Question for the user"],
  "riskNotes": ["Risk or uncertainty"]
}
```

`patches` accepts Git-format unified diffs with `diff --git`, `---`, `+++` and hunk headers. Each target must be a regular tracked file or a new regular file. Renames, deletions, mode changes, binary patches and submodules are rejected. `newFiles` contains full text for new files and cannot overlap a patch target. Canonical path checks reject traversal, symlinks, Git metadata, `.ai-company`, dependencies, build output, `.env` files, `.npmrc`, Windows device names and paths outside the project root. Git's own `apply --check` runs before preview and again immediately before apply; it does not modify files. [Git documents `--check` and atomic default apply behavior](https://git-scm.com/docs/git-apply).

Command risk classes: `SAFE` is a small read-only allowlist, `REVIEW` is a known local operation such as the four validation scripts, and `DANGEROUS` includes destructive, composed, external or unrecognized commands. `DANGEROUS` creates a pending Approval. **No suggested command is executed by Phase 2, even if its Approval is later marked approved.** A future command executor must require its own explicit authorization and separate safety review.

## Durable state and recovery

Handoff status is `awaiting_response → ready_to_apply → applying → verified | failed | recovery_required`. SQLite stores the validated response, preview, prepatch file bytes and hashes, Git checkpoint ID, verification outputs and any recovery error. A restart preserves ready and verified sessions. An `applying` session becomes `recovery_required` on startup; it is not silently resumed. Rollback compares current bytes with both the original and recorded postapply hashes before restoring only files named in the checkpoint. It never runs `git reset --hard`, `git clean`, branch switching or a force push.

This protocol assumes one local Handoff process at a time. There is no cross-process lock or atomic transaction spanning SQLite and the Git working tree. A crash in the narrow interval between a file write and recording its postapply hash may require manual inspection. Build tools may create ignored output; rollback restores patch targets and refuses unrelated tracked or untracked changes. Do not expose the loopback server publicly. Inspect the packet before sharing, especially `git.diff` and logs, because repository data can contain sensitive content.

Phase 0 limitations remain: real Codex usage exhaustion was not reproduced, App Server is currently marked experimental, and Skill discovery may differ across runs. The manual provider makes none of these a requirement for Phase 2 operation.
