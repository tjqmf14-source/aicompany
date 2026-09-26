import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/core/database.js';
import { CoreEngine } from '../src/core/engine.js';
import { migrate, schemaVersion } from '../src/core/migrations.js';
import { DashboardService } from '../src/dashboard/service.js';
import { SecurityService } from '../src/security/service.js';
import { SecurityStore } from '../src/security/store.js';
import { createApp } from '../src/server/app.js';
import { committedFixture } from './helpers.js';

function qaFiles(path: string, fail: 'typecheck' | 'lint' | 'test' | 'build' | null = null, mutate = false): void {
  const script = (name: string) => {
    if (mutate && name === 'test') return `node -e "require('fs').writeFileSync('README.md','qa-mutated\\n')"`;
    return `node -e "process.exit(${fail === name ? 7 : 0})"`;
  };
  writeFileSync(join(path, 'package.json'), JSON.stringify({
    name: 'phase8-fixture', version: '1.0.0', private: true,
    scripts: {
      typecheck: script('typecheck'),
      lint: script('lint'),
      test: script('test'),
      build: script('build'),
    },
  }, null, 2));
  writeFileSync(join(path, 'package-lock.json'), JSON.stringify({
    name: 'phase8-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'phase8-fixture', version: '1.0.0' } },
  }, null, 2));
}

function setup(options: { qa?: boolean; fail?: 'typecheck' | 'lint' | 'test' | 'build' | null; mutate?: boolean } = {}) {
  const work = committedFixture();
  if (options.qa) {
    qaFiles(work.path, options.fail ?? null, options.mutate ?? false);
    work.commit();
  }
  const dbPath = join(work.path, 'state.sqlite');
  const engine = new CoreEngine(dbPath);
  const project = engine.createProject('Phase 8', work.path);
  const security = new SecurityService(engine);
  return { work, dbPath, engine, project, security };
}

function clean(ctx: ReturnType<typeof setup>): void {
  try { ctx.engine.close(); } catch { /* already closed */ }
  ctx.work.clean();
}

test('1. schema v8 is current', () => {
  const ctx = setup();
  try { assert.equal(schemaVersion(ctx.engine.database.db), 8); }
  finally { clean(ctx); }
});

test('2. v7 database migrates to v8', () => {
  const work = committedFixture();
  try {
    const db = new CoreDatabase(join(work.path, 'migration.sqlite'), false);
    assert.equal(migrate(db.db, 7), 7);
    assert.equal(migrate(db.db), 8);
    assert.equal(schemaVersion(db.db), 8);
    db.close();
  } finally { work.clean(); }
});

test('3. clean repository security audit passes', () => {
  const ctx = setup();
  try {
    const audit = ctx.security.audit(ctx.project.id);
    assert.equal(audit.status, 'PASS');
    assert.ok(audit.checks.every(item => item.status === 'PASS'));
    assert.equal(audit.checks.find(item => item.key === 'sqlite_quick_check')?.status, 'PASS');
    assert.equal(audit.checks.find(item => item.key === 'tracked_secret_scan')?.status, 'PASS');
  } finally { clean(ctx); }
});

test('4. security audit is durable', () => {
  const ctx = setup();
  try {
    const audit = ctx.security.audit(ctx.project.id);
    const reloaded = new SecurityStore(ctx.engine.database).latestAudit(ctx.project.id);
    assert.equal(reloaded?.id, audit.id);
    assert.equal(reloaded?.status, 'PASS');
  } finally { clean(ctx); }
});

test('5. dirty worktree is explicit WARN not silent PASS', () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.work.path, 'README.md'), 'dirty\n');
    const audit = ctx.security.audit(ctx.project.id);
    assert.equal(audit.status, 'WARN');
    assert.equal(audit.checks.find(item => item.key === 'working_tree')?.status, 'WARN');
  } finally { clean(ctx); }
});

test('6. tracked .env blocks security audit', () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.work.path, '.env'), 'SAFE_PLACEHOLDER=1\n');
    ctx.work.commit();
    const audit = ctx.security.audit(ctx.project.id);
    assert.equal(audit.status, 'FAIL');
    const scan = audit.checks.find(item => item.key === 'tracked_secret_scan');
    assert.equal(scan?.status, 'FAIL');
    assert.match(scan?.evidence ?? '', /\.env/);
  } finally { clean(ctx); }
});

test('7. tracked private key marker blocks audit without exposing content', () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.work.path, 'credential.txt'), '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n');
    ctx.work.commit();
    const audit = ctx.security.audit(ctx.project.id);
    assert.equal(audit.status, 'FAIL');
    const scan = audit.checks.find(item => item.key === 'tracked_secret_scan');
    assert.equal(scan?.status, 'FAIL');
    assert.match(scan?.evidence ?? '', /credential\.txt/);
    assert.doesNotMatch(scan?.evidence ?? '', /not-a-real-key/);
  } finally { clean(ctx); }
});

