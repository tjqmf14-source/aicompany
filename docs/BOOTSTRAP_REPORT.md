# AI Company Bridge — Phase -1 Zero-Cost Bootstrap Report

검사일: 2026-09-22 (Asia/Seoul)
범위: 개발 도구·Skill·MCP·비용 및 Phase 0 진입 준비. 본 개발과 Phase 0 실현성 검증은 수행하지 않았다.
기준 문서: [PROJECT_MASTER_CONTEXT.md](../PROJECT_MASTER_CONTEXT.md)

## 판정

**BOOTSTRAP_READY = YES** — 현재 PC와 무료 로컬 도구만으로 **다음 단계인 Phase 0 실현성 검증을 시작할 준비**가 되었다. 이 판정은 Codex 자동 실행, 재개, 사용량 감지 또는 완성된 Bridge의 동작을 뜻하지 않는다. 그 기능은 Phase 0에서 별도로 검증해야 한다.

추가 과금 서비스, API 키, 클라우드, 외부 실행 파일, 관리자 권한, 전역 패키지, OAuth를 이 단계에서 사용하거나 설치하지 않았다. 새 설치 **0건**, 추가 비용 **0원**. 프로젝트 로컬 npm 의존성은 아직 필요하지 않아 설치하지 않았다.

## 1. 실제 PC 환경

상태 용어: `INSTALLED`는 명령 실행 또는 로컬 로드 확인, `MISSING`은 해당 위치에 없음, `BROKEN`은 호출 실패, `AUTH_REQUIRED`는 승인 또는 인증 필요, `UNSUPPORTED`는 이 단계의 승인된 방식으로 사용할 수 없음을 뜻한다.

| 항목 | 상태 | 실제 확인 결과 |
| --- | --- | --- |
| Windows | INSTALLED | Windows 11 Home, 64비트, OS 버전 10.0.26200; `Win32_OperatingSystem` 확인 |
| PowerShell | INSTALLED | PowerShell 7.6.5. 사용자/로컬 머신 실행 정책 `RemoteSigned` |
| Git | INSTALLED | 2.55.0.windows.5; `git --version`, `git diff --no-index`, `git apply -h` 확인 |
| Node.js | INSTALLED | v24.19.0; `node:fs`, `node:http`, `node:child_process`, `node:sqlite` 로드 확인 |
| npm | INSTALLED | 11.17.0; `npm.cmd --version` 확인 |
| pnpm | INSTALLED | 11.19.0; Codex 번들 런타임의 `pnpm.cmd`에서 실행됨. 프로젝트 기본 패키지 관리자는 더 안정적인 설치 경로의 npm으로 정함 |
| Corepack | INSTALLED | 0.35.0; 버전 확인 |
| Codex CLI | INSTALLED | `codex-cli 0.149.0`; `codex.cmd --help`, `mcp --help`, `plugin list` 확인 |
| Codex 로그인 | INSTALLED | `codex.cmd login status` → `Logged in using ChatGPT`. 유료 API 키 로그인을 사용하지 않음. 실제 작업 실행 권한과 한도는 Phase 0에서 확인 |
| Codex 설정 | INSTALLED | 사용자 설정: `model=gpt-5.6-sol`, `model_reasoning_effort=high`, `service_tier=default`, `js_repl=false`, `memories=true`, Windows `sandbox=elevated`. 이 프로젝트 경로의 trust 항목도 존재함. 비밀 값은 기록하지 않음 |
| Codex Skills | INSTALLED | 현재 세션에 제공된 Skills 목록과 로컬 `SKILL.md`를 조사. 고유 경로 287개. 독립 App Server의 실제 발견 수는 Phase 0에서 122~284개로 변동함; [FEASIBILITY_REPORT.md](./FEASIBILITY_REPORT.md) 참조 |
| MCP | INSTALLED / BROKEN 혼재 | CLI 등록 상태와 이 세션의 실제 도구 노출을 따로 확인. 아래 표 참조 |
| WinGet | INSTALLED | v1.29.290; 사용하지 않음 |
| GitHub CLI | INSTALLED | `gh.exe` 발견. GitHub 인증은 검사하지 않음; 통합 시 사용자 승인 필요 |
| Scoop / Chocolatey | MISSING | 명령 없음. 설치 필요 없음 |
| 프로젝트 Git 저장소 | MISSING | `D:\AI_company`는 아직 Git 저장소가 아님. Phase 1의 Git 구축 범위로 남김 |
| 프로젝트 로컬 TypeScript/React/Vite/ESLint | MISSING | `package.json`·`node_modules`가 없음. Phase 0에는 불필요하며 해당 구현 Phase에서 버전을 고정해 설치 예정 |

