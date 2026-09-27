import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { claimDataDirectory, readRuntime, runtimeRequest, startDesktop } from '../src/server/desktop.js';
import { packageFiles, verifyPackage } from '../src/server/package-integrity.js';
import { committedFixture } from './helpers.js';

function setup() {
  const work = committedFixture();
  const packageRoot = join(work.path, 'app');
  const webRoot = join(packageRoot, 'web');
  const dataRoot = join(work.path, 'user data');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<html><div id="root">real build</div></html>');
  writeFileSync(join(webRoot, 'assets', 'index-123.js'), 'console.log("real asset")');
  return { work, packageRoot, webRoot, dataRoot };
}

test('package: production dashboard serves HTML and typed assets on loopback', async () => {
  const ctx = setup(); const runtime = await startDesktop(ctx);
  try {
    assert.match(runtime.url, /^http:\/\/127\.0\.0\.1:/);
    const page = await fetch(runtime.url);
    assert.match(await page.text(), /real build/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const asset = await fetch(`${runtime.url}/assets/index-123.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type')!, /javascript/);
    assert.equal((await fetch(`${runtime.url}/health`)).status, 200);
  } finally { await runtime.close(); ctx.work.clean(); }
});

test('package: static routes never expose runtime data, source or traversal paths', async () => {
  const ctx = setup(); const runtime = await startDesktop(ctx);
  try {
    for (const url of ['/package.json', '/runtime.json', '/.env', '/state.sqlite', '/api/missing', '/assets/..%2f..%2fstate.sqlite', '/assets/%5c..%5cstate.sqlite', '/assets/index-123.js.map']) {
      assert.equal((await runtime.app.inject({ url })).statusCode, 404, url);
    }
  } finally { await runtime.close(); ctx.work.clean(); }
});

test('package: linked static assets are rejected', async () => {
  const ctx = setup();
  const external = join(ctx.work.path, 'external'); mkdirSync(external);
  writeFileSync(join(external, 'index-123.js'), 'private');
  renameSync(join(ctx.webRoot, 'assets'), join(ctx.webRoot, 'original-assets'));
  symlinkSync(external, join(ctx.webRoot, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  const runtime = await startDesktop(ctx);
  try { assert.equal((await runtime.app.inject({ url: '/assets/index-123.js' })).statusCode, 404); }
  finally { await runtime.close(); ctx.work.clean(); }
});

test('package: exclusive data ownership is enforced and released without deleting data', () => {
  const ctx = setup(); const first = claimDataDirectory(ctx.dataRoot);
  try { assert.throws(() => claimDataDirectory(ctx.dataRoot), /Another instance/); }
  finally { first.close(); }
  const second = claimDataDirectory(ctx.dataRoot); second.close();
  assert.ok(readFileSync(join(ctx.dataRoot, 'instance.sqlite')));
  ctx.work.clean();
});

test('package: OS releases data ownership after process termination', { timeout: 15_000 }, async () => {
  const ctx = setup(); mkdirSync(ctx.dataRoot);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); console.log('locked'); setInterval(() => {}, 1000);",
    join(ctx.dataRoot, 'instance.sqlite')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout!, 'data');
    assert.throws(() => claimDataDirectory(ctx.dataRoot), /Another instance/);
    const exit = once(child, 'exit'); child.kill(); await exit;
    const lease = claimDataDirectory(ctx.dataRoot); lease.close();
  } finally { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } ctx.work.clean(); }
});

test('package: duplicate start cannot interrupt the first owners active Core Run', async () => {
  const ctx = setup(); const runtime = await startDesktop(ctx);
  try {
    const project = runtime.engine.createProject('duplicate guard', ctx.work.path);
    const task = runtime.engine.repository.createTask(project.id, 'work', '');
    runtime.engine.repository.setTaskStatus(task.id, 'ready');
    const run = runtime.engine.repository.startRun(task.id);
    await assert.rejects(startDesktop(ctx), /Another instance/);
    assert.equal(runtime.engine.repository.getTask(task.id).status, 'running');
    assert.equal(runtime.engine.repository.getRun(run.id).status, 'running');
    const record = readRuntime(ctx.dataRoot);
    assert.equal((await runtime.app.inject({ method: 'POST', url: '/api/desktop/stop', headers: { authorization: `Bearer ${record.token}` } })).statusCode, 409);
  } finally { await runtime.close(); ctx.work.clean(); }
});

test('package: graceful restart retains project data and rotates runtime credentials', async () => {
  const ctx = setup(); let runtime = await startDesktop(ctx);
  try {
    const project = runtime.engine.createProject('persistent project', ctx.work.path);
    const before = readRuntime(ctx.dataRoot);
    await runtime.close(); runtime = await startDesktop(ctx);
    assert.equal(runtime.engine.repository.getProject(project.id).name, 'persistent project');
    assert.notEqual(readRuntime(ctx.dataRoot).token, before.token);
    assert.equal((await runtime.app.inject({ url: '/api/desktop/status', headers: { authorization: `Bearer ${before.token}` } })).statusCode, 403);
    assert.equal((await runtimeRequest(ctx.dataRoot, 'status', ctx.packageRoot)).url, runtime.url);
  } finally { await runtime.close(); ctx.work.clean(); }
});

test('package: shutdown rejects missing tokens and accepts only current credentials', async () => {
  const ctx = setup(); const runtime = await startDesktop(ctx);
  try {
    assert.equal((await runtime.app.inject({ method: 'POST', url: '/api/desktop/stop' })).statusCode, 403);
    await runtimeRequest(ctx.dataRoot, 'stop');
    await runtime.close();
    const lease = claimDataDirectory(ctx.dataRoot); lease.close();
  } finally { await runtime.close(); ctx.work.clean(); }
});

test('package: unknown runtime URLs and mismatched package owners fail closed', async () => {
  const ctx = setup(); const runtime = await startDesktop(ctx);
  try {
    await assert.rejects(runtimeRequest(ctx.dataRoot, 'status', join(ctx.work.path, 'other-app')), /Another package/);
    const record = readRuntime(ctx.dataRoot);
    writeFileSync(join(ctx.dataRoot, 'runtime.json'), JSON.stringify({ ...record, url: 'https://example.invalid' }));
    assert.throws(() => readRuntime(ctx.dataRoot), /Invalid runtime/);
  } finally { await runtime.close(); ctx.work.clean(); }
});

test('package: linked data directory and package-contained data are rejected', async () => {
  const ctx = setup(); const external = join(ctx.work.path, 'external'); mkdirSync(external);
  symlinkSync(external, ctx.dataRoot, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => claimDataDirectory(ctx.dataRoot), /symlink|junction/);
    await assert.rejects(startDesktop({ ...ctx, dataRoot: join(ctx.packageRoot, 'data') }), /outside/);
  } finally { ctx.work.clean(); }
});

test('package: failed dashboard startup releases ownership for repair', async () => {
  const ctx = setup();
  try {
    await assert.rejects(startDesktop({ ...ctx, webRoot: join(ctx.work.path, 'missing') }));
    const runtime = await startDesktop(ctx); await runtime.close();
  } finally { ctx.work.clean(); }
});

function manifestFixture() {
  const ctx = setup();
  for (const name of ['runtime/node.exe', 'runtime/npm.cmd', 'runtime/NODE-LICENSE.txt', 'dist/server/server/desktop-cli.js', 'dist/web/index.html', 'Start.cmd', 'Stop.cmd']) {
    const path = join(ctx.packageRoot, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `fixture ${name}`);
  }
  const manifest = { format: 1, version: '0.1.0', sourceSha: 'a'.repeat(40), dirty: false, nodeVersion: '24.19.0', platform: 'win32', arch: 'x64', files: packageFiles(ctx.packageRoot) };
  writeFileSync(join(ctx.packageRoot, 'package-manifest.json'), JSON.stringify(manifest));
  return ctx;
}

test('package: exact manifest accepts complete package and detects changed content', () => {
  const ctx = manifestFixture();
  try {
    assert.equal(verifyPackage(ctx.packageRoot).sourceSha, 'a'.repeat(40));
    writeFileSync(join(ctx.packageRoot, 'Start.cmd'), 'modified');
    assert.throws(() => verifyPackage(ctx.packageRoot), /hash mismatch/);
  } finally { ctx.work.clean(); }
});

test('package: extra unmanifested files and linked entries are rejected', () => {
  const ctx = manifestFixture();
  try {
    writeFileSync(join(ctx.packageRoot, 'extra.txt'), 'extra');
    assert.throws(() => verifyPackage(ctx.packageRoot), /inventory/);
    symlinkSync(resolve(ctx.webRoot), join(ctx.packageRoot, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => packageFiles(ctx.packageRoot), /symlink|junction/);
  } finally { ctx.work.clean(); }
});
