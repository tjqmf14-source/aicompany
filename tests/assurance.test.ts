import assert from 'node:assert/strict';
import {
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { AssuranceService } from '../src/assurance/service.js';
import { CapabilityStore } from '../src/capabilities/store.js';
import { CoreDatabase } from '../src/core/database.js';
import { CoreEngine } from '../src/core/engine.js';
import { migrate, schemaVersion } from '../src/core/migrations.js';
import { DashboardService } from '../src/dashboard/service.js';
import { sanitizedProcessEnv } from '../src/security/environment.js';
import { detectSecretKinds, redactSensitive } from '../src/security/redaction.js';
import { createApp } from '../src/server/app.js';
import { committedFixture } from './helpers.js';

function token(): string {
  return ['sk', 'proj', 'A'.repeat(32)].join('-');
}

function packageLock(): string {
  return JSON.stringify({
    name: 'assurance-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'assurance-fixture', version: '1.0.0' },
    },
  }, null, 2);
}

function passingScripts(expression = 'process.exit(0)'): Record<string, string> {
  const script = `node -e "${expression.replaceAll('"', '\\"')}"`;
  return { typecheck: script, lint: script, test: script, build: script };
}

function setup(options: { scripts?: Record<string, string> | null } = {}) {
  const work = committedFixture();
  if (options.scripts !== undefined) {
    const scripts = options.scripts ?? {};
    writeFileSync(join(work.path, 'package.json'), JSON.stringify({
      name: 'assurance-fixture', version: '1.0.0', private: true, scripts,
    }, null, 2));
    writeFileSync(join(work.path, 'package-lock.json'), packageLock());
    work.commit();
  }
  const dbPath = join(work.path, 'state.sqlite');
  const engine = new CoreEngine(dbPath);
  const project = engine.createProject('Phase 8', work.path);
  const assurance = new AssuranceService(engine);
  return { work, dbPath, engine, project, assurance };
}

function cleanup(ctx: ReturnType<typeof setup>): void {
  try { ctx.engine.close(); } catch { /* already closed */ }
  ctx.work.clean();
}

test('1. schema v8 is current', () => {
  const ctx = setup();
  try { assert.equal(schemaVersion(ctx.engine.database.db), 8); }
  finally { cleanup(ctx); }
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

test('3. sanitized child environment removes arbitrary secrets', () => {
  const previous = process.env.PHASE8_SECRET;
  process.env.PHASE8_SECRET = 'do-not-forward';
  try {
    const env = sanitizedProcessEnv({ CI: '1' });
    assert.equal(env.PHASE8_SECRET, undefined);
    assert.equal(env.CI, '1');
    if (process.env.PATH !== undefined) assert.equal(env.PATH, process.env.PATH);
  } finally {
    if (previous === undefined) delete process.env.PHASE8_SECRET;
    else process.env.PHASE8_SECRET = previous;
  }
});

test('4. redaction detects and removes supported secret patterns', () => {
  const secret = token();
  assert.ok(detectSecretKinds(secret).includes('api_token'));
  const redacted = redactSensitive(`value=${secret}`);
  assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /\[REDACTED\]/);
  assert.deepEqual(detectSecretKinds('Bearer [REDACTED]'), []);
});

test('5. normal loopback API request receives security headers', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { host: '127.0.0.1:3187' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-frame-options'], 'DENY');
  } finally {
    await app.close();
    cleanup(ctx);
  }
});

test('6. non-loopback Host is rejected', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example' } });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
    cleanup(ctx);
  }
});

test('7. non-loopback browser Origin is rejected', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const response = await app.inject({
      method: 'GET', url: '/health',
      headers: { host: '127.0.0.1:3187', origin: 'https://evil.example' },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
    cleanup(ctx);
  }
});

