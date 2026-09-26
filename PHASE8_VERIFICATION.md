# Phase 8 Verification

Date: 2026-09-26
Branch: `feature/phase8-security-recovery-qa`
Baseline main: `cffc33b683413dd241754c2f25d4ce228bcfd6fd`
Verified functional HEAD: `3a9062f6c4eba2d2ffedd432e2f0a9c5b1731026`
GitHub Actions functional run: Run #90
Run ID: `36224493499`
Job ID: `108355756581`

## Scope

Phase 8 implements the Security / Recovery / QA hardening layer on top of the verified Phase 1-7 stack.

The goal is conservative release readiness: uncertain, interrupted, dirty, recovery-required, or security-failing states must remain visible and must not be silently treated as PASS.

## SQLite migration

Schema version: **8**

Phase 8 adds:

### `security_audits`

Durable records of:

- overall audit status
- individual deterministic security checks
- evidence summaries
- audit timestamp

### `qa_runs`

Durable records of:

- RUNNING / PASS / FAIL / INTERRUPTED state
- starting Git HEAD / branch
- fixed QA check results
- redacted output
- failure reason
- start / finish timestamps

Only one RUNNING QA record is permitted per project.

## Security audit

The local deterministic audit currently checks:

1. SQLite `PRAGMA quick_check`
2. SQLite foreign-key violations
3. readable Git HEAD
4. unfinished merge / rebase / cherry-pick / revert state
5. working-tree cleanliness
6. tracked high-risk secret/environment-file heuristics
7. unresolved Recovery blockers

A dirty working tree is recorded as WARN rather than silently PASS.

Tracked `.env` / non-example environment files, known private-key markers, and selected high-risk credential patterns are treated as FAIL. Evidence records file names rather than secret content.

The secret scan is intentionally bounded by file count and per-file size and is a deterministic heuristic, not a claim of exhaustive malware/secret detection.

## Recovery gate

Phase 8 aggregates unresolved recovery-required state from:

- Phase 2 Handoff
- Phase 3 Codex executions
- Phase 7 Parallel lanes
- active Phase 8 QA runs

These conditions block release readiness.

Historical Core Runs already converted to `interrupted` remain visible as history but do not by themselves block release readiness after provider-specific recovery state has been resolved.

### QA startup recovery

A persisted QA row left in RUNNING state after process termination is changed to INTERRUPTED during server startup.

This recovery runs once when Security routes are registered. Merely reading Dashboard/Security state does not interrupt an active QA run.

## Deterministic QA runner

Phase 8 persists six fixed checks:

1. `git diff --check HEAD --`
2. `npm run typecheck`
3. `npm run lint`
4. `npm test`
5. `npm run build`
6. `npm audit --audit-level=high`

A failure does not prevent later checks from running, so the stored QA row contains the complete diagnostic set when possible.

The runner also compares Git state before/after validation. If QA changes HEAD, branch, tracked diff, or porcelain change state, an additional FAIL is recorded rather than accepting a self-modifying validation run.

Output is bounded and credential-like tokens are redacted before persistence.

## Release readiness

`releaseReady = true` only when:

- latest QA status is PASS
- a later/equal Security Audit status is PASS
- there are no unresolved Recovery blockers

No audit/QA record means NOT READY.

WARN is not release-ready.

## Local HTTP hardening

The Fastify API now rejects non-loopback Host values.

Allowed hostnames:

- `localhost`
- `127.0.0.1`
- `::1`

The executable server already binds to `127.0.0.1`; Phase 8 adds application-level Host validation as defense in depth.

Responses include:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `X-Frame-Options: DENY`
- `Cache-Control: no-store`

This remains a localhost application and Phase 8 does not claim public-network authentication/TLS support.

## API / Dashboard

Security API:

- `GET /api/security/projects/:id`
- `POST /api/security/projects/:id/audit`
- `POST /api/security/projects/:id/qa`
- `GET /api/security/projects/:id/audits`
- `GET /api/security/projects/:id/qa-runs`

Dashboard aggregate state now contains persisted Security state.

COMMAND CENTER displays:

- Security Audit
- Release Ready
- Recovery blockers

Security/QA lifecycle also writes durable Core Event records.

## Phase 8 tests

`tests/security.test.ts` contains **33 Phase 8 tests** covering:

- schema v8 and v7→v8 migration
- clean audit PASS
- durable audit evidence
- dirty-tree WARN
- tracked `.env` rejection
- tracked private-key marker detection without secret-content disclosure
- allowed `.env.example`
- unfinished Git operation detection
- empty recovery state
- Handoff recovery blocker
- Codex recovery blocker
- Parallel recovery blocker
- historical interrupted Run handling
- QA six-check PASS
- QA check failure persistence
- validation-induced repository mutation detection
- one active QA per project
- startup QA interruption recovery
- read-only Security state behavior
- releaseReady ordering
- WARN audit release blocking
- durable Event logging
- Dashboard Security state
- Security audit API
- QA API
- non-loopback Host rejection
- localhost / IPv4 / IPv6 loopback acceptance
- hardening response headers
- missing-project response
- conservative initial NOT READY
- chronological audit evidence
- Dashboard security indicator rendering

The Phase 1-7 regression suite contains **144 tests**.

## Functional QA result

GitHub Actions Run #90 (`36224493499`) on `3a9062f6c4eba2d2ffedd432e2f0a9c5b1731026`:

- `npm ci`: PASS
- `git diff --check`: PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- Phase 8 tests: **33/33 PASS**
- Phase 1-7 regression: **144/144 PASS**
- `npm test`: **177/177 PASS**
- `npm run build`: PASS
- `npm audit --audit-level=high`: PASS — **0 vulnerabilities**

Earlier runs were not treated as PASS:

- Run #86 failed typecheck because a security-marker tuple could produce `string | undefined`; later steps were skipped.
- Run #87 passed typecheck but failed lint due to one unused import; tests/build/audit were skipped.
- Run #88 was the first full functional PASS before the final Dashboard security indicators/test were added.
- Run #90 is the verified final functional PASS for the Phase 8 implementation.

This documentation commit must pass the same GitHub Actions gate before merge.

## Security boundaries / non-claims

Phase 8 does **not** claim:

- exhaustive secret discovery
- malware/antivirus scanning
- operating-system sandboxing
- public-network authentication or TLS
- cryptographic signing of releases
- protection against a fully compromised local user/account
- automatic repair of unknown Git or filesystem corruption

Uncertain destructive recovery remains blocked for manual review.

Windows installer signing/packaging and release-file verification belong to Phase 9 / Final Release Audit.

## Main integration

Phase 8 was merged from verified branch HEAD `cbdd89f902b6738343a603abbee13c1f3e8e3189` into `main`.

- Previous main: `cffc33b683413dd241754c2f25d4ce228bcfd6fd`
- PR: #7 — merged
- Merge method: normal merge commit
- Merge commit: `cf951602a5415fd89e8a0042f07869469e7c5ffb`
- Force push: not used
- Main verification: Run #92
- Main Run ID: `36224672994`
- Main Job ID: `108356267604`

Main Run #92 result on the exact merge SHA:

- `npm ci`: PASS
- `git diff --check`: PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- Phase 8: **33/33 PASS**
- Phase 1-7 regression: **144/144 PASS**
- `npm test`: **177/177 PASS**
- `npm run build`: PASS
- `npm audit --audit-level=high`: PASS — **0 vulnerabilities**

This documentation update must itself pass the full `main` GitHub Actions workflow before Phase 8 is closed.
