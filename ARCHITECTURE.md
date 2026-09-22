# AI Company Bridge architecture — Phase 1 Core

## Scope and source of truth

The local repository holds project files. Git holds the code history and current working-tree state. SQLite holds durable domain records. ChatGPT conversations, Codex tasks and App Server events are external references, not authoritative state. Phase 1 has no App Server runtime dependency and contains no handoff automation.

```
React/Vite (minimal status UI) → Fastify (loopback API)
                                   ↓
                              CoreEngine
                              ↙       ↘
                     CoreRepository   GitManager
                           ↓              ↓
                       SQLite         local Git CLI
```

`CoreEngine` validates the Git repository and applies the clean-tree gate before starting a run. `CoreRepository` persists Projects, Tasks, Runs, Checkpoints, Artifacts, Decisions, Events, Approvals and Capabilities. Its state changes and corresponding Events share SQLite transactions. `GitManager` runs fixed Git argument arrays through `execFileSync` without a shell. It only reads repository state; it never checks out a branch, commits, resets, cleans or pushes.

## Durable state

SQLite database: `.ai-company/state.sqlite` by default, ignored by Git. The database enables foreign keys and WAL mode. `PRAGMA user_version` tracks migrations. Migration 1 creates Projects and Tasks; migration 2 adds the remaining seven domain tables. Each migration is transactional and repeatable on reopen. Database copies should include the WAL file or be made with SQLite's backup mechanism while the server is running.

Project statuses: `draft → active → paused | blocked | review | completed | failed`, with returns to `active` from `paused`, `blocked` and `review`. Task statuses: `queued → ready → running → reviewing → passed`, with explicit waiting, failure and cancellation paths in `domain.ts`. Invalid transitions fail. Optional `version` values on state updates reject stale writes. A Run starts only from a `ready` or `waiting_provider` task. Completing, failing or cancelling a Run moves its Task to `reviewing`, `failed` or `cancelled` in the same transaction.

At startup, every persisted `running` Run becomes `interrupted`, its Task becomes `waiting_provider`, and a `run.interrupted` Event is saved. This is conservative recovery: it does not silently resume external work. Reopening again adds no duplicate interruption Event. Phase 2 may attach provider identities and resumption decisions; Phase 1 does not.

Checkpoints store an immutable Git snapshot (root, branch, HEAD, porcelain changes, tracked diff, dirty flag and timestamp) in SQLite. Capturing a checkpoint does not alter Git. Untracked file names appear in `changes`; Git's diff excludes their contents. A dirty working tree blocks new Runs, while checkpoint capture remains possible. Artifacts are local existing files within the repository; canonical paths and symlink targets are checked, files are limited to 100 MiB, and SHA-256 is saved. No automatic restore or destructive cleanup occurs.

## Local API and development

The Fastify server binds to `127.0.0.1:3187` and limits JSON bodies to 1 MiB. It exposes health, project and task creation/list/status, run start/list/finish, Git snapshot, checkpoint capture/list, Events, Artifacts, Decisions, Approvals and Capabilities reads. The repository layer implements creation or resolution of the latter records; a broader UI and workflow orchestration belong to later phases. Input errors have explicit 4xx responses. Unexpected errors do not return stack traces.

From the project root, run `npm ci`, then `npm run dev:server` and `npm run dev:web` in separate terminals. Open the Vite address printed by the second command. Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` for the Phase 1 gate. No API key, paid provider, cloud host or VPS is required.

## Boundaries and known limitations

- Codex App Server is currently marked experimental. Core code has no App Server import or required process. A future adapter may translate its events into durable records.
- Actual Codex usage-limit exhaustion was not reproduced in Phase 0; no automatic usage-limit transition is claimed here.
- Skill discovery can vary between App Server executions. Capability rows represent observations with `checkedAt`, not a permanent catalogue.
- SQLite and the local Git working tree are separate stores. A checkpoint records their observed state but does not make a cross-store atomic transaction. Recovery rechecks Git before future Runs.
- One local server process is assumed. There is no authentication for the loopback API; it must not be exposed on a public interface.
- UI remains intentionally basic in Phase 1. No Phase 2 Handoff Core behavior is implemented.
