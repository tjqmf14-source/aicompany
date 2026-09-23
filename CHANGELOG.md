# Changelog

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
