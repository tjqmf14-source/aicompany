import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CoreEngine } from '../core/engine.js';
import { assertNoLinkedComponents } from '../core/path-safety.js';
import { createApp } from './app.js';
import { registerBuiltDashboard } from './static.js';

export function dataDirectory(): string {
  const configured = process.env.AICOMPANY_DATA_DIR;
  if (configured) return resolve(configured);
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is unavailable; set AICOMPANY_DATA_DIR explicitly');
  return resolve(process.env.LOCALAPPDATA, 'AICompanyBridge');
}

export function validateDataLocation(dataRoot: string, packageRoot: string): void {
  const part = relative(resolve(packageRoot), resolve(dataRoot));
  if (!part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))) throw new Error('Data directory must be outside the application package');
}

export function claimDataDirectory(directory: string): { root: string; close: () => void } {
  const root = resolve(directory);
  if (root === parse(root).root) throw new Error('A filesystem root cannot be the data directory');
  assertNoLinkedComponents(parse(root).root, root);
  mkdirSync(root, { recursive: true });
  for (const name of ['instance.sqlite', 'instance.sqlite-journal', 'state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'runtime.json', 'runtime.json.tmp', 'server.log', 'server-error.log']) {
    assertNoLinkedComponents(root, join(root, name));
  }
  const lock = new DatabaseSync(join(root, 'instance.sqlite'));
  try { lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;'); }
  catch { lock.close(); throw new Error('Another instance owns this data directory; do not delete the lock database'); }
  let closed = false;
  return { root, close: () => { if (!closed) { closed = true; lock.close(); } } };
}

export interface RuntimeRecord { url: string; token: string; instance: string; packageRoot: string; pid: number }

export function readRuntime(directory: string): RuntimeRecord {
  const file = assertNoLinkedComponents(resolve(directory), join(directory, 'runtime.json'));
  const record = JSON.parse(readFileSync(file, 'utf8')) as RuntimeRecord;
  const port = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(record.url ?? '')?.[1];
  if (!port || Number(port) < 1 || Number(port) > 65535 || !/^[a-f0-9]{64}$/.test(record.token ?? '')
    || !/^[a-f0-9]{32}$/.test(record.instance ?? '') || typeof record.packageRoot !== 'string') throw new Error('Invalid runtime record');
  return record;
}

export async function runtimeRequest(directory: string, action: 'status' | 'stop', packageRoot?: string): Promise<{ url: string }> {
  const record = readRuntime(directory);
  if (packageRoot && resolve(record.packageRoot) !== resolve(packageRoot)) throw new Error('Another package version is running; stop it before switching versions');
  const response = await fetch(`${record.url}/api/desktop/${action}`, {
    method: action === 'stop' ? 'POST' : 'GET', redirect: 'error',
    headers: { authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(2000),
  });
  const body = await response.json() as { instance?: string };
  if (!response.ok || body.instance !== record.instance) throw new Error('Runtime identity check failed');
  return { url: record.url };
}

export async function startDesktop(options: { dataRoot: string; webRoot: string; packageRoot: string; port?: number }) {
  validateDataLocation(options.dataRoot, options.packageRoot);
  execFileSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const lease = claimDataDirectory(options.dataRoot);
  let engine: CoreEngine | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  try {
    engine = new CoreEngine(join(lease.root, 'state.sqlite'));
    app = createApp(engine);
    registerBuiltDashboard(app, options.webRoot);
    const token = randomBytes(32).toString('hex');
    const instance = randomBytes(16).toString('hex');
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      // SSE/keepalive clients must not retain DB ownership indefinitely on shutdown.
      app!.server.closeAllConnections();
      try { await app!.close(); } finally { try { engine!.close(); } finally { lease.close(); } }
    })();
    const authorized = (value: string | undefined): boolean => {
      const expected = Buffer.from(`Bearer ${token}`);
      const actual = Buffer.from(value ?? '');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    };
    app.get('/api/desktop/status', async (request, reply) => {
      if (!authorized(request.headers.authorization)) return reply.code(403).send({ error: 'FORBIDDEN' });
      return { instance, status: 'ready' };
    });
    app.post('/api/desktop/stop', async (request, reply) => {
      if (!authorized(request.headers.authorization)) return reply.code(403).send({ error: 'FORBIDDEN' });
      if (engine!.database.db.prepare("SELECT 1 FROM runs WHERE status = 'running' LIMIT 1").get()
        || engine!.database.db.prepare("SELECT 1 FROM qa_runs WHERE status = 'RUNNING' LIMIT 1").get()) {
        return reply.code(409).send({ error: 'ACTIVE_WORK', message: 'Finish or interrupt active work before stopping', instance });
      }
      reply.raw.once('finish', () => { setImmediate(() => { void close(); }); });
      return { instance, status: 'stopping' };
    });
    const url = await app.listen({ host: '127.0.0.1', port: options.port ?? 0 });
    const record: RuntimeRecord = { url, token, instance, pid: process.pid, packageRoot: resolve(options.packageRoot) };
    writeFileSync(join(lease.root, 'runtime.json.tmp'), JSON.stringify(record), { mode: 0o600 });
    renameSync(join(lease.root, 'runtime.json.tmp'), join(lease.root, 'runtime.json'));
    return { app, engine, url, close };
  } catch (error) {
    try { if (app) { app.server.closeAllConnections(); await app.close(); } } finally { try { engine?.close(); } finally { lease.close(); } }
    throw error;
  }
}
