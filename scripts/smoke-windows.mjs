import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyPackage } from '../dist/server/server/package-integrity.js';
import { claimDataDirectory, readRuntime, runtimeRequest } from '../dist/server/server/desktop.js';

if (process.platform !== 'win32') throw new Error('Windows smoke requires Windows');
const latest = JSON.parse(readFileSync('dist/releases/latest.json', 'utf8'));
mkdirSync('dist/smoke', { recursive: true });
const fixture = mkdtempSync(resolve('dist/smoke', 'portable 한글 & space-'));
const unpacked = join(fixture, 'unpacked');
execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:AIC_PACKAGE_ZIP -DestinationPath $env:AIC_PACKAGE_DEST'], {
  windowsHide: true, timeout: 180_000, env: { ...process.env, AIC_PACKAGE_ZIP: latest.zip, AIC_PACKAGE_DEST: unpacked },
});
const packageRoot = join(unpacked, readdirSync(unpacked)[0]);
const manifest = verifyPackage(packageRoot);
const dataRoot = join(fixture, 'retained user data');
const env = { ...process.env, AICOMPANY_DATA_DIR: dataRoot };
const launch = action => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(packageRoot, 'Launch.ps1'), '-Action', action, '-NoBrowser'], {
  // Background descendants can retain captured Windows pipe handles even after
  // PowerShell exits. Readiness and errors are checked through HTTP and log files.
  windowsHide: true, stdio: 'ignore', timeout: 60_000, env,
});
async function stopAndWait() {
  await runtimeRequest(dataRoot, 'stop');
  for (let n = 0; n < 100; n++) {
    try { const lease = claimDataDirectory(dataRoot); lease.close(); return; } catch { await delay(100); }
  }
  throw new Error('Shutdown did not release the data lock');
}
let running = false;
try {
  launch('Start'); running = true;
  const first = readRuntime(dataRoot);
  assert.equal((await fetch(first.url)).status, 200);
  const html = await (await fetch(first.url)).text();
  const asset = html.match(/src="([^" ]+\.js)"/)?.[1];
  assert.ok(asset); assert.equal((await fetch(first.url + asset)).status, 200);
  const response = await fetch(first.url + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Portable persistence smoke', rootPath: process.cwd() }) });
  assert.equal(response.status, 201); const project = await response.json();
  launch('Start'); assert.equal(readRuntime(dataRoot).instance, first.instance);
  await stopAndWait(); running = false;
  launch('Start'); running = true;
  const second = readRuntime(dataRoot);
  assert.notEqual(second.instance, first.instance);
  const saved = await (await fetch(second.url + '/api/projects/' + project.id)).json();
  assert.equal(saved.name, project.name);
  // Exercise the shipped Stop launcher too, then confirm lock release.
  launch('Stop');
  for (let n = 0; n < 100; n++) {
    try { const lease = claimDataDirectory(dataRoot); lease.close(); running = false; break; } catch { await delay(100); }
  }
  assert.equal(running, false);
  verifyPackage(packageRoot); // The app must never mutate its extracted package.
  const evidence = { status: 'PASS', sourceSha: manifest.sourceSha, dirty: manifest.dirty, zipSha256: latest.sha256,
    checks: ['zip-extraction-and-inventory', 'unicode-space-path', 'bundled-runtime-start', 'production-html-js', 'project-write', 'duplicate-start', 'graceful-stop', 'restart-retains-data', 'unchanged-package'], packageRoot, dataRoot };
  writeFileSync('dist/releases/windows-smoke.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (existsSync(join(dataRoot, 'runtime.json'))) {
    try { await runtimeRequest(dataRoot, 'status'); await stopAndWait(); }
    catch (error) { if (running) throw error; }
  }
}
