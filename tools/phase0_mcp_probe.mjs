import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = join(import.meta.dirname, '..');
const fixture = join(root, 'tests', 'phase0_workspace');
const evidence = JSON.parse(await readFile(join(root, 'docs', 'FEASIBILITY_EVIDENCE.json'), 'utf8'));
const threadId = evidence.checks.thread_start.threadId;
const codexJs = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const args = [codexJs, 'app-server', '--stdio',
  '-c', 'mcp_servers.gemini.enabled=false',
  '-c', 'mcp_servers.apify.enabled=false',
  '-c', 'mcp_servers.mobbin.enabled=false',
  '-c', 'mcp_servers.upbit.enabled=false',
  '-c', 'mcp_servers.local_comfyui.enabled=false'];
const proc = spawn(process.execPath, args, { cwd: fixture, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let nextId = 1;
const pending = new Map();
createInterface({ input: proc.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
  else p.resolve(msg.result);
});
function request(method, params, timeout = 40000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timeout`)); }, timeout);
    pending.set(id, { method, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    proc.stdin.write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + '\n');
  });
}
try {
  await request('initialize', { clientInfo: { name: 'ai_company_phase0_mcp', title: 'AI Company MCP Probe', version: '0.1.0' } });
  proc.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  await request('thread/resume', { threadId }, 90000);
  const result = await request('mcpServerStatus/list', { limit: 50, detail: 'toolsAndAuthOnly' }, 90000);
  const nodeRepl = result.data.find((item) => item.name === 'node_repl');
  if (process.argv.includes('--skills')) {
    const listed = await request('skills/list', { cwds: [fixture], forceReload: true }, 60000);
    const scoped = listed.data.find((item) => item.cwd?.toLowerCase() === fixture.toLowerCase()) ?? listed.data[0];
    const snapshot = { count: scoped?.skills?.length ?? 0, errors: scoped?.errors ?? [], skills: scoped?.skills?.map((item) => ({ name: item.name, path: item.path, enabled: item.enabled })) ?? [] };
    await writeFile(join(root, 'docs', 'FEASIBILITY_SKILLS.json'), JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    console.log(`skills/list: ${snapshot.count} skills, ${snapshot.errors.length} errors`);
  }
  if (process.argv.includes('--usage')) {
    try {
      const usage = await request('account/usage/read', undefined, 30000);
      const summary = usage?.summary ?? null;
      evidence.checks.usage_activity = {
        status: summary ? 'PASS' : 'UNSUPPORTED',
        summaryFields: summary ? Object.keys(summary) : [],
        dailyBucketsPresent: Array.isArray(usage?.dailyUsageBuckets),
        note: summary ? 'read-only token-activity summary returned; values omitted' : 'no activity summary returned',
      };
      await writeFile(join(root, 'docs', 'FEASIBILITY_EVIDENCE.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
      console.log(`account/usage/read: ${evidence.checks.usage_activity.status}`);
    } catch (error) {
      evidence.checks.usage_activity = { status: 'UNSUPPORTED', note: String(error.message ?? error).slice(0, 300) };
      await writeFile(join(root, 'docs', 'FEASIBILITY_EVIDENCE.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
      console.log(`account/usage/read: UNSUPPORTED - ${evidence.checks.usage_activity.note}`);
    }
  }
  if (process.argv.includes('--file-read')) {
    const read = await request('command/exec', {
      command: [process.execPath, '-e', "const fs=require('node:fs'); console.log(fs.readFileSync('message.txt','utf8'))"],
      cwd: fixture,
      sandboxPolicy: { type: 'readOnly' },
      timeoutMs: 10000,
    }, 25000);
    if (read.exitCode !== 0 || !read.stdout?.includes('phase0-seed') || !read.stdout?.includes('verified-by-codex')) throw new Error('fixture read failed');
    evidence.checks.workspace_read = { status: 'PASS', method: 'command/exec', exitCode: read.exitCode, contentMarkers: ['phase0-seed', 'verified-by-codex'] };
    await writeFile(join(root, 'docs', 'FEASIBILITY_EVIDENCE.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    console.log('workspace read: PASS');
  }
  console.log(JSON.stringify({
    threadId,
    server: nodeRepl?.name ?? null,
    authStatus: nodeRepl?.authStatus ?? null,
    tools: Object.entries(nodeRepl?.tools ?? {}).map(([name, data]) => ({ name, inputSchema: data.inputSchema })),
  }, null, 2));
  if (process.argv.includes('--call')) {
    const tool = Object.keys(nodeRepl?.tools ?? {}).find((name) => name === 'js');
    if (!tool) throw new Error('node_repl js tool not exposed');
    const call = await request('mcpServer/tool/call', {
      threadId, server: 'node_repl', tool, arguments: { code: "console.log('phase0-mcp-ok')" },
    }, 60000);
    console.log(JSON.stringify({ isError: call.isError ?? false, content: call.content }, null, 2));
    const text = call.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') ?? '';
    if (call.isError || !text.includes('phase0-mcp-ok')) throw new Error('local MCP smoke output missing');
    evidence.checks.mcp_tool_call = { status: 'PASS', server: 'node_repl', tool, output: 'phase0-mcp-ok', note: 'mcpServer/tool/call returned free local JS smoke' };
    await writeFile(join(root, 'docs', 'FEASIBILITY_EVIDENCE.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  }
} catch (error) {
  console.error(String(error.message ?? error));
  process.exitCode = 1;
} finally {
  proc.stdin.end();
  setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, 3000).unref();
}
