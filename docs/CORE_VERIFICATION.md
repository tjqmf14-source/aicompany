# Phase 1 Core verification

Gate: all required Phase 1 checks must pass before the `core-verified` commit. This document records the checks run on the local Windows workspace. Commands are reproducible from the repository root.

| Check | Command or test | Result |
| --- | --- | --- |
| New Git repository | `npm test`: new repository test | PASS |
| Existing Git repository | `npm test`: existing repository test | PASS |
| SQLite migration | `npm test`: version 1 to 2, preserved row, repeat open | PASS |
| Project save/restore | `npm test`: close and reopen | PASS |
| Task save/restore | `npm test`: close and reopen | PASS |
| Git tracked diff | `npm test`: modified README in existing repo | PASS |
| Dirty working tree | `npm test`: tracked and untracked changes, Run guard | PASS |
| Checkpoint | `npm test`: dirty snapshot persisted | PASS |
| Restart recovery | `npm test`: running Run interrupted once after reopen | PASS |
| Other core records | `npm test`: Artifact, Decision, Event, Approval, Capability | PASS |
| HTTP API | `npm test`: Fastify injection with valid and invalid input | PASS |
| Live local server | `node dist/server/server/main.js`, `GET http://127.0.0.1:4319/health` | PASS: `status=ok`, schema version 2 |
| Typecheck | `npm run typecheck` | PASS |
| Lint | `npm run lint` | PASS |
| Build | `npm run build` | PASS: server and Vite output |
| Dependency integrity | `npm ls --depth=0` | PASS |
| Dependency audit | `npm audit --audit-level=high` | PASS: 0 vulnerabilities |

`npm test` completed with **7 passing tests, 0 failures**. The test workspace is local to `tests/.tmp` and removed after each test. Git ignored output and local SQLite state were checked with `git check-ignore`. The Phase 0 limitations remain in [FEASIBILITY_REPORT.md](./FEASIBILITY_REPORT.md) and [ARCHITECTURE.md](../ARCHITECTURE.md).

Phase 1 result: **CORE_VERIFIED = YES**. Phase 2 behavior was not implemented.
