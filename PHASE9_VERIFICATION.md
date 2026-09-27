# Phase 9 — Windows Packaging verification

Baseline: `71cb7542dcf5cd7859577490aeac31cd4314937e`.
Scope and acceptance criteria: [PHASE9_PLAN.md](./PHASE9_PLAN.md).

## Implemented

- Portable, unsigned Windows x64 ZIP with included Node/npm and locked production
  dependencies. Git remains a checked prerequisite; no new runtime dependencies.
- Same-origin production dashboard/API on loopback, without Vite at runtime.
- User data outside package, exclusive SQLite lifetime lock, crash-released
  ownership, startup recovery reuse and authenticated stop/status identity.
- Start/Stop launchers, logs, bounded readiness checks, active-work stop refusal,
  side-by-side upgrade/rollback instructions and explicit data-preserving removal.
- Allowlisted build inputs, no source maps/private state, full file inventory and
  SHA-256 validation before startup; ZIP digest and source commit provenance.
- Windows/Linux QA matrix; pinned actions/read-only token; Windows artifact smoke
  and upload happen only after the complete gate passes.

## Evidence ledger

The original 198 regressions are retained, with 13 packaging tests (211 total).
Tests cover production HTML/assets, inaccessible private/traversal/linked paths,
exclusive ownership, forced-process lock release, duplicate startup with an active
Run, persistent restart, token rotation/authorization, invalid runtime records,
data path containment, startup-failure cleanup and package inventory/hash failures.

The final local and CI results are recorded after execution below and in the PR
delivery comments. A dirty build is explicitly marked `dirty: true` and is only
for pre-commit validation; the delivered archive must come from a clean exact SHA.

One pre-commit packaging attempt correctly failed its content gate because npm
installed dependency source maps. The builder now removes only those generated
regular `.map` files inside its new staging directory before the final inventory.

The extracted-package smoke then caught a Windows PowerShell 5.1 encoding defect:
UTF-8 JSON from Node was decoded using the legacy console code page, corrupting
Korean data-directory names before log redirection. The launcher explicitly uses
UTF-8 for native process output. The Unicode-path smoke is retained as a release
gate; this failure was not recorded as PASS.

The next smoke confirmed successful startup, but its captured Windows child pipes
remained open through the background server after PowerShell had exited with code
0. The smoke driver now ignores launcher stdio and checks real readiness through
HTTP/log files, and cleans up its own runtime even when launch throws. The leftover
test server was stopped through the authenticated shutdown endpoint, not a broad
process kill. This timeout was also treated as FAIL.

## Local pre-commit evidence (2026-09-27)

- Windows x64, Node 24.19.0, npm 11.17.0.
- Typecheck, lint, complete tests (211/211, zero fail/cancelled/skipped/todo),
  server/web build, npm audit (0 vulnerabilities), script syntax and Git whitespace
  checks passed. The final checks are rerun before the implementation commit.
- New-staging-tree package build, full ZIP extraction and inventory verification
  passed. Pre-commit ZIP digest:
  `6d2884a186efdedc0b0bed2d5a6a6226eb798342aca933b1d91d37ec4ef43319`.
- Extracted ZIP smoke PASS: Unicode/space/special-character path, bundled runtime,
  production HTML/JS, actual project write, repeated Start, graceful Stop,
  restart retaining the project and unchanged package hashes. The generated
  machine-readable ledger is `dist/releases/windows-smoke.json`.
- This pre-commit ZIP is marked dirty and is not the final delivery artifact.
  Clean commit/main artifacts and their checksums/CI IDs are identified in the PR
  evidence and final report. Browser inspection follows the implementation commit.

## Boundaries / recovery

No application schema change, paid signing, paid API, service/registry/startup
installation, administrator execution, automatic update or production deployment.
No installer or signed publisher identity is claimed. SmartScreen reputation is
NOT CHECKED. The final cross-phase Release Audit is separate from Phase 9.

Stop the app before backup and preserve all files under the data directory.
Removing the extracted package does not remove data. Keep the old package for
rollback; do not downgrade an incompatible future schema. Never delete an instance
lock to override another process. Do not share the portable data directory with
the legacy developer server or a network/cloud-synced filesystem.

No OS sandbox or protection from a fully compromised local account is claimed.
The existing Phase 8 CI timeout remains recorded in PR #8; no assertion is made
that Phase 9 fixes that unproven intermittent cause.
