# Phase 2 verification

Baseline: Phase 1 `core-verified` commit `255b342420c1e1507d2f2dacee609ea61993807d`, 7/7 tests PASS, typecheck/lint/build PASS, clean working tree. Phase 2 extends this baseline with migration 3 and a separate `src/handoff` module.

| Requirement | Direct evidence | Result |
| --- | --- | --- |
| Provider abstraction and manual provider | `HandoffProvider`, `ManualHandoffProvider`; bundle and file import integration test | PASS |
| Separate-process CLI | Test invokes bundle/import/preview/apply through real Node child processes | PASS |
| Eleven bundle files | Test checks each named file exists | PASS |
| Structured HighResponse | Missing/unknown fields and array/path validation test | PASS |
| Unified diff import and dry-run | Git patch parsed, paths matched against `git apply --numstat -z`, `git apply --check`; preview test | PASS |
| Workspace and canonical path checks | Traversal, `.git`, Windows device name, actual Windows junction and dirty tree rejection tests | PASS |
| Checkpoint before patch | Preflight and preapply checkpoints; test observes clean preapply snapshot | PASS |
| Patch apply | Existing file changed and new file created in isolated Git fixture | PASS |
| Four verification gates | Success test records typecheck, lint, test and build PASS in order | PASS |
| Failed verification rollback | Typecheck failure and later build failure restore original file bytes; Git state clean | PASS |
| Script mutation guard | Patch changing `package.json` scripts rolls back before script execution | PASS |
| Restart recovery | Ready, applying and verified states reopened from SQLite; conflicting user edit preserved | PASS |
| Codex follow-up tasks | High `codexTasks` become queued local Tasks after success | PASS |
| Command risk and approval | SAFE/REVIEW/DANGEROUS classification and pending Approval for dangerous suggestion; none executed | PASS |
| Phase 1 regression | Original 7 tests remain in `npm test` | PASS |
| Existing local database migration | Node SQLite backup saved at `.ai-company/state-before-phase2-20260922.sqlite`; schema 2 → 3; both databases returned `PRAGMA integrity_check=ok` and 0 project rows | PASS |
| Local server after migration | Real listener `GET /health` on `127.0.0.1:4321` returned `status=ok`, `schemaVersion=3` | PASS |
| Production CLI load | `npm run handoff -- list nonexistent-project` built server and returned `[]` | PASS |
| TypeScript typecheck | `npm run typecheck` | PASS |
| Lint | `npm run lint` | PASS |
| Build | `npm run build` built Fastify server and Vite output | PASS |
| Dependency audit | `npm audit --audit-level=high` | PASS: 0 vulnerabilities |
| Dependencies | `npm ls --depth=0`; no package added in Phase 2 | PASS |
| Actual ChatGPT Plus High exchange | No user-provided High response was available; fixture JSON exercised the manual protocol | NOT RUN |

Final `npm test` reports **17 PASS, 0 FAIL, 0 SKIP**. The test process used temporary Git repositories under `tests/.tmp` and removed them after each case. `handoff-core-verified` is recorded after the commit is created. Known limits are documented in [HANDOFF_PROTOCOL.md](./HANDOFF_PROTOCOL.md). Phase 3 Codex Provider is not implemented.
