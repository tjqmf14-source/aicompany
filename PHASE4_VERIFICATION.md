# Phase 4 Verification

Date: 2026-09-22
Branch: `feature/phase4-dashboard`
Baseline main: `55f0065779036a8d27328f4a203a79951387d9ac`
Verified functional code commit: `f2c7ecc95a01cfbe74a70982d83203dbf5eccc93`
Pre-documentation GitHub Actions run: `35733433727` (Run #29)

## 구현 범위

Phase 4는 Phase 1~3 Core/Handoff/Codex Provider를 유지하고 그 위에 Dashboard client/API 계층을 추가했다.

구현 화면:

- COMMAND CENTER
- PROJECTS
- TASKS
- ACTIVITY
- CHANGES
- VALIDATION
- CODEX
- CHECKPOINTS
- CAPABILITIES
- SETTINGS

실제 SQLite/Git/Handoff/Codex execution 상태를 집계한다. Core에 없는 role, priority, dependency, current phase 값은 추측하지 않고 `기록 없음`으로 표시한다. 가짜 진행률과 가짜 Agent 대화는 생성하지 않는다.

## Realtime

방식: **SSE (Server-Sent Events)**

선택 이유:

- Phase 4의 핵심은 서버 → Dashboard 상태 알림인 단방향 전송이다.
- WebSocket보다 연결/프로토콜 관리가 단순하다.
- 브라우저 `EventSource`의 자동 재연결을 사용할 수 있다.
- 서버는 실제 aggregate state fingerprint가 바뀐 경우에만 snapshot payload를 전송한다.
- heartbeat는 15초 간격이며, 브라우저의 저빈도 전체 refresh는 연결 복구 보조 수단이다.

검증 테스트는 실제 Fastify loopback 서버에 연결하여 첫 SSE snapshot을 수신한 뒤 Task 상태를 변경하고 두 번째 snapshot에 변경 상태가 반영되는지 확인한다.

## API 변경

Dashboard 전용 API는 `/api/dashboard/*`로 분리했다.

읽기:

- `GET /api/dashboard/projects`
- `GET /api/dashboard/projects/:id`
- `GET /api/dashboard/projects/:id/capabilities`
- `GET /api/dashboard/projects/:id/settings`
- `GET /api/dashboard/projects/:id/stream` (SSE)
- `GET /api/dashboard/projects/:id/codex/check`

제어:

- Project pause/resume
- Task/run cancel
- Checkpoint create
- Approval approve/reject
- Handoff create/import/apply/rollback
- Codex dispatch/resume

Dashboard는 기존 Core/Handoff/Codex 메서드를 사용한다. Phase 4에서 SQLite schema migration은 추가하지 않았다.

## Control gating

실제 Backend primitive 또는 안전 조건이 존재할 때만 버튼을 활성화한다.

- Pause: active Run이 없고 Project가 active일 때만 사용
- Resume: paused/blocked/review Project 또는 waiting Task
- Cancel: 취소 가능한 Task/Run
- Approve/Reject: pending Approval
- Create Checkpoint: 기존 Core checkpoint 사용
- ChatGPT High에서 계속하기: Phase 2 Handoff 생성
- High 결과 가져오기: awaiting_response Handoff
- Codex로 보내기: ready/waiting_provider + clean Git + Codex 설치
- Codex 재개: high_ready/recovery_required execution
- Diff 보기: Core Git snapshot
- Patch Preview: 실제 Handoff preview
- Patch Apply: ready_to_apply Handoff
- Rollback: recoverable Handoff checkpoint

조건이 맞지 않으면 `BLOCKED` 또는 `UNAVAILABLE`을 표시한다.

## Phase 4 required tests

다음 15개 테스트를 `tests/dashboard.test.ts`에 구현했다.

1. Dashboard load
2. Project list
3. Project detail
4. Task list
5. realtime state update over SSE
6. Git change rendering data
7. validation result rendering data
8. Codex state rendering data
9. checkpoint rendering data
10. approval state
11. browser refresh state persistence
12. backend disconnected state
13. DB empty state
14. error state
15. unsupported capability display

## Regression / QA result on functional code commit

GitHub Actions Run #29 (`35733433727`) 결과:

- `npm ci`: PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm test`: PASS — 37 tests, 37 passed, 0 failed
- Phase 4 tests: PASS — 15/15
- Phase 1~3 regression: PASS — 기존 22/22
- `npm run build`: PASS
- `npm audit --audit-level=high`: PASS — 0 vulnerabilities

최종 QA 후보에서는 위 체인에 Git whitespace 검사를 추가한다. PR에서는 base SHA와 HEAD 전체 차이에 `git diff --check`를 실행하고, push에서는 직전 commit과 HEAD 차이를 검사한다. 최종 후보 커밋은 별도의 GitHub Actions PASS 후에만 Phase 4 VERIFIED로 판정한다.

## Accessibility

- keyboard focus-visible
- semantic `nav`, `main`, `header`, `table`, `label`
- button disabled state와 이유
- status text + 색상 보조
- loading / empty / disconnected / error 상태
- alert role
- 명시적 form label

## Known Limitations

- Core schema에 role/priority/dependency/current phase 전용 필드가 없어 Dashboard는 임의 값을 만들지 않고 기록 없음으로 표시한다.
- Phase 4는 Validation runner 자체를 새로 만들지 않는다. 로컬 Dashboard의 Validation 화면은 SQLite에 저장된 Handoff verification 결과를 읽는다.
- npm audit, git diff --check, 독립 integration-test 결과는 현재 Core DB에 저장되지 않으므로 로컬 화면에서 임의로 PASS로 표시하지 않는다.
- active Run을 강제로 pause하는 안전 primitive는 기존 Core에 없으므로 해당 상황에서 Pause는 BLOCKED다.
- Checkpoint 자체에는 validation result가 결합 저장되지 않는다.
- MCP 자동 탐색/설치/수정은 Phase 6 범위이며 Phase 4에서는 `UNSUPPORTED` foundation 상태만 제공한다.
- Codex authentication/availability는 사용자가 명시적으로 상태 확인을 실행할 때 실제 Provider를 호출한다.
- Fastify API는 loopback 전용이며 별도 사용자 인증을 추가하지 않았다.
- Phase 5 AI Company Organization 기능은 구현하지 않았다.

## Main status

`main`은 Phase 4 작업에서 수정하거나 merge하지 않는다. 전체 최종 QA가 PASS한 뒤에도 이번 단계에서는 main 반영 가능 여부만 보고한다.
