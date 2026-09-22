import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface AppServerEvent {
  method: string;
  params: Record<string, unknown>;
  at: number;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class AppServerRpcError extends Error {
  constructor(readonly method: string, message: string, readonly data: unknown = null) {
    super(`${method}: ${message}`);
    this.name = 'AppServerRpcError';
  }
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  readonly events: AppServerEvent[] = [];
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stderr = '';

  constructor(
    private readonly codexJsPath: string,
    private readonly cwd: string,
    private readonly extraArgs: string[] = [],
  ) {}

  async open(): Promise<void> {
    if (this.proc) throw new Error('App Server client is already open');
    this.proc = spawn(process.execPath, [this.codexJsPath, 'app-server', '--stdio', ...this.extraArgs], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string | Buffer) => {
      this.stderr = (this.stderr + String(chunk)).slice(-8000);
    });
    createInterface({ input: this.proc.stdout }).on('line', line => {
      let message: Record<string, unknown>;
      try { message = object(JSON.parse(line) as unknown); } catch { return; }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        const rpcError = object(message.error);
        if (Object.keys(rpcError).length) {
          pending.reject(new AppServerRpcError(
            pending.method,
            typeof rpcError.message === 'string' ? rpcError.message : JSON.stringify(rpcError),
            rpcError.data ?? null,
          ));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      if (typeof message.method === 'string') {
        this.events.push({ method: message.method, params: object(message.params), at: Date.now() });
        if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
      }
    });
    this.proc.on('exit', (code, signal) => {
      const message = `app-server exited (${code ?? signal ?? 'unknown'}): ${this.stderr}`.slice(0, 9000);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
      }
      this.pending.clear();
    });
    await this.request('initialize', {
      clientInfo: { name: 'ai_company_bridge', title: 'AI Company Bridge', version: '0.1.0' },
    }, 20_000);
    this.notify('initialized', {});
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.proc || this.proc.exitCode !== null) return Promise.reject(new Error('App Server is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
      const payload: Record<string, unknown> = { id, method };
      if (params !== undefined) payload.params = params;
      this.proc!.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.proc || this.proc.exitCode !== null) throw new Error('App Server is not running');
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async waitEvent(
    method: string,
    predicate: (params: Record<string, unknown>) => boolean = () => true,
    timeoutMs = 180_000,
    since = 0,
  ): Promise<AppServerEvent> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const found = this.events.find(event => event.at >= since && event.method === method && predicate(event.params));
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`${method}: notification timeout after ${timeoutMs}ms`);
  }

  latestEvent(): AppServerEvent | null {
    return this.events.at(-1) ?? null;
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    proc.stdin.end();
    await Promise.race([
      new Promise<void>(resolve => proc.once('exit', () => resolve())),
      new Promise<void>(resolve => setTimeout(resolve, 3000)),
    ]);
    if (proc.exitCode === null) proc.kill();
  }
}