test('8. tracked .env.example is allowed', () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.work.path, '.env.example'), 'EXAMPLE_ONLY=1\n');
    ctx.work.commit();
    const audit = ctx.security.audit(ctx.project.id);
    assert.equal(audit.checks.find(item => item.key === 'tracked_secret_scan')?.status, 'PASS');
  } finally { clean(ctx); }
});

test('9. unfinished merge marker blocks security audit', () => {
  const ctx = setup();
  try {
    const head = ctx.work.git('rev-parse', 'HEAD').trim();
    writeFileSync(join(ctx.work.path, '.git', 'MERGE_HEAD'), head + '\n');
    const audit = ctx.security.audit(ctx.project.id);
    const operation = audit.checks.find(item => item.key === 'git_operation_state');
    assert.equal(operation?.status, 'FAIL');
    assert.match(operation?.evidence ?? '', /merge/);
    rmSync(join(ctx.work.path, '.git', 'MERGE_HEAD'), { force: true });
  } finally { clean(ctx); }
});

test('10. no recovery state produces no blockers', () => {
  const ctx = setup();
  try {
    const recovery = ctx.security.recovery(ctx.project.id);
    assert.deepEqual(recovery.blockers, []);
    assert.equal(recovery.recoveryHandoffs, 0);
    assert.equal(recovery.recoveryCodex, 0);
    assert.equal(recovery.recoveryParallel, 0);
  } finally { clean(ctx); }
});

test('11. recovery-required handoff blocks release readiness', () => {
  const ctx = setup();
  try {
    const now = new Date().toISOString();
    ctx.engine.database.db.prepare(`INSERT INTO handoffs
      (id, project_id, task_id, provider, status, objective, bundle_path, base_head, base_branch,
       response_json, preview_json, checkpoint_json, verification_json, error, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`).run(
        'h-recovery', ctx.project.id, 'manual-high', 'recovery_required', 'recover',
        join(ctx.work.path, 'bundle'), ctx.engine.git(ctx.project.id).head(), 'main',
        'recovery needed', now, now,
      );
    const recovery = ctx.security.recovery(ctx.project.id);
    assert.equal(recovery.recoveryHandoffs, 1);
    assert.equal(recovery.blockers.length, 1);
    const audit = ctx.security.audit(ctx.project.id);
    assert.equal(audit.status, 'FAIL');
    assert.equal(audit.checks.find(item => item.key === 'recovery_blockers')?.status, 'BLOCKED');
  } finally { clean(ctx); }
});

test('12. recovery-required Codex execution is counted', () => {
  const ctx = setup();
  try {
    const task = ctx.engine.repository.createTask(ctx.project.id, 'codex', '');
    const now = new Date().toISOString();
    ctx.engine.database.db.prepare(`INSERT INTO codex_executions
      (id, project_id, task_id, run_id, provider, status, objective, thread_id, turn_id, model, effort,
       base_head, base_branch, checkpoint_id, handoff_id, rate_limit_json, last_event_json, error, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`).run(
        'c-recovery', ctx.project.id, task.id, 'codex-app-server', 'recovery_required',
        'recover codex', ctx.engine.git(ctx.project.id).head(), 'main', 'needs recovery', now, now,
      );
    const recovery = ctx.security.recovery(ctx.project.id);
    assert.equal(recovery.recoveryCodex, 1);
    assert.ok(recovery.blockers.some(item => item.includes('Codex')));
  } finally { clean(ctx); }
});

test('13. recovery-required parallel lane is counted', () => {
  const ctx = setup();
  try {
    const task = ctx.engine.repository.createTask(ctx.project.id, 'parallel', '');
    const now = new Date().toISOString();
    ctx.engine.database.db.prepare(`INSERT INTO parallel_lanes
      (id, project_id, task_id, plan_id, role, provider, status, branch_name, worktree_path, base_head,
       base_branch, run_id, result_head, changed_files_json, scope_paths_json, target_head,
       integration_commit, approval_id, validation_json, error, created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, '[]', '[]', NULL, NULL, NULL, '[]', ?, ?, ?)`).run(
        'p-recovery', ctx.project.id, task.id, 'RECOVERY_REQUIRED',
        'ai-company/parallel/recovery-test', join(ctx.work.path, 'missing-worktree'),
        ctx.engine.git(ctx.project.id).head(), 'main', 'needs recovery', now, now,
      );
    const recovery = ctx.security.recovery(ctx.project.id);
    assert.equal(recovery.recoveryParallel, 1);
    assert.ok(recovery.blockers.some(item => item.includes('parallel')));
  } finally { clean(ctx); }
});

