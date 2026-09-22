# AI Company Bridge — Phase 0 Foundation Feasibility Test

검증일: 2026-09-22 (Asia/Seoul)
사전 환경 점검: [BOOTSTRAP_REPORT.md](./BOOTSTRAP_REPORT.md)
실행 증거: [FEASIBILITY_EVIDENCE.json](./FEASIBILITY_EVIDENCE.json)
재현 스크립트: [phase0_probe.mjs](../tools/phase0_probe.mjs), [phase0_mcp_probe.mjs](../tools/phase0_mcp_probe.mjs)

## 최종 판정

**FOUNDATION_VERIFIED = YES**

요청한 Phase 0 핵심 항목을 현재 PC의 Codex CLI 0.149.0과 ChatGPT Plus 로그인으로 실제 호출해 모두 PASS했다. 이 판정은 **Codex App Server를 로컬 Bridge의 실행 후보로 사용할 수 있다는 실현성 확인**이다. 장기 안정성, 사용량 소진 상황, 여러 동시 실행, Phase 1의 Git/SQLite 상태 엔진은 아직 검증하지 않았다. Phase 1 구현은 이 작업에서 시작하지 않았다.

App Server는 설치된 CLI에서 `experimental`로 표시된다. 따라서 호출 형식과 이벤트 스키마를 버전별로 확인하고, 이후 Bridge의 Source of Truth는 프로젝트 로컬 Repository + Git + SQLite로 유지해야 한다. Codex thread 기록만으로 프로젝트 상태를 복구하는 설계는 채택하지 않는다. [공식 App Server 문서](https://developers.openai.com/codex/app-server).

## 검증 환경과 비용 경계

- Windows 11, Node.js v24.19.0, `codex-cli 0.149.0`; `account/read` 결과 `chatgpt` / `plus`.
- 테스트 workspace: [tests/phase0_workspace](../tests/phase0_workspace). 이곳의 `message.txt`, `package.json`, `build.mjs`, `probe.test.mjs`, `build-output.txt`만 테스트용으로 사용했다.
- App Server는 `codex.js app-server --stdio`로 실행했고, `gemini`, `apify`, `mobbin`, `upbit`, `local_comfyui` MCP를 **이번 프로브 실행에만 비활성화**했다. 전역 설정을 변경하지 않았다.
- OpenAI API 키나 다른 과금 API를 사용하지 않았다. npm 패키지 설치, OAuth, 유료 MCP, 클라우드 사용은 0건이다.
- 계정 식별자와 인증 토큰, 원시 계정 응답은 증거 파일에 저장하지 않았다.

## 항목별 결과

| 검증 항목 | 판정 | 실제 실행 근거 |
| --- | --- | --- |
| Codex App Server 실행 | PASS | 별도 프로세스 시작, 첫 PID `32396`; stdio 응답 수신 |
| `initialize` / `initialized` | PASS | `initialize` 응답에 `userAgent`, `codexHome`, `platformFamily`, `platformOs`; 이어 `initialized` 전송 후 후속 RPC 정상 |
| account / auth 상태 | PASS | `account/read` (`refreshToken:false`) → `chatgpt`, `plus`; 값·토큰 미기록 |
| `model/list` 및 reasoning effort | PASS | 4개 모델 반환; 테스트 모델 `gpt-5.6-luna`에 `low`, `medium`, `high`, `xhigh`, `max` 표시. 실제 turn에 `effort:low` 사용 |
| `thread/start` | PASS | 영속 thread ID `01a0c8a7-45fe-7941-a590-735b045cf71f` 반환 |
| `turn/start` | PASS | turn ID 반환, 최종 `completed` 통지 수신 |
| streaming event | PASS | `turn/started`, `item/started`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `turn/diff/updated`, `turn/completed` 등 수신 |
| `thread/read` | PASS | `includeTurns:true`로 저장된 완료 turn 1개 재조회 |
| `thread/resume` | PASS | 재시작 후 같은 thread ID로 resume 성공 |
| interrupt | PASS | 두 번째 turn의 `turn/started` 직후 `turn/interrupt`; 최종 `turn/completed.status=interrupted` 수신 |
| 테스트 workspace 파일 읽기 | PASS | `command/exec`의 읽기 전용 sandbox에서 `message.txt`의 시작·수정 마커를 반환 |
| 테스트 workspace 파일 수정 | PASS | Codex turn이 `message.txt`에 `verified-by-codex` 추가; 기존 `phase0-seed` 보존, diff 이벤트 관찰 |
| 안전한 command 실행 | PASS | `command/exec`, `readOnly` sandbox에서 Node 명령 exit 0, `phase0-safe-command-ok` 출력 |
| build/test | PASS | App Server `command/exec`로 의존성 없는 `npm.cmd run build` / `npm.cmd test` 모두 exit 0. 독립 재실행에서 테스트 1 PASS, 0 FAIL; 빌드 산출물에 수정 마커 포함 |
| Codex 프로세스 재시작 후 복구 | PASS | PID `32396` 종료 후 새 PID `29820`; 새 프로세스에서 기존 thread/read 1 turn 확인 및 thread/resume 성공 |
| Skills discovery | PASS | `skills/list` + `forceReload:true`에서 테스트 실행 당시 284개, 오류 0개; 이후 별도 프로세스에서는 122개, 오류 0개. 세부 한계는 아래 참조 |
| MCP capability | PASS | `mcpServerStatus/list`가 10개 등록 항목을 반환. 무료 로컬 `node_repl`의 `js`를 `mcpServer/tool/call`로 직접 호출해 `phase0-mcp-ok` 수신 |
| usage / rate-limit 지원 | PASS | `account/rateLimits/read`에서 `codex` 창과 사용률 반환; `account/usage/read`에서 활동 요약 필드와 일별 버킷 반환. 읽기만 수행 |

세부 상태와 이벤트 이름은 [FEASIBILITY_EVIDENCE.json](./FEASIBILITY_EVIDENCE.json)에 저장했다. `npm test`의 실제 독립 재실행 결과는 **1 pass / 0 fail**이었다. App Server의 `command/exec`·thread·streaming·Skills·MCP·rate limit 방법은 [공식 프로토콜 문서](https://developers.openai.com/codex/app-server)에 설명되어 있다.

재현 순서: 프로젝트 루트에서 `node tools/phase0_probe.mjs` 실행 후 `node tools/phase0_mcp_probe.mjs --call --usage --file-read --skills` 실행. 첫 스크립트는 테스트 파일을 초기화하고 새 thread를 만들므로 기존 스냅샷을 덮어쓴다. 두 번째 스크립트가 무료 로컬 MCP 호출, 활동 요약, 파일 읽기와 Skill 스냅샷을 증거에 추가한다.

## 관찰된 호환성·한계

1. 문서 예시의 `sandbox: "workspaceWrite"`는 현재 CLI의 `thread/start`에서 거부되었다. 오류는 `workspace-write`를 요구했다. 설치 버전이 반환한 허용 값으로 수정한 뒤 `thread/start`와 파일 수정이 통과했다. Phase 1에서는 설치된 버전의 스키마에 맞춰 직렬화하고 프로토콜 오류를 명시적으로 처리해야 한다.
2. 첫 interrupt 시도는 `turn/start` 응답을 기다린 뒤 요청해 `no active turn to interrupt`가 발생했다. `turn/started` 이벤트를 받은 즉시 중단 요청하도록 변경했고 실제 `interrupted` 종료를 확인했다. 완료/중단 경쟁 상태를 Bridge가 처리해야 한다.
3. `skills/list`는 성공한 전체 프로브에서 284개를 반환했지만 별도 App Server 프로세스의 재조회에서는 122개였다. 로컬 Skill 파일 287개를 세었던 [Phase -1 인벤토리](./BOOTSTRAP_SKILL_INVENTORY.csv)와도 다르다. 차이는 주로 원격 curated plugin Skill의 로드 여부다. **기본 로컬 Skill 발견 기능은 PASS**, 전체 플러그인 Skill 목록이 항상 동일하다는 보장은 없다. Phase 6의 Capability Registry는 각 실행에서 실제 반환된 목록과 오류를 저장해야 한다. [별도 122개 응답 스냅샷](./FEASIBILITY_SKILLS.json).
4. `mcpServerStatus/list`의 `authStatus=unsupported`는 `node_repl`의 OAuth가 필요 없다는 표기가 아니라 해당 stdio 서버에서 OAuth 상태를 제공하지 않는다는 의미다. 도구 호출은 별도로 성공했다. 유료·인증형 MCP는 사용하지 않았다.
5. rate limit 사용률은 조회 시점 값이며 빠르게 변한다. 이 프로브에서 `codex` 기본 창 사용률 23%, 보조 창 82%, `rateLimitReachedType=null`이었다. **한도 소진을 강제로 만들어 확인하지 않았으므로** 소진 시 정확한 오류 형태나 자동 전환 시점은 아직 보증하지 않는다.
6. 복구 검증은 완료된 turn 이후 프로세스를 재시작한 경우다. 진행 중 프로세스 강제 종료와 파일 작업 중 장애는 이 단계에서 테스트하지 않았다. Phase 2/3/8의 checkpoint/recovery 설계가 여전히 필요하다.

## Phase 1 진입 조건

위 표의 요청된 핵심 항목은 모두 PASS했다. 따라서 Phase 1 착수 가능하다. 다음 단계에서는 먼저 Git 저장소·SQLite를 독립적인 Source of Truth로 만들고, App Server의 thread ID·이벤트는 복구에 필요한 참조 데이터로만 저장한다. 이 Phase 0 작업에서는 Git 초기화, React/Fastify 설치, Core 구현 또는 `core-verified` 커밋을 수행하지 않았다.
