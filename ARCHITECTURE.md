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
- UI remains intentionally basic. The Phase 1 Core has no Handoff or App Server dependency.

## Phase 2 extension

Phase 2 adds `src/handoff` and SQLite migration 3 without replacing the Phase 1 Core. `HandoffProvider` is an adapter boundary; the included `ManualHandoffProvider` writes packet files and reads a user-saved High response. The `HandoffCore` service validates responses, paths and Git patches, saves preflight and preapply checkpoints, applies an explicitly reviewed patch, runs the four existing validation scripts, and either records queued follow-up Tasks or safely restores touched files. The manual CLI is the mutation surface; no High API call or Codex Provider exists. See [HANDOFF_PROTOCOL.md](./HANDOFF_PROTOCOL.md) for the exact state machine and recovery rules.


## Phase 3 extension

Phase 3 adds `src/codex` and SQLite migration 4. The Codex provider uses the locally installed App Server with ChatGPT auth only, reads the Codex rate-limit state before dispatch, and stores execution/thread/turn references in SQLite. Rate-limit or interruption paths capture a Git checkpoint and automatically create a Phase 2 Handoff bundle instead of failing the project. A saved thread is resumed only when the current Git snapshot exactly matches the interruption checkpoint; otherwise a clean changed repository starts a new thread and a changed dirty repository is blocked for review. See [PHASE3_PROTOCOL.md](./PHASE3_PROTOCOL.md).


## Phase 4 extension — Minimal Web Dashboard

Phase 4는 Phase 1~3의 Core, Handoff, Codex Provider를 재작성하지 않고 그 위에 `src/dashboard` 집계 계층과 Dashboard 전용 Fastify API를 추가한다. Dashboard는 SQLite와 Git의 실제 상태를 읽으며, 존재하지 않는 role/priority/dependency/phase 같은 값은 추측하지 않고 “기록 없음”으로 노출한다.

구조는 다음과 같다.

```
React/Vite Dashboard
        ↓ HTTP + SSE
Fastify Dashboard API (src/server/dashboard.ts)
        ↓
DashboardService (src/dashboard/service.ts)
   ↙          ↓           ↘
Core/SQLite   Handoff     Codex Execution Store
   ↓
GitManager
```

실시간 전송은 **SSE(Server-Sent Events)** 를 사용한다. Phase 4의 실시간 요구는 서버에서 브라우저로 Task/Run/Codex/Validation/Approval/Checkpoint/Git 상태를 전달하는 단방향 흐름이 핵심이므로, 양방향 프로토콜인 WebSocket보다 구현 면적과 연결 상태 관리가 작다. 브라우저의 `EventSource` 자동 재연결도 사용할 수 있다. 서버는 1초마다 실제 상태 fingerprint를 확인하지만 payload는 상태가 달라진 경우에만 `snapshot` 이벤트로 전송하고, 15초 heartbeat를 보낸다. 별도의 저빈도 전체 재조회는 연결 복구 보조 수단이며 실시간의 주 경로가 아니다.

Dashboard 전용 API는 `/api/dashboard/*` 아래에 분리되어 있다. 읽기 API는 Projects, Project aggregate state, Capabilities, Settings를 제공하고, 제어 API는 기존 안전 primitive가 존재하는 Pause/Resume/Cancel/Approval/Checkpoint/Handoff/Codex dispatch·resume/Patch apply·rollback만 호출한다. 실제 primitive가 없거나 안전 조건이 충족되지 않으면 UI control은 `UNAVAILABLE` 또는 `BLOCKED`로 표시된다.

10개 MVP 화면은 COMMAND CENTER, PROJECTS, TASKS, ACTIVITY, CHANGES, VALIDATION, CODEX, CHECKPOINTS, CAPABILITIES, SETTINGS이다. UI 언어는 한국어를 기본으로 하고 내부 상태 식별자는 원문 영어를 유지한다. 키보드 focus, semantic table/nav/header, alert/loading/empty state, 버튼 비활성 사유와 명시적 status text를 포함한다.

