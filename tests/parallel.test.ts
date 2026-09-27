import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/core/database.js';
import { CoreEngine } from '../src/core/engine.js';
import { CoreError } from '../src/core/domain.js';
import { migrate, schemaVersion } from '../src/core/migrations.js';
import { DashboardService } from '../src/dashboard/service.js';
import { OrganizationService } from '../src/organization/service.js';
import { ParallelService } from '../src/parallel/service.js';
import { ParallelGit } from '../src/parallel/git.js';
import type { ParallelLane } from '../src/parallel/types.js';
import { createApp } from '../src/server/app.js';
import { committedFixture } from './helpers.js';

type Setup = ReturnType<typeof setup>;

function validationPackage(fail: 'typecheck' | 'lint' | 'test' | 'build' | null = null, testMode: 'pass' | 'zero' | 'skip' = 'pass') {
  const script = (name: string) => {
    if (name !== 'test') return `node -e "process.exit(${fail === name ? 7 : 0})"`;
    if (fail === 'test') return 'node -e "console.log(\'# tests 1\\n# pass 0\\n# fail 1\\n# cancelled 0\\n# skipped 0\\n# todo 0\'); process.exit(7)"';
    if (testMode === 'zero') return 'node -e "console.log(\'# tests 0\\n# pass 0\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\')"';
    if (testMode === 'skip') return 'node -e "console.log(\'# tests 1\\n# pass 0\\n# fail 0\\n# cancelled 0\\n# skipped 1\\n# todo 0\')"';
    return 'node -e "console.log(\'# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\')"';
  };
  return JSON.stringify({
    name: 'parallel-fixture',
    version: '1.0.0',
    private: true,
    scripts: {
      typecheck: script('typecheck'),
      lint: script('lint'),
      test: script('test'),
      build: script('build'),
    },
  }, null, 2);
}

