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