Phase 4는 SQLite schema migration을 추가하지 않는다. Validation 화면은 Phase 2 Handoff verification에 실제 저장된 typecheck/lint/test/build 결과를 표시하며, Core에 저장되지 않는 npm audit, git diff --check, 분리된 integration-test 결과는 임의로 성공 처리하지 않고 `NOT RUN`으로 표시한다. CI의 Phase 4 gate는 별도로 `git diff --check`, typecheck, lint, 전체 37개 테스트, build, npm audit를 실행한다.


## Phase 5 extension — AI Company Organization / Executive PD

Phase 5 adds `src/organization` as an orchestration layer above the verified Core/Handoff/Codex/Dashboard stack. It does not replace the Phase 1-4 source-of-truth model.

```
React/Vite Dashboard
        ↓
Dashboard + Organization API
        ↓
OrganizationService / Executive PD
        ↓
Core Task / Approval / Event
   ↙          ↓          ↘
SYSTEM     Handoff      Codex
           GPT HIGH    App Server
```

SQLite migration **v5** adds `organization_plans`, `organization_assignments`, `organization_dependencies`, and `organization_gates`. Existing Core Tasks remain the executable task records. Organization tables attach logical role, priority, provider routing, dependency, PD stage, and gate evidence without rewriting the Core Task schema.

The approved logical roles are Executive PD, Planning, Research, Design Director, UI/UX, Visual Design, Engineering Director, Coding, Code Review, QA, Security, and Release. A role is shown as active only when one of its assigned tasks is actually ready, running, waiting for user/provider, or reviewing. Queued dependency-blocked roles are not shown as active.

Provider routing is restricted to `GPT_HIGH`, `CODEX`, and `SYSTEM`. Unknown or paid-provider identifiers are rejected. `GPT_HIGH` dispatch reuses the existing Phase 2 Manual Handoff path. `CODEX` dispatch delegates to the existing Phase 3 CodexExecutionService. `SYSTEM` does not generically mark work complete; it reports that a specific deterministic system primitive is required.

Executive PD enforces this pipeline:

```
planning
  → execution
  → validation
  → independent_review
  → qa
  → pd_acceptance
  → completed
```

All Organization Tasks must be `passed` before leaving execution. Each later gate requires an explicit PASS record. A FAIL moves the plan to `blocked`; `rework` returns it to execution. Entering PD Acceptance creates a normal Core Approval, and the plan cannot complete until both the PD Acceptance gate is PASS and that Approval is approved.

Task dependencies are stored as real Core Task IDs. A queued downstream task becomes `ready` only when every dependency is `passed`. Organization routing independently re-checks dependency completion, so the orchestration endpoint cannot dispatch a dependency-blocked task.

The Dashboard now reads Organization state and fills the previously unavailable Role, Priority, Dependency, and PD Stage values. COMMAND CENTER also exposes Current Role, Active Roles, pending Independent Review, QA status, and PD Acceptance status. Organization events use the existing durable Event log; no synthetic agent chat or percentage progress is generated.

Organization API endpoints are under `/api/organization/*` and cover plan creation/state, start/refresh/advance/rework, gate recording, route inspection, and provider dispatch.

### Phase 5 boundaries

- GPT High is not called as an API. The default integration remains Manual Handoff.
- The PD plan is structured input; Phase 5 does not claim autonomous GPT-driven task decomposition.
- Live Codex App Server execution still depends on the user's local Codex installation and ChatGPT authentication. Phase 5 reuses, rather than replaces, the Phase 3 provider.
- Generic SYSTEM tasks are not auto-completed because no arbitrary deterministic executor exists.
- Capability/Skill/MCP auto-management remains Phase 6.
- Parallel agents/Git worktrees remain Phase 7.
- Security/recovery expansion remains Phase 8.


## Phase 6 extension — Capability / Skill / MCP Manager

Phase 6 adds `src/capabilities` and SQLite migration 6. Capability state is persisted across independent discovery, installation, authentication, cost, verification, runtime, enablement and approval axes. Explicit verification/runtime failures are ERROR, while paid and unknown-cost capabilities remain blocked by the ZERO-COST policy.

Skill management is intentionally constrained: local `SKILL.md` trees are statically validated, unsafe names and symlink/junction traversal are rejected, and source hashes are recorded. Installation requires Core Approval and Checkpoint, re-validates the approved source before mutation, never overwrites an existing destination, and rolls back only unchanged files created by that operation. Static validation does not claim Codex runtime recognition.