function setup(options: { organization?: boolean; failValidation?: 'typecheck' | 'lint' | 'test' | 'build' | null; testMode?: 'pass' | 'zero' | 'skip' } = {}) {
  const work = committedFixture();
  writeFileSync(join(work.path, 'package.json'), validationPackage(options.failValidation ?? null, options.testMode ?? 'pass'));
  writeFileSync(join(work.path, 'shared.txt'), 'base\n');
  work.commit();
  const dbPath = join(work.path, 'state.sqlite');
  const engine = new CoreEngine(dbPath);
  const project = engine.createProject('Phase 7', work.path);
  let task;
  let planId: string | null = null;
  if (options.organization) {
    const organization = new OrganizationService(engine);
    const plan = organization.createPlan(project.id, {
      objective: 'Parallel organization test',
      tasks: [{
        key: 'worker',
        title: 'Parallel worker',
        description: 'Work in an isolated lane',
        role: 'Coding',
        provider: 'CODEX',
      }],
    });
    planId = plan.id;
    organization.start(plan.id);
    task = organization.store.planTasks(plan.id)[0]!;
  } else {
    task = engine.repository.createTask(project.id, 'Parallel worker', 'Work in an isolated lane');
    engine.repository.setTaskStatus(task.id, 'ready');
  }
  const parallel = new ParallelService(engine);
  return { work, dbPath, engine, project, task, parallel, planId };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function commitWorker(lane: ParallelLane, path = 'worker.txt', content = 'worker\n'): string {
  writeFileSync(join(lane.worktreePath, path), content);
  git(lane.worktreePath, 'add', '--', path);
  git(lane.worktreePath, '-c', 'user.name=Parallel Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-m', 'worker result');
  return git(lane.worktreePath, 'rev-parse', 'HEAD');
}

function cleanup(ctx: Setup): void {
  let lanes: ParallelLane[] = [];
  try { lanes = ctx.parallel.store.list(ctx.project.id); } catch { /* database may already be closed */ }
  for (const lane of lanes) {
    if (existsSync(lane.worktreePath)) {
      try { git(ctx.work.path, 'worktree', 'remove', '--force', lane.worktreePath); } catch { rmSync(lane.worktreePath, { recursive: true, force: true }); }
    }
    try { git(ctx.work.path, 'branch', '-D', lane.branchName); } catch { /* branch may be merged/deleted */ }
  }
  try { ctx.engine.close(); } catch { /* already closed */ }
  rmSync(join(dirname(ctx.work.path), '.ai-company-worktrees', basename(ctx.work.path)), { recursive: true, force: true });
  ctx.work.clean();
}

function approve(ctx: Setup, lane: ParallelLane): void {
  assert.ok(lane.approvalId);
  ctx.engine.repository.resolveApproval(lane.approvalId, 'approved');
}

test('1. schema v8 is current', () => {
  const ctx = setup();
  try { assert.equal(schemaVersion(ctx.engine.database.db), 8); }
  finally { cleanup(ctx); }
});

test('2. v6 migrates through v8', () => {
  const work = committedFixture();
  try {
    const db = new CoreDatabase(join(work.path, 'migration.sqlite'), false);
    assert.equal(migrate(db.db, 6), 6);
    assert.equal(migrate(db.db), 8);
    assert.equal(schemaVersion(db.db), 8);
    db.close();
  } finally { work.clean(); }
});

test('3. creating a lane makes an isolated managed worktree and branch', () => {
  const ctx = setup();
  try {
    const lane = ctx.parallel.create(ctx.task.id);
    assert.equal(lane.status, 'READY');
    assert.equal(existsSync(lane.worktreePath), true);
    assert.match(lane.branchName, /^ai-company\/parallel\//);
    assert.equal(git(lane.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'), lane.branchName);
    assert.equal(git(lane.worktreePath, 'rev-parse', 'HEAD'), lane.baseHead);
    assert.notEqual(lane.worktreePath, ctx.work.path);
  } finally { cleanup(ctx); }
});

test('4. lane copies Organization role provider and plan identity', () => {
  const ctx = setup({ organization: true });
  try {
    const lane = ctx.parallel.create(ctx.task.id);
    assert.equal(lane.planId, ctx.planId);
    assert.equal(lane.role, 'Coding');
    assert.equal(lane.provider, 'CODEX');
  } finally { cleanup(ctx); }
});

test('5. task must be ready or waiting_provider before lane creation', () => {
  const ctx = setup();
  try {
    const queued = ctx.engine.repository.createTask(ctx.project.id, 'Queued', '');
    assert.throws(() => ctx.parallel.create(queued.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'INVALID_TRANSITION');
  } finally { cleanup(ctx); }
});

test('6. one task cannot have two active parallel lanes', () => {
  const ctx = setup();
  try {
    ctx.parallel.create(ctx.task.id);
    assert.throws(() => ctx.parallel.create(ctx.task.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { cleanup(ctx); }
});

test('7. scope traversal is rejected', () => {
  const ctx = setup();
  try {
    assert.throws(() => ctx.parallel.create(ctx.task.id, ['../outside']), (error: unknown) =>
      error instanceof CoreError && error.code === 'INVALID_INPUT');
  } finally { cleanup(ctx); }
});

test('8. overlapping declared scopes are blocked across active lanes', () => {
  const ctx = setup();
  try {
    ctx.parallel.create(ctx.task.id, ['src']);
    const other = ctx.engine.repository.createTask(ctx.project.id, 'Other', '');
    ctx.engine.repository.setTaskStatus(other.id, 'ready');
    assert.throws(() => ctx.parallel.create(other.id, ['src/core']), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { cleanup(ctx); }
});

test('9. disjoint declared scopes can run in parallel', () => {
  const ctx = setup();
  try {
    const first = ctx.parallel.create(ctx.task.id, ['src/core']);
    const other = ctx.engine.repository.createTask(ctx.project.id, 'Other', '');
    ctx.engine.repository.setTaskStatus(other.id, 'ready');
    const second = ctx.parallel.create(other.id, ['src/web']);
    assert.equal(first.status, 'READY');
    assert.equal(second.status, 'READY');
    assert.notEqual(first.worktreePath, second.worktreePath);
  } finally { cleanup(ctx); }
});

test('10. starting a lane creates a real Core Run', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    assert.equal(lane.status, 'WORKING');
    assert.ok(lane.runId);
    assert.equal(ctx.engine.repository.getRun(lane.runId!).status, 'running');
    assert.equal(ctx.engine.repository.getTask(ctx.task.id).status, 'running');
  } finally { cleanup(ctx); }
});

test('11. worker changes do not dirty the primary worktree', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    writeFileSync(join(lane.worktreePath, 'worker.txt'), 'dirty worker\n');
    assert.equal(ctx.engine.git(ctx.project.id).snapshot().dirty, false);
    assert.equal(ctx.parallel.store.get(lane.id).status, 'WORKING');
  } finally { cleanup(ctx); }
});

test('12. dirty worker result cannot be submitted', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    writeFileSync(join(lane.worktreePath, 'worker.txt'), 'dirty worker\n');
    assert.throws(() => ctx.parallel.submit(lane.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'DIRTY_WORKTREE');
  } finally { cleanup(ctx); }
});

test('13. unchanged worker branch cannot be submitted', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    assert.throws(() => ctx.parallel.submit(lane.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { cleanup(ctx); }
});

test('14. declared scope blocks committed changes outside that scope', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id, ['src']);
    lane = ctx.parallel.start(lane.id);
    commitWorker(lane, 'worker.txt', 'outside declared scope\n');
    assert.throws(() => ctx.parallel.submit(lane.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { cleanup(ctx); }
});

test('15. committed worker result enters REVIEW and completes the Core Run', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    const resultHead = commitWorker(lane);
    lane = ctx.parallel.submit(lane.id);
    assert.equal(lane.status, 'REVIEW');
    assert.equal(lane.resultHead, resultHead);
    assert.deepEqual(lane.changedFiles, ['worker.txt']);
    assert.equal(ctx.engine.repository.getRun(lane.runId!).status, 'completed');
    assert.equal(ctx.engine.repository.getTask(ctx.task.id).status, 'reviewing');
  } finally { cleanup(ctx); }
});

test('16. integration request creates Checkpoint and Approval', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    commitWorker(lane);
    lane = ctx.parallel.submit(lane.id);
    const checkpointsBefore = ctx.engine.repository.listCheckpoints(ctx.project.id).length;
    lane = ctx.parallel.requestIntegration(lane.id);
    assert.equal(lane.status, 'APPROVAL_PENDING');
    assert.ok(lane.approvalId);
    assert.equal(ctx.engine.repository.listCheckpoints(ctx.project.id).length, checkpointsBefore + 1);
    const approval = ctx.engine.repository.listApprovals(ctx.project.id).find(item => item.id === lane.approvalId);
    assert.match(approval?.action ?? '', /^parallel\.integrate:/);
  } finally { cleanup(ctx); }
});

test('17. pending Approval blocks integration', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    commitWorker(lane);
    lane = ctx.parallel.submit(lane.id);
    lane = ctx.parallel.requestIntegration(lane.id);
    assert.throws(() => ctx.parallel.integrate(lane.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { cleanup(ctx); }
});

test('18. rejected integration returns lane to REVIEW', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    commitWorker(lane);
    lane = ctx.parallel.submit(lane.id);
    lane = ctx.parallel.requestIntegration(lane.id);
    ctx.engine.repository.resolveApproval(lane.approvalId!, 'rejected');
    lane = ctx.parallel.integrate(lane.id);
    assert.equal(lane.status, 'REVIEW');
    assert.equal(lane.approvalId, null);
    assert.match(lane.error ?? '', /rejected/i);
  } finally { cleanup(ctx); }
});

test('19. approved integration validates then creates a merge commit and passes task', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    commitWorker(lane);
    lane = ctx.parallel.submit(lane.id);
    lane = ctx.parallel.requestIntegration(lane.id);
    approve(ctx, lane);
    lane = ctx.parallel.integrate(lane.id);
    assert.equal(lane.status, 'COMPLETED');
    assert.ok(lane.integrationCommit);
    assert.equal(lane.validation.length, 4);
    assert.ok(lane.validation.every(item => item.status === 'PASS'));
    assert.equal(ctx.engine.repository.getTask(ctx.task.id).status, 'passed');
    assert.equal(ctx.engine.git(ctx.project.id).snapshot().dirty, false);
    assert.equal(git(ctx.work.path, 'rev-parse', 'HEAD^2'), lane.resultHead);
  } finally { cleanup(ctx); }
});