PowerShell에서 `npm.ps1`, `codex.ps1` 대신 검증된 `npm.cmd`, `codex.cmd` 호출 경로를 사용할 수 있다. 환경 변수의 API 키 **값**은 조회·출력하지 않았다. 현재 프로세스에는 `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`가 설정되지 않은 것으로 확인했다. 이것은 사용자 설정 파일이나 다른 프로세스까지 비밀이 없다는 뜻은 아니다.

## 2. 최소 Capability와 구현 경로

| Capability | Phase -1 결과 | 최소 비용 경로 / 검증 경계 |
| --- | --- | --- |
| TypeScript | MISSING (프로젝트 로컬) | Phase 1에서 무료 Apache-2.0 `typescript`를 프로젝트 로컬 dev dependency로 설치. Node의 TypeScript 실행만으로는 typecheck가 되지 않음 |
| Node.js backend | INSTALLED | Node 24의 `node:http`, `node:fs`, `node:child_process` 우선 사용 |
| React / Vite | MISSING (프로젝트 로컬) | Phase 4에서 무료 MIT React·Vite를 프로젝트 로컬로 설치. 현재 Node 24.19.0은 Vite 문서의 최소 Node 요구를 충족 |
| SQLite | INSTALLED | Node 24 `node:sqlite`의 메모리 DB 생성·INSERT·SELECT 스모크 통과. 이 API는 Node 24 문서에서 release candidate이므로 Phase 1에서 영속성·백업·호환성을 재평가 |
| Git / diff / patch | INSTALLED | 기존 Git CLI 재사용. 실제 저장소의 변경·적용·충돌 처리는 Phase 0/1 검증 대상 |
| Testing | INSTALLED | 내장 `node:test` 스모크 1건 PASS. UI/통합 테스트가 필요해질 때만 추가 도구 검토 |
| Lint | MISSING (프로젝트 로컬) | Phase 1 구현 코드가 생길 때 무료 MIT ESLint 설치 후보 |
| Typecheck | MISSING (프로젝트 로컬) | `tsc --noEmit` 후보. Vite는 TypeScript를 변환하지만 typecheck는 수행하지 않음 |
| Build | MISSING (프로젝트 로컬) | 백엔드는 TypeScript 구성 선택 후, 프런트엔드는 Phase 4 Vite 빌드로 검증 |
| WebSocket 또는 SSE | INSTALLED (기초 기능) | 별도 서버 패키지 없이 `node:http`를 이용한 SSE 우선 검토. 실제 스트림 구현은 Phase 4 |
| Codex integration | INSTALLED (CLI 및 로그인) | `codex.cmd exec/resume/agents` 등의 CLI 도움말 확인. 프로그래밍 방식 실행·재개·중단 감지는 **Phase 0 미검증** |
| Local process execution | INSTALLED (기초 기능) | Node `child_process` 로드 확인. 안전한 인수 전달·허용 명령·종료 처리는 구현 전 검증 필요 |
| Checkpoint / recovery | 설계 경로 확보 | SQLite + Git + 로컬 파일의 원자적 기록을 직접 설계. 동작은 Phase 2/3/8에서 검증 |
| Path / security validation | 설계 경로 확보 | Node `path`·`fs` 및 Git 작업 루트 검증을 내부 코드로 구현. 우회/심볼릭 링크 사례는 구현 후 테스트 |

