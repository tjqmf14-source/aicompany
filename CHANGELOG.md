# Changelog

## 2026-09-26 — Phase 8 Security / Recovery / QA

### Added

- SQLite schema migration v8
- durable Security Audit records
- durable deterministic QA Run/check evidence
- startup recovery of interrupted QA records
- SQLite quick-check and foreign-key integrity checks
- unfinished Git operation detection
- dirty working-tree WARN state
- bounded tracked secret/environment-file heuristic scan
- Handoff / Codex / Parallel / QA recovery blocker aggregation
- conservative Release Ready gate
- six-command deterministic QA runner
- repository mutation detection during QA
- QA output redaction and size bounding
- loopback Host restriction
- security response headers
- Security Fastify API
- Dashboard Security Audit / Release Ready / Recovery blocker state
- durable Security/QA Event records
- 33 Phase 8 acceptance/security/recovery tests

### QA

- Phase 8: 33/33 PASS
- Phase 1-7 regression: 144/144 PASS
- total: 177/177 PASS
- typecheck / lint / build / git diff --check PASS on functional Run #90
- npm audit: 0 vulnerabilities

### Not included

- exhaustive secret or malware scanning
- OS sandboxing
- public-network API authentication/TLS
- release code signing
- Phase 9 Windows packaging
- Final Release Audit

## 2026-09-26 — Phase 7 Parallel Agent / Git Worktree

### Added

- SQLite schema migration v7 for durable parallel worker lanes
- real Git worktree + managed branch isolation per Task
- Organization plan / role / provider linkage for logical workers
- Core Run lifecycle linkage for parallel work
- optional path-scope reservation and overlap blocking
- changed-file scope enforcement on submission
- committed result / ancestry verification
- actual primary-vs-worker file conflict detection
- Checkpoint + manual Approval integration gate
- stale target HEAD protection
- `git merge --no-ff --no-commit` integration staging
- typecheck / lint / test / build before integration commit
- automatic merge abort on validation failure
- restart recovery for interrupted worker/integration lanes
- safe completed-lane worktree/branch release
- Parallel Fastify API
- Dashboard parallel lane state and durable events
- 32 Phase 7 acceptance/security tests

### QA

- Phase 7: 32/32 PASS
- Phase 1-6 regression: 112/112 PASS
- total: 144/144 PASS
- typecheck / lint / build / git diff --check PASS on functional Run #70
- npm audit: 0 vulnerabilities

### Not included

- autonomous GPT High API invocation
- fake multi-agent model processes
- silent redirection of existing Codex execution into worktrees
- Phase 8 expanded security / recovery audit
- Phase 9 Windows packaging

## 2026-09-24 — Phase 6 Capability / Skill / MCP Manager

### Added

- SQLite schema migration v6 and durable Capability Manager state
- multi-axis capability discovery/install/auth/cost/verification/runtime/enablement/approval model
- capability source trust, checks, dependencies, operations and file-change evidence
- strict local Skill discovery, Approval-gated install and hash-safe rollback
- MCP config discovery with secret-value redaction
- ZERO-COST/source-trust gates and modern/legacy MCP probes
- deterministic MCP child-process cleanup
- Capability Manager API and Dashboard integration
- 46 Phase 6 acceptance/security tests

### QA

- Phase 6: 46/46 PASS
- Phase 1-5 regression: 66/66 PASS
- total: 112/112 PASS
- typecheck / lint / build / git diff --check PASS on Run #64
- npm audit: 0 vulnerabilities

### Not included

- arbitrary remote Skill search/install
- secret-forwarding MCP execution
- paid or unknown-cost activation
- Phase 7 parallel agents / Git worktrees
- Phase 8 expanded security / recovery
- Phase 9 Windows packaging

## 2026-09-24 — Phase 5 AI Company Organization / Executive PD

### Added

- SQLite schema migration v5 for Organization state
- Executive PD orchestration service
- 12 logical organization roles
- Task role / priority / provider assignments
- real Task dependency graph and readiness gating
- Provider routing restricted to GPT_HIGH / CODEX / SYSTEM
- Manual Handoff dispatch for GPT_HIGH
- CodexExecutionService delegation for CODEX
- Validation → Independent Review → QA → PD Acceptance gate pipeline
- gate failure → blocked → rework flow
- Core Approval requirement before final PD completion
- durable Organization Event records
- Organization Fastify API
- Dashboard Role / Priority / Dependency / PD Stage integration
- COMMAND CENTER Current Role / Active Roles / Review / QA / PD Acceptance state
- 29 Phase 5 acceptance tests

### QA

- Phase 5 tests: 29/29 PASS
- Phase 1-4 regression: 37/37 PASS
- total: 66/66 PASS
- typecheck / lint / build / npm audit / git diff --check PASS on functional Run #42

### Not included

- autonomous GPT High API invocation
- Phase 6 Capability/Skill/MCP automation
- Phase 7 parallel agents / Git worktrees
- Phase 8 expanded security / recovery
- Phase 9 Windows packaging

# Changelog

## 2026-09-22 — Phase 4 Minimal Web Dashboard

### Added

- 한국어 로컬 Web Dashboard 10개 화면
- Dashboard aggregate state/service 계층
- Dashboard 전용 Fastify API
- SSE 기반 realtime state update
- 실제 Project/Task/Run/Git/Handoff/Codex/Approval/Checkpoint 상태 표시
- 실제 Backend primitive 기반 control gating
- Git diff / Patch preview 표시
- Validation 결과 및 상세 로그 표시
- Capability Registry foundation
- ZERO-COST 정책을 유지하는 Settings 화면
- 브라우저 선택 Project와 로컬 UI 설정 유지
- Phase 4 acceptance test 15개

### QA

- 기존 Phase 1~3 regression 22개 유지
- 전체 37개 테스트 PASS 기준
- GitHub Actions gate에 `git diff --check origin/main...HEAD` 추가
- typecheck, lint, build, npm audit 기존 gate 유지

### Not included

- Phase 5 AI Company Organization
- Phase 6 capability 자동 설치/MCP 관리
- 유료 API Key 입력 또는 유료 Provider