test('20. completed integration can release worktree and merged branch', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    commitWorker(lane);
    lane = ctx.parallel.submit(lane.id);
    lane = ctx.parallel.requestIntegration(lane.id);
    approve(ctx, lane);
    lane = ctx.parallel.integrate(lane.id);
    const path = lane.worktreePath;
    lane = ctx.parallel.release(lane.id);
    assert.equal(lane.status, 'RELEASED');
    assert.equal(existsSync(path), false);
    assert.throws(() => git(ctx.work.path, 'rev-parse', '--verify', lane.branchName));
  } finally { cleanup(ctx); }
});

test('21. active lane cannot be released', () => {
  const ctx = setup();
  try {
    const lane = ctx.parallel.create(ctx.task.id);
    assert.throws(() => ctx.parallel.release(lane.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'INVALID_TRANSITION');
  } finally { cleanup(ctx); }
});

test('22. target HEAD movement after Approval invalidates the integration preview', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    commitWorker(lane);
    lane = ctx.parallel.submit(lane.id);
    lane = ctx.parallel.requestIntegration(lane.id);
    approve(ctx, lane);
    writeFileSync(join(ctx.work.path, 'main-only.txt'), 'main change\n');
    ctx.work.commit();
    lane = ctx.parallel.integrate(lane.id);
    assert.equal(lane.status, 'REVIEW');
    assert.equal(lane.targetHead, null);
    assert.match(lane.error ?? '', /fresh integration preview/i);
  } finally { cleanup(ctx); }
});