내장 SQLite와 테스트 스모크가 통과해도 영속성, 동시성, 손상 복구 또는 실제 Bridge 동작이 증명된 것은 아니다. [Node SQLite 문서](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html), [Node 테스트 문서](https://nodejs.org/api/test.html), [Vite의 TypeScript/typecheck 설명](https://vite.dev/guide/features), [Vite Node 요구 사항](https://vite.dev/guide/)을 근거로 사용했다.

### 선택 Capability

| 항목 | 결정 |
| --- | --- |
| UI/UX Skill | 기존 `frontend-ui`, `visual-qa`, `design-system` 등 재사용. 새 Skill 설치 안 함 |
| GitHub integration | 로컬 Git으로 우선 진행. `gh`는 설치되어 있으나 OAuth/원격 저장소는 현재 불필요 |
| MCP | Bridge의 필수 의존성으로 채택하지 않음. Codex CLI와 수동 Handoff가 기본 경로 |
| Browser testing | Dashboard가 생기는 Phase 4에서 기존 브라우저 제어 Skill/도구 우선 검토. `playwright-interactive`의 `js_repl` 선행 조건은 현재 `false`라 바로 실행할 수 없음 |
| Windows packaging | Phase 9에서 실제 배포 요구와 크기를 확인한 후 무료 도구 선택 |

## 3. 재사용과 새 설치 판단

검토 순서는 **기존 설치 → Codex 기본 기능 → 무료 오픈소스 → 작은 내부 구현**으로 적용했다.

| 후보 | 비용 | 처리 | 이유·출처 |
| --- | --- | --- | --- |
| 기존 Windows/PowerShell/Git/Node/npm/Codex CLI | FREE (기존 권한) | 재사용 | 현재 PC에서 버전과 기본 명령 확인 |
| Node 내장 SQLite/test/http/fs/child_process | FREE | 재사용 | SQLite·test 스모크 완료, HTTP·파일·프로세스 모듈 로드 완료 |
| TypeScript | FREE | Phase 1까지 설치 보류 | [공식 저장소 package.json: Apache-2.0](https://github.com/microsoft/TypeScript/blob/main/package.json); 구현 시작 시 버전 고정 |
| React | FREE | Phase 4까지 설치 보류 | [공식 패키지: MIT](https://github.com/facebook/react/blob/main/packages/react/package.json) |
| Vite | FREE | Phase 4까지 설치 보류 | [공식 라이선스: MIT](https://github.com/vitejs/vite/blob/main/packages/vite/LICENSE.md) |
| ESLint | FREE | Phase 1까지 설치 보류 | [공식 패키지: MIT](https://github.com/eslint/eslint/blob/main/package.json) |
| Vitest | FREE | 채택 보류 | [공식 저장소: MIT](https://github.com/vitest-dev/vitest); 초기 백엔드 테스트는 `node:test`로 가능 |
| 외부 SQLite 바인딩·WebSocket 라이브러리 | UNCLEAR (구체 패키지 미선정) | 자동 설치 제외 | 내장 기능으로 시작하고 실제 성능/기능 부족이 확인될 때 라이선스·유지보수 평가 |

**새 설치 목록: 없음.** 따라서 새 설치 도구의 버전·로드·호출·스모크는 해당 없음. 향후 프로젝트 로컬 패키지를 추가할 때는 그 시점의 패키지 버전·라이선스·lockfile·실제 빌드 결과를 기록한다. 관리자 권한, 전역 패키지, 외부 exe, OAuth, API 키, 시스템 설정, workspace 밖 쓰기는 수행하지 않았다.

## 4. Skill 전수 조사

[BOOTSTRAP_SKILL_INVENTORY.csv](./BOOTSTRAP_SKILL_INVENTORY.csv)에 **287개 Skill 각각의** `name`, 절대 `path`, `description`, `enabled`, 선언된 `dependency`, `required_mcp`, `required_env`, 프로젝트 분류를 기록했다. `chrome/latest`는 활성 버전과 같은 캐시 별칭이라 중복에서 제외했다.

| 분류 | 수 | 판단 |
| --- | ---: | --- |
| REQUIRED | 0 | 이 프로젝트의 런타임에 특정 Skill을 강제할 필요가 없음 |
| RECOMMENDED | 17 | 아키텍처, 백엔드, 데이터, 테스트, 검증, 보안, UI 구현 등의 기존 지침 |
| OPTIONAL | 17 | 브라우저 검증, GitHub, 병렬 작업, Windows UI 등의 해당 Phase 선택지 |
| IRRELEVANT | 253 | 현재 프로젝트 범위에 직접 필요하지 않은 도메인/서비스 Skill |

`enabled=AVAILABLE_IN_SESSION_CATALOG`는 **이 세션에 제공된 Skills 목록과 파일 경로에서 발견됨**을 뜻하며, 자동 실행되거나 모든 외부 의존성이 갖춰졌다는 뜻은 아니다. `NOT_DECLARED`는 Skill 전면 메타데이터에 필수 패키지/MCP/환경 변수가 명시되지 않았다는 뜻이며, 실제로 필요 없다는 보증이 아니다. 브라우저·Playwright·GitHub·WinUI 후보의 본문에 명시된 선행 조건은 CSV에 별도로 반영했다. CSV의 `mentions_mcp`, `mentions_env`는 본문 언급만 나타낸다. 특정 Skill을 실제 사용할 때 해당 `SKILL.md`의 전체 절차와 그 시점의 선행 조건을 다시 확인한다. 현재 필요한 무료 Skill은 이미 있어 새 Skill 설치가 필요 없다.

Phase 0에서 확인한 독립 `codex app-server`의 `skills/list` 결과는 실행별로 122개 또는 284개였다. 이 CSV는 로컬 파일과 현재 세션 카탈로그의 인벤토리이며 **App Server가 매번 287개를 노출한다는 증거가 아니다**. Bridge는 매 실행에서 실제 발견 결과를 사용해야 한다.

## 5. MCP 실제 상태

`codex.cmd mcp list`의 **등록/활성화 상태**와 현재 세션의 **도구 노출/리소스 호출**을 구분했다. `Auth=Unsupported`는 CLI가 그 stdio 서버에 OAuth 상태를 제공하지 않는다는 표시이며 서버의 성공을 뜻하지 않는다.

| Server | 상태 | 이 세션의 tools / resources / authentication / error | Bridge 채택 |
| --- | --- | --- | --- |
| `codex_app` | CLI에서는 disabled, 현재 Desktop 세션 도구는 INSTALLED | 이 세션에 35개 도구 노출; 리소스·별도 인증 미검사. Desktop 전용 기능이므로 Bridge의 안정적 외부 API로 가정하지 않음 | 필수 아님 |
| `node_repl` | INSTALLED | CLI enabled, 이 세션 도구 3개 노출, `resources/list` 성공(0개). 별도 사용자 인증 미요구; 개별 JS 호출은 미검사 | 불필요 |
| `local_comfyui` | BROKEN | CLI enabled이지만 이 세션 도구 노출 없음; `resources/list`가 MCP handshake 약 30초 timeout. 인증 미확인 | 무관, 제외 |
| `gemini` | UNSUPPORTED (이 프로젝트 정책) | CLI enabled, 도구 37개 노출; 전역 설정에 `GEMINI_API_KEY` 항목 있음. 값은 출력하지 않았고 API 호출 없음. 리소스 미검사 | API Key 기반 과금 금지로 제외 |
| `upbit` | UNSUPPORTED (무관/위험) | CLI enabled, 도구 19개 노출. 인증·리소스 미검사, 호출 없음 | 제외 |
| `apify` | AUTH_REQUIRED | CLI enabled, `Not logged in`; 이 세션에서 직접 도구 노출 확인 안 됨. 리소스 미검사 | 비용/계정 조건 불명확, 제외 |
| `mobbin` | AUTH_REQUIRED | CLI enabled, OAuth 표시; 이 세션 도구 3개 노출. 인증·리소스 미검사 | OAuth 승인·비용 조건 미확인, 제외 |
| `cua_repl` | UNSUPPORTED (현재 비활성) | CLI disabled; 이 세션 도구 노출 없음 | 불필요 |

`codex_apps` 커넥터 도구도 이 세션에 노출되지만 프로젝트의 로컬 실행 MCP 후보가 아니다. `local_comfyui` 오류는 이 Phase의 필수 기능에 영향을 주지 않아 재시작/재시도를 하지 않았다. **프로젝트에 새 MCP 설치·인증·호출 0건.**

## 6. 비용 차단과 다음 Gate

| 제외 후보 | 비용 판정 | 제외 이유 / 무료 경로 |
| --- | --- | --- |
| OpenAI 유료 API, `OPENAI_API_KEY` 호출 | PAID | 프로젝트의 절대 금지 대상. 기존 ChatGPT Plus/Codex 권한 및 `ManualHandoffProvider` 사용 |
| Anthropic·Gemini 등 API 키 기반 LLM | PAID 또는 사용량 기반 가능 | 절대 금지 대상. 로컬 분석과 수동 Handoff 사용 |
| Apify·Mobbin 및 인증형 외부 SaaS/MCP | UNCLEAR | 계정/OAuth 또는 요금 조건 확인 전 자동 사용 금지. 현재 프로젝트에는 필요 없음 |
| Cloud/VPS 및 유료 배포·DB | PAID | localhost, 로컬 Git, SQLite 사용 |
| 추가 유료 Plugin/Skill | PAID 또는 UNCLEAR | 설치하지 않음. 기존 세션 Skill 재사용 |

Phase 0에서 검증해야 할 별도 Gate: Codex CLI 비대화형 실행·재개, 작업 식별자, 중단/한도 오류의 식별 가능성, 로컬 변경·diff 수집, 인증 상태의 안전한 확인, 실패 시 수동 Handoff. 이 결과를 얻기 전에는 자동 복구나 사용량 감지를 보장하지 않는다.

## 검증 기록과 한계

- PASS: Windows/PowerShell, Git, Node/npm/pnpm/Corepack/Codex/WinGet의 버전 명령.
- PASS: `codex.cmd login status`의 ChatGPT 로그인 표시; `codex.cmd mcp list` 및 `plugin list` 조회.
- PASS: Node 내장 모듈 로드, `node:sqlite` 메모리 DB 쓰기/읽기, `node:test` 1건.
- PASS: Skill 파일 287개를 읽어 CSV 생성; 관련성 분류 17/17/253 및 중복 경로 제거 확인.
- FAIL (선택 MCP): `local_comfyui`의 MCP handshake timeout. 프로젝트 채택 대상이 아님.
- NOT RUN: 프로젝트 build/typecheck/lint/통합 테스트. 아직 구현 코드와 `package.json`이 없음.
- NOT RUN: Codex 실제 작업 실행·재개·한도 감지. Phase 0의 검증 범위.
- NOT CHECKED: GitHub OAuth, 외부 SaaS 인증/요금 계정, 설치된 모든 Skill의 본문별 실행 가능성. 현재 단계에 불필요하고 승인 경계를 넘지 않기 위함.
- 복구: 이 단계의 workspace 변경은 이 보고서와 Skill CSV뿐이다. 전역 도구/설정·인증·시스템 파일 변경은 없다.
