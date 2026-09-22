# AI COMPANY BRIDGE — MASTER PROJECT CONTEXT

이 문서는 앞으로 진행할 모든 개발 Phase의 최상위 프로젝트 컨텍스트다.
이 목표와 원칙을 임의로 변경하지 마라.

==================================================
1. 프로젝트의 최종 목적
==================================================

Windows 로컬 PC에서 동작하는
"AI Company Bridge"를 만든다.

이 프로그램의 핵심 목적은:

GPT-5.6 Sol High가 잘하는 업무는 최대한 GPT High에서 처리하고,
Codex는 Codex의 강점이 실제로 필요한 순간에만 사용하여
Codex 사용량을 최대한 절약하는 것이다.

추가 유료 API 비용은 0원이어야 한다.

==================================================
2. 기본 업무 흐름
==================================================

사용자
↓
ChatGPT GPT-5.6 Sol High
↓
기획
요구사항 분석
아키텍처
파이프라인 설계
UI/UX
디자인
코드 설계
코드 작성
복잡한 분석
리뷰
QA 판단
↓
로컬 실행 또는 Codex 전문 작업이 필요한지 판단
↓
필요하지 않음
→ GPT High에서 계속

필요함
→ Handoff Core
→ AI Company Bridge
→ Codex
→ 로컬 파일 수정
→ Repository 작업
→ Terminal
→ Git
→ Build
→ Test
→ Debug
↓
결과 / Git Diff / Test / Build 상태 저장
↓
다시 GPT High 검토

==================================================
3. Codex 사용량 소진 시
==================================================

Codex 사용량이 부족하거나 사용 불가능해져도
프로젝트 전체를 실패 처리하지 않는다.

Codex
↓
중단 감지
↓
자동 Checkpoint

저장:

현재 Objective
완료된 업무
남은 업무
Decisions
Git HEAD
Git Diff
Changed Files
Build 결과
Test 결과
Error
Codex Thread ID

↓
HIGH_READY
↓
GPT High용 Handoff Bundle 자동 생성
↓
사용자가 ChatGPT High에서 작업을 이어감
↓
High가:

설계
분석
코드 작성
Patch 작성
디버깅 판단
디자인
리뷰

등 가능한 작업을 계속 수행
↓
Codex가 필요한 실행 업무는 Queue에 저장
↓
Codex 사용 가능 상태 복구
↓
Repository 상태 검증
↓
기존 Thread Resume 또는 안전한 새 Thread
↓
Codex 작업 계속

==================================================
4. Handoff Core
==================================================

이 프로젝트의 핵심 모듈이다.

GPT High와 Codex가 서로 다른 환경에서 작업하더라도
프로젝트 상태를 잃지 않도록 한다.

Source of Truth는:

Local Repository
+
Git
+
AI Company Database

이다.

ChatGPT 대화 기록이나 Codex 채팅 기록을
Source of Truth로 사용하지 않는다.

Handoff Core는 최소한 다음을 관리한다:

Objective
Context
Decisions
Completed Tasks
Remaining Tasks
Git Diff
Changed Files
Tests
Build
Errors
Artifacts
Codex Tasks
Checkpoint

==================================================
5. AI Company Bridge 역할
==================================================

AI Company Bridge는 단순 Dashboard가 아니다.

내부적으로:

Project Manager
Workflow Engine
Handoff Core
Codex Router
Execution Provider
Git Manager
Patch Manager
Checkpoint Manager
Recovery Manager
Capability Registry
Skill Manager
MCP Manager
QA
Security
Audit Log

등을 담당하는 로컬 프로그램이다.

==================================================
6. Web Dashboard 역할
==================================================

Web Dashboard는 관제실이다.

실제 시스템 상태를 보여준다.

표시:

현재 프로젝트
현재 Objective
현재 Task
누가/무엇이 작업 중인지
GPT High Handoff 상태
Codex 상태
Codex 작업
변경 파일
Git Diff
Build
Tests
Errors
Checkpoint
Skills
MCP
Approval
작업 기록

가짜 Agent 대화나 가짜 진행률은 만들지 않는다.

