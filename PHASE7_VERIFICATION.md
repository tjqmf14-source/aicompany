# Phase 7 Verification

Date: 2026-09-26
Branch: `feature/phase7-parallel-worktrees`
Baseline main: `c60a9f3ec4905f2a82cab94a34df590174f8dbb5`
Verified functional HEAD: `6d8b488e392079067219718610ffed34518a0100`
GitHub Actions functional run: Run #70
Run ID: `36221931975`
Job ID: `108348690389`

## Scope

Phase 7 implements the Parallel Agent / Git Worktree execution substrate on top of the verified Phase 1-6 stack.

Phase 7 does **not** fake multiple LLM processes. An agent is represented as a durable worker lane linked to a real Core Task and, when available, its Phase 5 Organization role/provider. Each lane receives its own Git branch and worktree so concurrent workers can edit independently without dirtying the primary repository.

## SQLite migration

Schema version: **7**

The `parallel_lanes` table persists:

- Project / Task / Organization plan identity
- logical Role and Provider
- lane lifecycle state
- managed branch and worktree path
- base branch / base HEAD
- Core Run
- result HEAD and changed files
- declared path scopes
- integration target HEAD
- Approval
- deterministic validation evidence
- integration commit
- recovery/error state

A partial unique index prevents more than one active lane for the same Task.

## Lane lifecycle

`PREPARING → READY → WORKING → REVIEW → APPROVAL_PENDING → INTEGRATING → COMPLETED → RELEASED`

Failure/recovery states:

- `FAILED`
- `RECOVERY_REQUIRED`

A real Core Run is created when a lane enters WORKING. Submitting a committed result completes that Run and moves the Core Task to reviewing. The Task becomes passed only after approved integration validates successfully and creates the integration commit.

## Isolation

Managed worktrees are created in a dedicated sibling directory outside the primary worktree. Managed branch names are generated internally under `ai-company/parallel/*`.

Safety rules:

- Primary worktree must be clean before lane creation/integration.
- A lane must start from a committed named branch.
- Worker edits do not dirty the primary worktree.
- One Task cannot own two active lanes.
- A project is limited to 8 active lanes.
- Optional declared scope paths are repository-relative and traversal-safe.
- Active lane scope overlap is rejected.
- When scope paths exist, submission rejects changed files outside the declared scope.
- Result submission requires a clean committed worker branch that descends from its recorded base.
- Result branches with no net file changes are rejected.

## Integration gate

Integration is not automatic.

The sequence is:

1. Re-read worker HEAD and changed files.
2. Require primary branch/HEAD ancestry to remain valid.
3. Detect files changed both by the lane and primary branch since the lane base.
4. Capture a Core Checkpoint.
5. Create a manual Core Approval.
6. After Approval, verify the exact primary target HEAD and exact worker result HEAD again.
7. Perform `git merge --no-ff --no-commit`.
8. Run `typecheck`, `lint`, `test`, and `build` on the staged merge.
9. Confirm validation did not modify tracked merge content.
10. Only when every validation is PASS, create the merge commit.
11. Mark the Core Task passed.

This preserves the project rule that QA must PASS before the integration commit is created.

If merge or validation fails, the merge is aborted before commit and the lane returns to REVIEW.

## Conflict handling

Phase 7 uses two conflict layers:

- declared scope overlap before concurrent lane creation
- actual changed-file overlap against primary changes before integration Approval

A target HEAD change after Approval invalidates the preview and forces a fresh integration request. This prevents a stale Approval from being reused against a different primary state.

## Recovery

On server startup:

- PREPARING or INTEGRATING lanes become `RECOVERY_REQUIRED`.
- WORKING lanes whose Core Run was interrupted become `RECOVERY_REQUIRED`.

Recovery can:

- safely abort an interrupted known merge when MERGE_HEAD matches the lane result
- recognize a completed merge commit from its first/second parent relationship
- return a committed worker result to REVIEW
- resume an interrupted worker with a new real Core Run

Unknown merge state or missing worktree is blocked for manual review instead of being guessed safe.

## Cleanup

Only COMPLETED lanes can be released automatically.

Before removal:

- the primary repository must be clean
- the worker result must be an ancestor of the primary HEAD
- the worktree itself must be clean

Then the managed worktree is removed and the merged managed branch is deleted with normal Git safety checks.

## Organization / Dashboard / API

When a Task belongs to a Phase 5 Organization plan, the lane records its plan, role, and provider. This makes parallel lanes the isolated execution substrate for logical organization workers without inventing model processes.

Dashboard aggregate state exposes persisted `parallelLanes`, and parallel lifecycle events are included in the existing durable Activity/Event log.

API endpoints:

- `GET /api/parallel/projects/:id`
- `POST /api/parallel/projects/:id/tasks/:taskId/lanes`
- `POST /api/parallel/projects/:id/lanes/:laneId/start`
- `POST /api/parallel/projects/:id/lanes/:laneId/submit`
- `POST /api/parallel/projects/:id/lanes/:laneId/fail`
- `POST /api/parallel/projects/:id/lanes/:laneId/integration-request`
- `POST /api/parallel/projects/:id/lanes/:laneId/integrate`
- `POST /api/parallel/projects/:id/lanes/:laneId/recover`
- `POST /api/parallel/projects/:id/lanes/:laneId/release`

## Tests

`tests/parallel.test.ts` contains **32 Phase 7 tests** covering:

- schema v7 and v6→v7 migration
- real Git worktree creation
- Organization metadata linkage
- task state gate
- one-active-lane-per-task rule
- traversal-safe scopes
- scope overlap/disjoint concurrency
- Core Run lifecycle
- primary/worker isolation
- dirty/no-result submission rejection
- scope enforcement
- result HEAD/change evidence
- Checkpoint + Approval integration request
- pending/rejected Approval behavior
- validated merge commit
- release
- stale target invalidation
- same-file conflict detection
- disjoint primary changes
- validation failure merge abort
- startup recovery
- interrupted worker resume
- worker failure
- Dashboard exposure
- Fastify API
- durable parallel events

The Phase 1-6 regression suite contains **112 tests**.

## Functional QA result

GitHub Actions Run #70 (`36221931975`) on `6d8b488e392079067219718610ffed34518a0100`:

- `npm ci`: PASS
- `git diff --check`: PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- Phase 7 tests: PASS — **32/32**
- Phase 1-6 regression: PASS — **112/112**
- `npm test`: PASS — **144/144**
- `npm run build`: PASS
- `npm audit --audit-level=high`: PASS — **0 vulnerabilities**

Earlier verification was not treated as PASS:

- Run #68 failed lint due to one unused test variable; tests/build/audit were skipped.
- Run #69 reached the full test suite and exposed that `git merge --no-commit` still requires a committer identity in clean CI/PC environments. 141/144 passed; the three failures were all this integration-path defect.
- Run #70 is the first complete PASS after the managed merge identity was fixed.

This documentation commit must pass the same GitHub Actions gate before merge.

## Boundaries

- Phase 7 creates the real isolated worktree/branch execution substrate and records Organization role/provider identity; it does not claim autonomous GPT High API spawning.
- GPT High remains the existing Manual Handoff model from Phase 2.
- Phase 3 Codex provider behavior is not silently redirected into a lane by Phase 7; a worker/provider must operate on the lane worktree explicitly.
- Phase 8 remains responsible for broader security hardening/recovery audit beyond the deterministic safeguards implemented here.
- Phase 9 Windows packaging is not included.

## Main integration

Pending documentation CI and PR merge.