test('14. interrupted historical Core run is visible but is not itself a recovery blocker', () => {
  const ctx = setup();
  try {
    const task = ctx.engine.repository.createTask(ctx.project.id, 'run', '');
    ctx.engine.repository.setTaskStatus(task.id, 'ready');
    const run = ctx.engine.startRun(task.id);
    ctx.engine.close();
    const reopened = new CoreEngine(ctx.dbPath);
    ctx.engine = reopened;
    ctx.security = new SecurityService(reopened);
    assert.equal(reopened.repository.getRun(run.id).status, 'interrupted');
    const recovery = ctx.security.recovery(ctx.project.id);
    assert.equal(recovery.interruptedRuns, 1);
    assert.deepEqual(recovery.blockers, []);
  } finally { clean(ctx); }
});

test('15. QA success persists all six deterministic checks', () => {
  const ctx = setup({ qa: true });
  try {
    const run = ctx.security.runQa(ctx.project.id);
    assert.equal(run.status, 'PASS');
    assert.equal(run.checks.length, 6);
    assert.ok(run.checks.every(item => item.status === 'PASS'));
    assert.deepEqual(run.checks.map(item => item.name), [
      'git_diff_check', 'typecheck', 'lint', 'test', 'build', 'npm_audit',
    ]);
  } finally { clean(ctx); }
});

test('16. QA command failure is persisted as FAIL and later checks still run', () => {
  const ctx = setup({ qa: true, fail: 'test' });
  try {
    const run = ctx.security.runQa(ctx.project.id);
    assert.equal(run.status, 'FAIL');
    assert.equal(run.checks.find(item => item.name === 'test')?.status, 'FAIL');
    assert.equal(run.checks.find(item => item.name === 'build')?.status, 'PASS');
    assert.equal(run.checks.find(item => item.name === 'npm_audit')?.status, 'PASS');
  } finally { clean(ctx); }
});

test('17. QA detects tracked repository mutation caused by validation', () => {
  const ctx = setup({ qa: true, mutate: true });
  try {
    const run = ctx.security.runQa(ctx.project.id);
    assert.equal(run.status, 'FAIL');
    assert.ok(run.checks.filter(item => item.name === 'git_diff_check').some(item => item.status === 'FAIL'));
    assert.match(run.error ?? '', /failed/i);
  } finally { clean(ctx); }
});

test('18. only one active QA run is allowed per project', () => {
  const ctx = setup({ qa: true });
  try {
    const snapshot = ctx.engine.git(ctx.project.id).snapshot();
    ctx.security.store.startQa(ctx.project.id, snapshot.head, snapshot.branch);
    assert.throws(() => ctx.security.store.startQa(ctx.project.id, snapshot.head, snapshot.branch));
  } finally { clean(ctx); }
});

test('19. startup recovery converts RUNNING QA to INTERRUPTED', () => {
  const ctx = setup({ qa: true });
  try {
    const snapshot = ctx.engine.git(ctx.project.id).snapshot();
    const run = ctx.security.store.startQa(ctx.project.id, snapshot.head, snapshot.branch);
    assert.equal(ctx.security.recoverStartupQa(), 1);
    assert.equal(ctx.security.store.getQa(run.id).status, 'INTERRUPTED');
    assert.equal(ctx.security.recoverStartupQa(), 0);
  } finally { clean(ctx); }
});

test('20. reading security state does not interrupt active QA', () => {
  const ctx = setup({ qa: true });
  try {
    const snapshot = ctx.engine.git(ctx.project.id).snapshot();
    const run = ctx.security.store.startQa(ctx.project.id, snapshot.head, snapshot.branch);
    new SecurityService(ctx.engine).state(ctx.project.id);
    assert.equal(ctx.security.store.getQa(run.id).status, 'RUNNING');
  } finally { clean(ctx); }
});

test('21. releaseReady requires QA PASS followed by clean security audit', () => {
  const ctx = setup({ qa: true });
  try {
    const qa = ctx.security.runQa(ctx.project.id);
    assert.equal(qa.status, 'PASS');
    assert.equal(ctx.security.state(ctx.project.id).releaseReady, false);
    const audit = ctx.security.audit(ctx.project.id);
    assert.equal(audit.status, 'PASS');
    assert.equal(ctx.security.state(ctx.project.id).releaseReady, true);
  } finally { clean(ctx); }
});