MCP management reads supported local configuration, records trust/cost/auth requirements, redacts credential values and refuses automatic execution for paid, unknown-cost, untrusted or credential-dependent definitions. Approved free definitions may receive a bounded modern `server/discover` or legacy `initialize` protocol probe. Probe child processes are explicitly terminated and awaited.

The API under `/api/capability-manager/*` provides discovery, evidence/detail, Skill install/rollback, MCP verification and enable/disable controls. Dashboard capability state comes from the durable registry and recorded operations.


## Phase 7 extension — Parallel Agent / Git Worktree

Phase 7 adds `src/parallel` and SQLite migration 7. A parallel agent is represented as a durable worker lane attached to a real Core Task and, when present, its Phase 5 Organization plan/role/provider. Phase 7 does not invent background model processes: the lane is the isolated Git execution substrate that a provider or human worker operates on.

Each lane owns a generated `ai-company/parallel/*` branch and a real Git worktree stored outside the primary worktree. Primary and worker state are therefore physically isolated. Optional repository-relative scope paths can reserve areas of the tree; overlapping active scopes are rejected and submitted results are checked against their declared scope.

The lane lifecycle is persisted in SQLite and linked to a real Core Run. Submission requires a clean committed result branch descending from the captured base HEAD. The service stores the result HEAD and actual changed-file list before integration review.

Integration is deliberately two-phase. A preview compares the result changes with primary changes since the lane base, captures a Core Checkpoint and requests manual Approval. After Approval the exact target/result HEADs are rechecked, Git stages a no-commit merge, and `typecheck`, `lint`, `test`, and `build` run against the staged merge. Validation is also checked for unexpected tracked-file mutation. Only a complete PASS creates the merge commit; failure aborts the merge before commit.

Startup recovery marks unsafe in-flight states as `RECOVERY_REQUIRED`. Known interrupted merges can be safely aborted when MERGE_HEAD matches the recorded result, completed merge commits can be recognized by parent identity, committed worker results can return to REVIEW, and interrupted workers can resume with a new Core Run. Unknown states are blocked for manual review.

Completed lanes can be released only after the result is confirmed integrated into primary history and both primary and worker worktrees are clean. The managed worktree and merged branch are then removed through normal Git safety checks.

Parallel state is available through `/api/parallel/*` and is included in Dashboard aggregate state and durable Activity events.


## Phase 8 extension — Security / Recovery / QA

Phase 8 adds `src/security` and SQLite migration 8. The layer is conservative: no audit or QA evidence means NOT READY, WARN is not release-ready, and unresolved recovery-required state blocks release readiness.

Security audits persist deterministic checks for SQLite health/foreign keys, Git HEAD and unfinished operation state, working-tree state, bounded tracked secret heuristics, and unresolved recovery blockers. Dirty source is WARN; hard integrity/secret/recovery failures are FAIL/BLOCKED. Secret evidence stores affected paths rather than credential contents.

Recovery aggregation covers Handoff `recovery_required`, Codex `recovery_required`, Parallel `RECOVERY_REQUIRED`, and active QA runs. QA rows left RUNNING after process termination become INTERRUPTED exactly at server startup. Dashboard reads are side-effect free.

The Phase 8 QA runner records `git diff --check HEAD --`, typecheck, lint, test, build, and npm audit. Later checks continue after an earlier failure where possible. Repository state is captured before and after validation; a validation process that changes HEAD/branch/diff/porcelain state causes QA failure. Persisted output is bounded and credential-like strings are redacted.

Release readiness requires a PASS QA run followed by a PASS security audit and zero recovery blockers. This is an evidence gate, not a claim of complete system security.

The Fastify layer adds loopback Host validation in addition to the executable's existing `127.0.0.1` bind and emits `nosniff`, no-referrer, frame-deny and no-store response headers. Phase 8 remains a local-only application and does not add public-network authentication or TLS.

Security endpoints live under `/api/security/*`. Dashboard aggregate state includes Security state, and COMMAND CENTER exposes Security Audit, Release Ready and Recovery blocker indicators.
