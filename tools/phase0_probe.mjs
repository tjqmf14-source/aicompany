import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = join(import.meta.dirname, '..');
const workspace = join(root, 'tests', 'phase0_workspace');
const evidencePath = join(root, 'docs', 'FEASIBILITY_EVIDENCE.json');
const codexJs = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const evidence = {
  timestamp: new Date().toISOString(),
  node: process.version,
  workspace,
  codexJsPresent: existsSync(codexJs),
  checks: {},
  errors: [],
};

function record(name, status, detail = {}) {
  evidence.checks[name] = { ...detail, status };
  console.log(`${name}: ${status}${detail.note ? ` - ${detail.note}` : ''}`);
}

async function save() {
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

class Client {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.stderr = '';
    this.proc = null;
  }

  async open() {
    const args = [
      codexJs,
      'app-server',
      '--stdio',
      '-c', 'mcp_servers.gemini.enabled=false',
      '-c', 'mcp_servers.apify.enabled=false',
      '-c', 'mcp_servers.mobbin.enabled=false',
      '-c', 'mcp_servers.upbit.enabled=false',
      '-c', 'mcp_servers.local_comfyui.enabled=false',
    ];
    this.proc = spawn(process.execPath, args, {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else pending.resolve(msg.result);
      } else if (msg.method) {
        this.events.push({ method: msg.method, params: msg.params, at: Date.now() });
      }
    });
    this.proc.on('exit', (code, signal) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`app-server exited (${code ?? signal})`));
      }
      this.pending.clear();
    });
    const result = await this.request('initialize', {
      clientInfo: { name: 'ai_company_phase0_probe', title: 'AI Company Phase 0 Probe', version: '0.1.0' },
    }, 20000);
    this.notify('initialized', {});
    return result;
  }

  notify(method, params = {}) {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      const message = { id, method };
      if (params !== undefined) message.params = params;
      this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  async waitEvent(method, predicate = () => true, timeoutMs = 120000, since = 0) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const event = this.events.find((item) => item.at >= since && item.method === method && predicate(item.params));
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${method}: notification timeout after ${timeoutMs}ms`);
  }

  async close() {
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.stdin.end();
    const proc = this.proc;
    await Promise.race([
      new Promise((resolve) => proc.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (proc.exitCode === null) proc.kill();
  }
}

async function probe(name, action) {
  try {
    const detail = await action();
    record(name, 'PASS', detail ?? {});
  } catch (error) {
    record(name, 'FAIL', { note: String(error.message ?? error).slice(0, 500) });
    evidence.errors.push({ name, message: String(error.message ?? error).slice(0, 500) });
  }
  await save();
}

await mkdir(workspace, { recursive: true });
await mkdir(join(root, 'docs'), { recursive: true });
await writeFile(join(workspace, 'message.txt'), 'phase0-seed\n', 'utf8');
await writeFile(join(workspace, 'package.json'), JSON.stringify({
  private: true,
  scripts: { build: 'node build.mjs', test: 'node --test' },
}, null, 2) + '\n', 'utf8');
await writeFile(join(workspace, 'build.mjs'), "import { readFileSync, writeFileSync } from 'node:fs';\nwriteFileSync('build-output.txt', readFileSync('message.txt', 'utf8'));\n", 'utf8');
await writeFile(join(workspace, 'probe.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\ntest('Codex edited fixture', () => assert.match(readFileSync('message.txt', 'utf8'), /verified-by-codex/));\n", 'utf8');
record('fixture', 'PASS', { note: 'isolated dependency-free workspace created' });
await save();

let client = new Client();
let threadId;
let turnId;
try {
  await probe('app_server_start_initialize', async () => {
    const initialized = await client.open();
    return { pid: client.proc.pid, protocol: Object.keys(initialized ?? {}), note: 'initialize response and initialized notification sent' };
  });
  if (evidence.checks.app_server_start_initialize.status !== 'PASS') throw new Error('initialization failed');

  await probe('account_auth', async () => {
    const result = await client.request('account/read', { refreshToken: false });
    const account = result?.account ?? result;
    const mode = account?.type ?? result?.authMode ?? null;
    if (!mode) throw new Error('no account mode returned');
    return { mode, plan: account?.planType ?? result?.planType ?? null, note: 'read-only account state; identifiers omitted' };
  });

  let model;
  await probe('model_list_reasoning', async () => {
    const result = await client.request('model/list', { limit: 100, includeHidden: false });
    const models = result?.data ?? [];
    if (!models.length) throw new Error('empty model list');
    model = models.find((entry) => entry.model === 'gpt-5.6-luna') ?? models[0];
    const efforts = model.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? [];
    if (!efforts.length) throw new Error('selected model has no effort options');
    return { count: models.length, selectedModel: model.model, efforts, note: 'available catalog and reasoning efforts returned' };
  });

  await probe('skills_discovery', async () => {
    const result = await client.request('skills/list', { cwds: [workspace], forceReload: true }, 60000);
    const scoped = result?.data?.find((item) => item.cwd?.toLowerCase() === workspace.toLowerCase()) ?? result?.data?.[0];
    const skills = scoped?.skills ?? [];
    if (!skills.length) throw new Error('no skills discovered');
    return { count: skills.length, examples: skills.slice(0, 8).map((item) => item.name), errors: scoped?.errors?.length ?? 0, note: 'actual app-server skill catalog' };
  });

  await probe('mcp_capability', async () => {
    const result = await client.request('mcpServerStatus/list', { limit: 50, detail: 'toolsAndAuthOnly' }, 70000);
    const servers = result?.data ?? result?.servers ?? [];
    if (!Array.isArray(servers)) throw new Error('unexpected MCP status shape');
    return { count: servers.length, keys: Object.keys(result ?? {}), names: servers.map((item) => item.name ?? item.serverName ?? item.id).filter(Boolean), note: 'status API returned; paid servers disabled for probe' };
  });

  await probe('usage_rate_limit', async () => {
    const result = await client.request('account/rateLimits/read', undefined, 30000);
    const limits = result?.rateLimitsByLimitId ?? (result?.rateLimits ? { [result.rateLimits.limitId ?? 'default']: result.rateLimits } : {});
    if (!Object.keys(limits).length) throw new Error('no rate-limit data returned');
    return { limitIds: Object.keys(limits), windows: Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, { primaryUsedPercent: value?.primary?.usedPercent ?? null, secondaryUsedPercent: value?.secondary?.usedPercent ?? null, rateLimitReachedType: value?.rateLimitReachedType ?? null }])), note: 'read-only ChatGPT subscription limit status' };
  });

  await probe('command_safe_execution', async () => {
    const result = await client.request('command/exec', {
      command: [process.execPath, '-e', "console.log('phase0-safe-command-ok')"],
      cwd: workspace,
      sandboxPolicy: { type: 'readOnly' },
      timeoutMs: 10000,
    }, 25000);
    if (result?.exitCode !== 0 || !result?.stdout?.includes('phase0-safe-command-ok')) throw new Error(`exit=${result?.exitCode}; output missing`);
    return { exitCode: result.exitCode, stdout: result.stdout.trim(), note: 'read-only sandbox command' };
  });

  await probe('thread_start', async () => {
    const result = await client.request('thread/start', {
      model: model?.model ?? 'gpt-5.6-luna',
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      serviceName: 'ai_company_phase0_probe',
    }, 90000);
    threadId = result?.thread?.id;
    if (!threadId) throw new Error('thread id missing');
    return { threadId, sessionId: result.thread.sessionId ?? null, note: 'persistent test thread started' };
  });
  if (!threadId) throw new Error('thread start failed');

  await probe('turn_start_file_edit_stream', async () => {
    const startedAt = Date.now();
    const response = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Phase 0 fixture test. Read message.txt in this workspace, append exactly the line verified-by-codex to that file, and then reply done. Do not change any other file or use any network or paid service.' }],
      effort: 'low',
    }, 120000);
    turnId = response?.turn?.id;
    if (!turnId) throw new Error('turn id missing');
    const completed = await client.waitEvent('turn/completed', (p) => p?.turn?.id === turnId, 180000, startedAt);
    const methods = [...new Set(client.events.filter((item) => item.at >= startedAt).map((item) => item.method))];
    const content = await readFile(join(workspace, 'message.txt'), 'utf8');
    if (completed.params.turn?.status !== 'completed') throw new Error(`turn status ${completed.params.turn?.status}`);
    if (!content.includes('verified-by-codex')) throw new Error('Codex edit not present');
    return { turnId, turnStatus: completed.params.turn.status, fileContent: content.trim(), eventMethods: methods, note: 'agent read and modified fixture; streaming notifications captured' };
  });

  await probe('build_test', async () => {
    const build = await client.request('command/exec', {
      command: [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'npm.cmd'), 'run', 'build'],
      cwd: workspace,
      sandboxPolicy: { type: 'dangerFullAccess' },
      timeoutMs: 30000,
    }, 45000);
    const test = await client.request('command/exec', {
      command: [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'npm.cmd'), 'test'],
      cwd: workspace,
      sandboxPolicy: { type: 'dangerFullAccess' },
      timeoutMs: 30000,
    }, 45000);
    const output = await readFile(join(workspace, 'build-output.txt'), 'utf8').catch(() => '');
    if (build?.exitCode !== 0 || test?.exitCode !== 0 || !output.includes('verified-by-codex')) throw new Error(`build=${build?.exitCode}, test=${test?.exitCode}, output=${Boolean(output)}`);
    return { buildExit: build.exitCode, testExit: test.exitCode, buildOutputMatches: true, note: 'dependency-free npm build/test' };
  });

  await probe('thread_read', async () => {
    const result = await client.request('thread/read', { threadId, includeTurns: true }, 30000);
    if (result?.thread?.id !== threadId || !(result?.thread?.turns?.length >= 1)) throw new Error('stored turn missing');
    return { threadId, turns: result.thread.turns.length, runtimeStatus: result.thread.status?.type ?? null, note: 'persisted turn read without resume' };
  });

  const firstPid = client.proc.pid;
  await client.close();
  client = new Client();
  await probe('process_restart_recovery', async () => {
    await client.open();
    const secondPid = client.proc.pid;
    if (secondPid === firstPid) throw new Error('app-server PID did not change');
    const read = await client.request('thread/read', { threadId, includeTurns: true }, 30000);
    if (read?.thread?.id !== threadId || !(read?.thread?.turns?.length >= 1)) throw new Error('thread not recovered after restart');
    const resume = await client.request('thread/resume', { threadId }, 90000);
    if (resume?.thread?.id !== threadId) throw new Error('thread/resume returned different id');
    return { firstPid, secondPid, recoveredTurns: read.thread.turns.length, resumedThreadId: resume.thread.id, note: 'new process read and resumed prior thread' };
  });

  await probe('turn_interrupt', async () => {
    const startedAt = Date.now();
    const startRequest = client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Phase 0 interrupt test: first execute a 60-second wait in the terminal, then reply. Do not edit files or use network.' }],
      effort: 'low',
    }, 120000);
    const started = await client.waitEvent('turn/started', (p) => Boolean(p?.turn?.id), 120000, startedAt);
    const interruptTurnId = started.params.turn.id;
    if (!interruptTurnId) throw new Error('interrupt turn id missing');
    await client.request('turn/interrupt', { threadId, turnId: interruptTurnId }, 30000);
    const response = await startRequest;
    if (response?.turn?.id !== interruptTurnId) throw new Error('turn/start and turn/started IDs differ');
    const completed = await client.waitEvent('turn/completed', (p) => p?.turn?.id === interruptTurnId, 90000, startedAt);
    if (completed.params.turn?.status !== 'interrupted') throw new Error(`unexpected final status ${completed.params.turn?.status}`);
    return { turnId: interruptTurnId, turnStatus: 'interrupted', note: 'active turn interrupted and final event observed' };
  });
} catch (error) {
  evidence.errors.push({ name: 'probe_abort', message: String(error.message ?? error).slice(0, 500) });
  console.error(`Probe stopped: ${String(error.message ?? error).slice(0, 500)}`);
} finally {
  await client.close().catch(() => {});
  await save();
}