test('22. releaseReady remains false on WARN audit', () => {
  const ctx = setup({ qa: true });
  try {
    assert.equal(ctx.security.runQa(ctx.project.id).status, 'PASS');
    writeFileSync(join(ctx.work.path, 'README.md'), 'dirty after qa\n');
    assert.equal(ctx.security.audit(ctx.project.id).status, 'WARN');
    assert.equal(ctx.security.state(ctx.project.id).releaseReady, false);
  } finally { clean(ctx); }
});

test('23. security audit and QA lifecycle write durable Events', () => {
  const ctx = setup({ qa: true });
  try {
    ctx.security.runQa(ctx.project.id);
    ctx.security.audit(ctx.project.id);
    const types = ctx.engine.repository.listEvents(ctx.project.id).map(item => item.type);
    assert.ok(types.includes('qa.run_started'));
    assert.ok(types.includes('qa.run_finished'));
    assert.ok(types.includes('security.audit_completed'));
  } finally { clean(ctx); }
});

test('24. Dashboard exposes security state', () => {
  const ctx = setup({ qa: true });
  try {
    ctx.security.runQa(ctx.project.id);
    ctx.security.audit(ctx.project.id);
    const state = new DashboardService(ctx.engine).projectState(ctx.project.id);
    assert.equal(state.security.latestQa?.status, 'PASS');
    assert.equal(state.security.latestAudit?.status, 'PASS');
    assert.equal(state.security.releaseReady, true);
  } finally { clean(ctx); }
});

test('25. security API runs audit and returns state', async () => {
  const ctx = setup({ qa: true });
  const app = createApp(ctx.engine);
  try {
    const audit = await app.inject({ method: 'POST', url: `/api/security/projects/${ctx.project.id}/audit` });
    assert.equal(audit.statusCode, 200);
    assert.equal((audit.json() as { status: string }).status, 'PASS');
    const state = await app.inject({ method: 'GET', url: `/api/security/projects/${ctx.project.id}` });
    assert.equal(state.statusCode, 200);
    assert.equal((state.json() as { latestAudit: { status: string } }).latestAudit.status, 'PASS');
  } finally {
    await app.close();
    clean(ctx);
  }
});

test('26. security API runs QA and lists persisted runs', async () => {
  const ctx = setup({ qa: true });
  const app = createApp(ctx.engine);
  try {
    const qa = await app.inject({ method: 'POST', url: `/api/security/projects/${ctx.project.id}/qa` });
    assert.equal(qa.statusCode, 200);
    assert.equal((qa.json() as { status: string }).status, 'PASS');
    const list = await app.inject({ method: 'GET', url: `/api/security/projects/${ctx.project.id}/qa-runs` });
    assert.equal(list.statusCode, 200);
    assert.equal((list.json() as unknown[]).length, 1);
  } finally {
    await app.close();
    clean(ctx);
  }
});

test('27. non-loopback Host is rejected', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { host: 'example.com' } });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), { error: 'LOCAL_ONLY', message: 'AI Company API accepts loopback hosts only' });
  } finally {
    await app.close();
    clean(ctx);
  }
});

test('28. localhost, IPv4 loopback and IPv6 loopback hosts are allowed', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    for (const host of ['localhost:3187', '127.0.0.1:3187', '[::1]:3187']) {
      const response = await app.inject({ method: 'GET', url: '/health', headers: { host } });
      assert.equal(response.statusCode, 200, host);
    }
  } finally {
    await app.close();
    clean(ctx);
  }
});

test('29. API responses include hardening headers', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
    clean(ctx);
  }
});

test('30. missing project is explicit 404 on security API', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const response = await app.inject({ method: 'GET', url: '/api/security/projects/missing' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: 'NOT_FOUND', message: 'Project not found' });
  } finally {
    await app.close();
    clean(ctx);
  }
});

test('31. initial security state is conservative NOT READY', () => {
  const ctx = setup();
  try {
    const state = ctx.security.state(ctx.project.id);
    assert.equal(state.latestAudit, null);
    assert.equal(state.latestQa, null);
    assert.equal(state.releaseReady, false);
  } finally { clean(ctx); }
});

test('32. audits endpoint preserves chronological evidence', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    ctx.security.audit(ctx.project.id);
    writeFileSync(join(ctx.work.path, 'README.md'), 'dirty\n');
    ctx.security.audit(ctx.project.id);
    const response = await app.inject({ method: 'GET', url: `/api/security/projects/${ctx.project.id}/audits` });
    const audits = response.json() as { status: string }[];
    assert.equal(audits.length, 2);
    assert.deepEqual(audits.map(item => item.status), ['PASS', 'WARN']);
  } finally {
    await app.close();
    clean(ctx);
  }
});