test('23. same-file target change is blocked before Approval', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    writeFileSync(join(lane.worktreePath, 'shared.txt'), 'worker edit\n');
    git(lane.worktreePath, 'add', '--', 'shared.txt');
    git(lane.worktreePath, '-c', 'user.name=Parallel Worker', '-c', 'user.email=worker@example.invalid', 'commit', '-m', 'edit shared');
    lane = ctx.parallel.submit(lane.id);
    writeFileSync(join(ctx.work.path, 'shared.txt'), 'main edit\n');
    ctx.work.commit();
    assert.throws(() => ctx.parallel.requestIntegration(lane.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { cleanup(ctx); }
});

test('24. disjoint primary change still allows integration preview', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    commitWorker(lane);
    lane = ctx.parallel.submit(lane.id);
    writeFileSync(join(ctx.work.path, 'main-only.txt'), 'main change\n');
    ctx.work.commit();
    lane = ctx.parallel.requestIntegration(lane.id);
    assert.equal(lane.status, 'APPROVAL_PENDING');
    assert.equal(lane.targetHead, git(ctx.work.path, 'rev-parse', 'HEAD'));
  } finally { cleanup(ctx); }
});

test('25. failed validation aborts merge before commit', () => {
  const ctx = setup({ failValidation: 'test' });
  try {
    const before = git(ctx.work.path, 'rev-parse', 'HEAD');
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    commitWorker(lane);
    lane = ctx.parallel.submit(lane.id);
    lane = ctx.parallel.requestIntegration(lane.id);
    approve(ctx, lane);
    lane = ctx.parallel.integrate(lane.id);
    assert.equal(lane.status, 'REVIEW');
    assert.equal(lane.integrationCommit, null);
    assert.equal(git(ctx.work.path, 'rev-parse', 'HEAD'), before);
    assert.equal(ctx.engine.git(ctx.project.id).snapshot().dirty, false);
    assert.equal(lane.validation.find(item => item.name === 'test')?.status, 'FAIL');
  } finally { cleanup(ctx); }
});

test('26. startup recovery marks interrupted worker lane RECOVERY_REQUIRED', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    const laneId = lane.id;
    ctx.engine.close();
    const engine = new CoreEngine(ctx.dbPath);
    const parallel = new ParallelService(engine);
    assert.equal(engine.repository.getRun(lane.runId!).status, 'interrupted');
    assert.equal(parallel.recoverStartupStates(), 1);
    lane = parallel.store.get(laneId);
    assert.equal(lane.status, 'RECOVERY_REQUIRED');
    engine.close();
    ctx.engine = engine;
  } finally {
    const recoveryEngine = new CoreEngine(ctx.dbPath);
    ctx.engine = recoveryEngine;
    ctx.parallel = new ParallelService(recoveryEngine);
    cleanup(ctx);
  }
});