test('8. cross-site fetch metadata is rejected', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const response = await app.inject({
      method: 'GET', url: '/health',
      headers: { host: 'localhost:3187', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
    cleanup(ctx);
  }
});

test('9. forwarded requests are rejected', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const response = await app.inject({
      method: 'GET', url: '/health',
      headers: { host: 'localhost:3187', 'x-forwarded-for': '127.0.0.1' },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
    cleanup(ctx);
  }
});

test('10. clean project security audit passes', () => {
  const ctx = setup();
  try {
    const result = ctx.assurance.securityAudit(ctx.project.id);
    assert.equal(result.run.status, 'PASS');
    assert.ok(result.checks.length >= 7);
    assert.ok(result.checks.every(item => item.result === 'PASS'));
  } finally { cleanup(ctx); }
});

test('11. tracked secret causes security audit failure without persisting secret value', () => {
  const ctx = setup();
  try {
    const secret = token();
    writeFileSync(join(ctx.work.path, 'secret.txt'), `credential=${secret}\n`);
    ctx.work.commit();
    const result = ctx.assurance.securityAudit(ctx.project.id);
    const check = result.checks.find(item => item.checkKey === 'tracked_secret_scan');
    assert.equal(result.run.status, 'FAIL');
    assert.equal(check?.result, 'FAIL');
    assert.equal(JSON.stringify(check?.evidence).includes(secret), false);
    assert.match(JSON.stringify(check?.evidence), /secret\.txt/);
  } finally { cleanup(ctx); }
});

test('12. durable database secret causes security audit failure without echoing the value', () => {
  const ctx = setup();
  try {
    const secret = token();
    ctx.engine.repository.createTask(ctx.project.id, 'Secret task', `use ${secret}`);
    const result = ctx.assurance.securityAudit(ctx.project.id);
    const check = result.checks.find(item => item.checkKey === 'stored_secret_scan');
    assert.equal(check?.result, 'FAIL');
    assert.equal(JSON.stringify(check?.evidence).includes(secret), false);
    assert.match(JSON.stringify(check?.evidence), /tasks/);
  } finally { cleanup(ctx); }
});

test('13. tracked external symlink fails repository boundary audit', { skip: process.platform === 'win32' }, () => {
  const ctx = setup();
  const target = join(dirname(ctx.work.path), `${basename(ctx.work.path)}-external.txt`);
  try {
    writeFileSync(target, 'outside\n');
    symlinkSync(target, join(ctx.work.path, 'escape-link'));
    ctx.work.commit();
    const result = ctx.assurance.securityAudit(ctx.project.id);
    const check = result.checks.find(item => item.checkKey === 'tracked_symlink_boundary');
    assert.equal(check?.result, 'FAIL');
  } finally {
    rmSync(target, { force: true });
    cleanup(ctx);
  }
});

test('14. paid verified capability is caught by ZERO-COST security audit', () => {
  const ctx = setup();
  try {
    const capabilities = new CapabilityStore(ctx.engine.database);
    capabilities.upsert({
      projectId: ctx.project.id,
      name: 'Paid test capability',
      type: 'MCP',
      discoveryState: 'FOUND',
      installationState: 'INSTALLED',
      authState: 'NOT_REQUIRED',
      costState: 'PAID',
      verificationState: 'PASS',
      runtimeState: 'VERIFIED',
    });
    const result = ctx.assurance.securityAudit(ctx.project.id);
    assert.equal(result.run.status, 'FAIL');
    assert.equal(result.checks.find(item => item.checkKey === 'zero_cost_enforcement')?.result, 'FAIL');
  } finally { cleanup(ctx); }
});

test('15. clean recovery audit passes with no active incidents', () => {
  const ctx = setup();
  try {
    const result = ctx.assurance.recoveryAudit(ctx.project.id);
    assert.equal(result.run.status, 'PASS');
    assert.equal(ctx.assurance.state(ctx.project.id).incidents.filter(item => item.status !== 'RESOLVED').length, 0);
  } finally { cleanup(ctx); }
});

test('16. interrupted Core Run becomes a durable recovery incident', () => {
  const ctx = setup();
  try {
    const task = ctx.engine.repository.createTask(ctx.project.id, 'Interrupted', '');
    ctx.engine.repository.setTaskStatus(task.id, 'ready');
    const run = ctx.engine.startRun(task.id);
    ctx.engine.close();

    const engine = new CoreEngine(ctx.dbPath);
    ctx.engine = engine;
    ctx.assurance = new AssuranceService(engine);
    assert.equal(engine.repository.getRun(run.id).status, 'interrupted');

    const result = ctx.assurance.recoveryAudit(ctx.project.id);
    assert.equal(result.run.status, 'WARN');
    const incident = ctx.assurance.state(ctx.project.id).incidents.find(item => item.sourceKind === 'RUN' && item.sourceId === run.id);
    assert.equal(incident?.status, 'OPEN');
  } finally { cleanup(ctx); }
});

test('17. recovery incident resolves only after source condition is gone', () => {
  const ctx = setup();
  try {
    const task = ctx.engine.repository.createTask(ctx.project.id, 'Interrupted', '');
    ctx.engine.repository.setTaskStatus(task.id, 'ready');
    const run = ctx.engine.startRun(task.id);
    ctx.engine.close();

    const engine = new CoreEngine(ctx.dbPath);
    ctx.engine = engine;
    ctx.assurance = new AssuranceService(engine);
    ctx.assurance.recoveryAudit(ctx.project.id);
    engine.repository.setTaskStatus(task.id, 'ready');
    const second = ctx.assurance.recoveryAudit(ctx.project.id);
    assert.equal(second.run.status, 'PASS');
    const incident = ctx.assurance.state(ctx.project.id).incidents.find(item => item.sourceKind === 'RUN' && item.sourceId === run.id);
    assert.equal(incident?.status, 'RESOLVED');
    assert.ok(incident?.resolvedAt);
  } finally { cleanup(ctx); }
});

test('18. stale RUNNING capability operation is BLOCKED recovery state', () => {
  const ctx = setup();
  try {
    const capabilities = new CapabilityStore(ctx.engine.database);
    const capability = capabilities.upsert({
      projectId: ctx.project.id,
      name: 'Free local test',
      type: 'SKILL',
      discoveryState: 'FOUND',
      installationState: 'INSTALLED',
      authState: 'NOT_REQUIRED',
      costState: 'FREE_LOCAL',
      verificationState: 'PASS',
      runtimeState: 'NOT_CHECKED',
    });
    const operation = capabilities.createOperation({
      capabilityId: capability.id,
      projectId: ctx.project.id,
      kind: 'INSTALL',
      status: 'RUNNING',
    });
    const result = ctx.assurance.recoveryAudit(ctx.project.id);
    assert.equal(result.run.status, 'FAIL');
    const incident = ctx.assurance.state(ctx.project.id).incidents.find(item => item.sourceKind === 'CAPABILITY' && item.sourceId === operation.id);
    assert.equal(incident?.status, 'BLOCKED');
  } finally { cleanup(ctx); }
});

test('19. unfinished primary Git operation is BLOCKED', () => {
  const ctx = setup();
  const cherry = join(ctx.work.path, '.git', 'CHERRY_PICK_HEAD');
  try {
    writeFileSync(cherry, ctx.work.git('rev-parse', 'HEAD').trim() + '\n');
    const result = ctx.assurance.recoveryAudit(ctx.project.id);
    assert.equal(result.run.status, 'FAIL');
    assert.equal(ctx.assurance.state(ctx.project.id).incidents.some(item =>
      item.sourceKind === 'GIT' && item.sourceId === 'CHERRY_PICK_HEAD' && item.status === 'BLOCKED'), true);
  } finally {
    rmSync(cherry, { force: true });
    cleanup(ctx);
  }
});

test('20. clean Node QA profile passes and records all deterministic checks', () => {
  const ctx = setup({ scripts: passingScripts() });
  try {
    const result = ctx.assurance.qa(ctx.project.id);
    assert.equal(result.run.status, 'PASS');
    for (const key of ['clean_worktree','package_scripts','git_diff_check','typecheck','lint','test','build','npm_audit','workspace_unchanged']) {
      assert.equal(result.checks.find(item => item.checkKey === key)?.result, 'PASS', key);
    }
  } finally { cleanup(ctx); }
});

test('21. missing required QA script fails instead of being skipped as PASS', () => {
  const scripts = passingScripts();
  delete scripts.build;
  const ctx = setup({ scripts });
  try {
    const result = ctx.assurance.qa(ctx.project.id);
    assert.equal(result.run.status, 'FAIL');
    assert.equal(result.checks.find(item => item.checkKey === 'build')?.result, 'FAIL');
  } finally { cleanup(ctx); }
});

test('22. dirty worktree blocks release QA and records NOT_RUN steps', () => {
  const ctx = setup({ scripts: passingScripts() });
  try {
    writeFileSync(join(ctx.work.path, 'dirty.txt'), 'dirty\n');
    const result = ctx.assurance.qa(ctx.project.id);
    assert.equal(result.run.status, 'FAIL');
    assert.equal(result.checks.find(item => item.checkKey === 'clean_worktree')?.result, 'FAIL');
    assert.equal(result.checks.find(item => item.checkKey === 'test')?.result, 'NOT_RUN');
  } finally { cleanup(ctx); }
});

test('23. QA npm scripts do not receive arbitrary parent secrets', () => {
  const scripts = passingScripts("process.exit(process.env.PHASE8_SECRET ? 9 : 0)");
  const ctx = setup({ scripts });
  const previous = process.env.PHASE8_SECRET;
  process.env.PHASE8_SECRET = 'parent-only';
  try {
    const result = ctx.assurance.qa(ctx.project.id);
    assert.equal(result.run.status, 'PASS');
  } finally {
    if (previous === undefined) delete process.env.PHASE8_SECRET;
    else process.env.PHASE8_SECRET = previous;
    cleanup(ctx);
  }
});

test('24. QA detects tracked workspace mutation caused by build', () => {
  const scripts = passingScripts();
  scripts.build = 'node -e "require(\'fs\').writeFileSync(\'README.md\', \'mutated\\n\')"';
  const ctx = setup({ scripts });
  try {
    const result = ctx.assurance.qa(ctx.project.id);
    assert.equal(result.run.status, 'FAIL');
    assert.equal(result.checks.find(item => item.checkKey === 'workspace_unchanged')?.result, 'FAIL');
  } finally { cleanup(ctx); }
});

test('25. QA evidence redacts secret-like command output', () => {
  const secret = token();
  const scripts = passingScripts();
  scripts.test = `node -e "console.log('${secret}'); process.exit(7)"`;
  const ctx = setup({ scripts });
  try {
    const result = ctx.assurance.qa(ctx.project.id);
    const check = result.checks.find(item => item.checkKey === 'test');
    assert.equal(check?.result, 'FAIL');
    const evidence = JSON.stringify(check?.evidence);
    assert.equal(evidence.includes(secret), false);
    assert.match(evidence, /REDACTED/);
  } finally { cleanup(ctx); }
});

test('26. assurance state returns latest security recovery and QA runs', () => {
  const ctx = setup({ scripts: passingScripts() });
  try {
    ctx.assurance.securityAudit(ctx.project.id);
    ctx.assurance.recoveryAudit(ctx.project.id);
    ctx.assurance.qa(ctx.project.id);
    const state = ctx.assurance.state(ctx.project.id);
    assert.equal(state.latestSecurity?.run.status, 'PASS');
    assert.equal(state.latestRecovery?.run.status, 'PASS');
    assert.equal(state.latestQa?.run.status, 'PASS');
  } finally { cleanup(ctx); }
});

test('27. assurance API persists security audit and exposes it', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const security = await app.inject({
      method: 'POST',
      url: `/api/assurance/projects/${ctx.project.id}/security`,
      headers: { host: '127.0.0.1:3187' },
    });
    assert.equal(security.statusCode, 200);
    assert.equal((security.json() as { run: { status: string } }).run.status, 'PASS');

    const state = await app.inject({
      method: 'GET',
      url: `/api/assurance/projects/${ctx.project.id}`,
      headers: { host: '127.0.0.1:3187' },
    });
    assert.equal(state.statusCode, 200);
    assert.equal((state.json() as { latestSecurity: { run: { status: string } } }).latestSecurity.run.status, 'PASS');
  } finally {
    await app.close();
    cleanup(ctx);
  }
});

test('28. Dashboard command center reflects persisted assurance status', () => {
  const ctx = setup();
  try {
    ctx.assurance.securityAudit(ctx.project.id);
    ctx.assurance.recoveryAudit(ctx.project.id);
    const state = new DashboardService(ctx.engine).projectState(ctx.project.id);
    assert.equal(state.commandCenter.securityStatus, 'PASS');
    assert.equal(state.commandCenter.recoveryStatus, 'PASS');
    assert.equal(state.commandCenter.releaseQaStatus, 'NOT RUN');
    assert.equal(state.assurance.latestSecurity?.run.status, 'PASS');
  } finally { cleanup(ctx); }
});