==================================================
7. AI 회사 구조
==================================================

논리적 역할:

Executive PD
Planning
Research
Design Director
UI/UX
Visual Design
Engineering Director
Coding
Code Review
QA
Security
Release

그러나 역할 하나당 항상 별도 모델을 실행하지 않는다.

필요한 역할만 활성화하여 사용량을 절약한다.

기본 Pipeline:

사용자 요청
→ Executive PD
→ 업무 분해
→ 필요한 팀만 활성화
→ 구현
→ deterministic validation
→ independent review
→ QA
→ PD Acceptance
→ 사용자 보고

==================================================
8. Capability / Skill / MCP
==================================================

업무 수행에 필요한 기능이 없을 경우:

현재 기능 검사
→ 기존 도구 재사용
→ 무료 Skill 검색
→ 무료 MCP 검토
→ 무료 오픈소스 검토
→ 필요하면 내부 Tool/Skill 제작
→ 보안 검사
→ 설치
→ Smoke Test
→ Capability Registry 등록
→ 실제 업무 사용

단 유료 도구는 사용하지 않는다.

==================================================
9. ZERO COST 절대 정책
==================================================

추가 개발 비용 = 0원

금지:

OpenAI 유료 API
OPENAI_API_KEY 기반 과금
Anthropic API
Gemini API
기타 유료 LLM API
유료 MCP
유료 Plugin
유료 SaaS
Cloud/VPS
AWS/Azure/GCP 유료 리소스
사용량 기반 과금 서비스

허용:

현재 ChatGPT Plus
현재 포함된 Codex 권한
로컬 PC
무료 오픈소스
무료 Skill
무료 MCP
무료 npm package
Git
SQLite
localhost

유료 기능이 필요하면:

BLOCKED_BY_COST

처리하고 무료 대안을 찾는다.

==================================================
10. 중요한 기술적 제약
==================================================

일반 ChatGPT Plus의 GPT-5.6 Sol High를
로컬 프로그램에서 일반 API처럼 자동 호출한다고 가정하지 않는다.

따라서 GPT High 연결은 Provider 구조로 만든다.

최소 보장 방식:

ManualHandoffProvider

향후 공식 기능이 생기면:

McpHandoffProvider
FutureOfficialProvider

등을 추가 가능하도록 한다.

현재 검증되지 않은 방법을 핵심 dependency로 만들지 않는다.

==================================================
11. 개발 전략
==================================================

전체 프로그램을 한 번에 생성하지 않는다.

순서:

Phase -1
개발환경 / Skill / MCP / 무료 도구 준비

Phase 0
Codex 핵심 기능 실현성 검증

Phase 1
Core / SQLite / Git

Phase 2
Handoff Core

Phase 3
Codex Execution Provider + Recovery

Phase 4
Web Dashboard

Phase 5
AI Company Organization / PD

Phase 6
Capability / Skill / MCP Manager

Phase 7
Parallel Agent / Git Worktree

Phase 8
Security / Recovery / QA

Phase 9
Windows Packaging

Final
Release Audit

각 Phase가 실제 테스트 PASS하기 전
다음 Phase로 넘어가지 않는다.

==================================================
12. 최종 사용자 경험
==================================================

최종적으로 사용자는 복잡한 개발 명령을 몰라도 된다.

AI Company 실행
↓
관제실 확인
↓
GPT High 중심으로 프로젝트 진행
↓
필요할 때 Codex 사용
↓
Codex 사용량 부족 시 Handoff 생성
↓
GPT High에서 계속 작업
↓
Codex 복구 후 이어서 실행
↓
QA
↓
최종 결과

이 구조가 프로젝트 전체의 최상위 목표다.

이 내용을 PROJECT_MASTER_CONTEXT.md로 저장하라.

이후 모든 Phase에서 이 문서를 먼저 읽고
프로젝트 목표와 구현이 일치하는지 확인하라.

아직 본 개발은 시작하지 마라.

PROJECT_MASTER_CONTEXT.md 저장이 완료되면
MASTER_CONTEXT_READY라고 보고하라.