test('27. interrupted worker lane can resume with a new Core Run', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    const oldRun = lane.runId;
    ctx.engine.close();
    const engine = new CoreEngine(ctx.dbPath);
    const parallel = new ParallelService(engine);
    parallel.recoverStartupStates();
    lane = parallel.recover(lane.id);
    assert.equal(lane.status, 'WORKING');
    assert.notEqual(lane.runId, oldRun);
    assert.equal(engine.repository.getRun(lane.runId!).status, 'running');
    ctx.engine = engine;
    ctx.parallel = parallel;
  } finally { cleanup(ctx); }
});

test('28. failing an active lane fails its Core Run and Task', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    lane = ctx.parallel.fail(lane.id, 'worker failed');
    assert.equal(lane.status, 'FAILED');
    assert.equal(ctx.engine.repository.getRun(lane.runId!).status, 'failed');
    assert.equal(ctx.engine.repository.getTask(ctx.task.id).status, 'failed');
  } finally { cleanup(ctx); }
});

test('29. Dashboard exposes persisted parallel lanes', () => {
  const ctx = setup();
  try {
    const lane = ctx.parallel.create(ctx.task.id);
    const state = new DashboardService(ctx.engine).projectState(ctx.project.id);
    assert.equal(state.parallelLanes.length, 1);
    assert.equal(state.parallelLanes[0]?.id, lane.id);
  } finally { cleanup(ctx); }
});

test('30. Parallel API creates and lists a lane', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const created = await app.inject({
      method: 'POST',
      url: `/api/parallel/projects/${ctx.project.id}/tasks/${ctx.task.id}/lanes`,
      payload: { scopePaths: ['src'] },
    });
    assert.equal(created.statusCode, 201);
    const lane = created.json() as ParallelLane;
    assert.equal(lane.status, 'READY');
    const listed = await app.inject({ method: 'GET', url: `/api/parallel/projects/${ctx.project.id}` });
    assert.equal(listed.statusCode, 200);
    assert.equal((listed.json() as { lanes: ParallelLane[] }).lanes.length, 1);
  } finally {
    await app.close();
    cleanup(ctx);
  }
});

test('31. Parallel API rejects unsafe scope input', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/parallel/projects/${ctx.project.id}/tasks/${ctx.task.id}/lanes`,
      payload: { scopePaths: ['../outside'] },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup(ctx);
  }
});

test('32. parallel lane lifecycle writes durable events', () => {
  const ctx = setup();
  try {
    const lane = ctx.parallel.create(ctx.task.id);
    ctx.parallel.start(lane.id);
    const types = ctx.engine.repository.listEvents(ctx.project.id).map(event => event.type);
    assert.ok(types.includes('parallel.lane_created'));
    assert.ok(types.includes('parallel.lane_status_changed'));
  } finally { cleanup(ctx); }
});

test('33. approved but unrelated Approval cannot be reused for integration', () => {
  const ctx = setup();
  try {
    const before = git(ctx.work.path, 'rev-parse', 'HEAD');
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    commitWorker(lane);
    lane = ctx.parallel.submit(lane.id);
    lane = ctx.parallel.requestIntegration(lane.id);
    const unrelated = ctx.engine.repository.requestApproval(ctx.project.id, 'parallel.integrate:other:state', ctx.task.id);
    ctx.engine.repository.resolveApproval(unrelated.id, 'approved');
    ctx.engine.database.db.prepare('UPDATE parallel_lanes SET approval_id = ? WHERE id = ?').run(unrelated.id, lane.id);
    assert.throws(() => ctx.parallel.integrate(lane.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT' && /stale|different state/i.test(error.message));
    assert.equal(git(ctx.work.path, 'rev-parse', 'HEAD'), before);
  } finally { cleanup(ctx); }
});

test('34. zero-test integration evidence aborts before commit', () => {
  const ctx = setup({ testMode: 'zero' });
  try {
    const before = git(ctx.work.path, 'rev-parse', 'HEAD');
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    commitWorker(lane);
    lane = ctx.parallel.submit(lane.id);
    lane = ctx.parallel.requestIntegration(lane.id);
    approve(ctx, lane);
    lane = ctx.parallel.integrate(lane.id);
    assert.equal(lane.status, 'REVIEW');
    assert.match(lane.validation.find(item => item.name === 'test')?.output ?? '', /zero tests/i);
    assert.equal(git(ctx.work.path, 'rev-parse', 'HEAD'), before);
  } finally { cleanup(ctx); }
});

test('35. skipped-test integration evidence aborts before commit', () => {
  const ctx = setup({ testMode: 'skip' });
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    lane = ctx.parallel.start(lane.id);
    commitWorker(lane);
    lane = ctx.parallel.submit(lane.id);
    lane = ctx.parallel.requestIntegration(lane.id);
    approve(ctx, lane);
    lane = ctx.parallel.integrate(lane.id);
    assert.equal(lane.status, 'REVIEW');
    assert.match(lane.validation.find(item => item.name === 'test')?.output ?? '', /skipped test/i);
    assert.equal(ctx.engine.git(ctx.project.id).snapshot().dirty, false);
  } finally { cleanup(ctx); }
});

test('36. interrupted known merge aborts safely after reopening the database', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    ctx.parallel.start(lane.id);
    commitWorker(lane);
    ctx.parallel.submit(lane.id);
    lane = ctx.parallel.requestIntegration(lane.id);
    approve(ctx, lane);
    ctx.parallel.store.update(lane.id, { status: 'INTEGRATING' });
    assert.equal(new ParallelGit(ctx.work.path).mergeNoCommit(lane.resultHead!).ok, true);
    ctx.engine.close();
    ctx.engine = new CoreEngine(ctx.dbPath);
    ctx.parallel = new ParallelService(ctx.engine);
    assert.equal(ctx.parallel.recoverStartupStates(), 1);
    const recovered = ctx.parallel.recover(lane.id);
    assert.equal(recovered.status, 'REVIEW');
    assert.equal(recovered.approvalId, null);
    assert.equal(new ParallelGit(ctx.work.path).mergeHead(), null);
    assert.equal(git(ctx.work.path, 'rev-parse', 'HEAD'), lane.targetHead);
  } finally { cleanup(ctx); }
});

test('37. merge recovery requires persisted successful validation evidence', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id);
    ctx.parallel.start(lane.id);
    commitWorker(lane);
    ctx.parallel.submit(lane.id);
    lane = ctx.parallel.requestIntegration(lane.id);
    approve(ctx, lane);
    lane = ctx.parallel.integrate(lane.id);
    assert.equal(lane.status, 'COMPLETED');
    ctx.parallel.store.update(lane.id, { status: 'RECOVERY_REQUIRED', validation: [] });
    assert.throws(() => ctx.parallel.recover(lane.id), /QA evidence/i);
    ctx.parallel.store.update(lane.id, { validation: lane.validation });
    assert.equal(ctx.parallel.recover(lane.id).integrationCommit, lane.integrationCommit);
  } finally { cleanup(ctx); }
});

test('38. duplicate integration claims and case-insensitive scope races are blocked', () => {
  const ctx = setup();
  try {
    let lane = ctx.parallel.create(ctx.task.id, ['Src']);
    const second = ctx.engine.repository.createTask(ctx.project.id, 'second', '');
    ctx.engine.repository.setTaskStatus(second.id, 'ready');
    assert.throws(() => ctx.parallel.create(second.id, ['src/file.ts']), /overlap|conflict/i);
    ctx.parallel.start(lane.id);
    commitWorker(lane, 'Src', 'result');
    ctx.parallel.submit(lane.id);
    lane = ctx.parallel.requestIntegration(lane.id);
    ctx.parallel.store.update(lane.id, { status: 'INTEGRATING' });
    assert.throws(() => ctx.parallel.store.update(lane.id, { status: 'INTEGRATING' }), /already claimed/i);
  } finally { cleanup(ctx); }
});

test('39. option and shell injection cannot enter managed merge or branch deletion', () => {
  const ctx = setup();
  try {
    const managed = new ParallelGit(ctx.work.path);
    for (const input of ['--abort', 'HEAD; echo injected', 'HEAD & echo injected', '-c core.hooksPath=bad']) {
      assert.throws(() => managed.mergeNoCommit(input), /exact commit SHA/i);
    }
    assert.throws(() => ctx.parallel.create(ctx.task.id, ['C:escape']), /repository-relative/i);
  } finally { cleanup(ctx); }
});
