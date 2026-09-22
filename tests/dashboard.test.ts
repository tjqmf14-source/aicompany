import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CoreEngine } from '../src/core/engine.js';
import { DashboardService } from '../src/dashboard/service.js';
import {
  connectionText, readClientSettings, readSelectedProject, writeClientSettings, writeSelectedProject,
  type KeyValueStorage,
} from '../src/dashboard/client-state.js';
import { HandoffStore } from '../src/handoff/store.js';
import { CodexExecutionStore } from '../src/codex/store.js';
import { createApp } from '../src/server/app.js';
import { committedFixture } from './helpers.js';

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function setup() {
  const work = committedFixture();
  const engine = new CoreEngine(join(work.path, 'state.sqlite'));
  const app = createApp(engine);
  return {
    work, engine, app,
    async clean() {
      await app.close();
      engine.close();
      work.clean();
    },
  };
}

async function createProject(app: ReturnType<typeof createApp>, path: string, name = 'Phase 4') {
  const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { name, rootPath: path } });
  assert.equal(response.statusCode, 201);
  return response.json() as { id: string; status: string };
}

async function createTask(app: ReturnType<typeof createApp>, projectId: string, title = 'Dashboard task', description = '') {
  const response = await app.inject({
    method: 'POST', url: `/api/projects/${projectId}/tasks`, payload: { title, description },
  });
  assert.equal(response.statusCode, 201);
  return response.json() as { id: string; status: string; version: number };
}

test('1. Dashboard load', async () => {
  const ctx = setup();
  try {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/dashboard/projects' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), []);
  } finally { await ctx.clean(); }
});

test('2. Project list', async () => {
  const ctx = setup();
  try {
    const project = await createProject(ctx.app, ctx.work.path);
    const response = await ctx.app.inject({ method: 'GET', url: '/api/dashboard/projects' });
    assert.equal(response.statusCode, 200);
    const rows = response.json() as { project: { id: string }; branch: string | null; head: string | null }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.project.id, project.id);
    assert.equal(rows[0]?.branch, 'main');
    assert.ok(rows[0]?.head);
  } finally { await ctx.clean(); }
});

test('3. Project detail', async () => {
  const ctx = setup();
  try {
    const project = await createProject(ctx.app, ctx.work.path);
    const response = await ctx.app.inject({ method: 'GET', url: `/api/dashboard/projects/${project.id}` });
    assert.equal(response.statusCode, 200);
    const state = response.json() as { project: { id: string }; commandCenter: { project: { id: string } }; settings: { zeroCostPolicy: boolean } };
    assert.equal(state.project.id, project.id);
    assert.equal(state.commandCenter.project.id, project.id);
    assert.equal(state.settings.zeroCostPolicy, true);
  } finally { await ctx.clean(); }
});

test('4. Task list', async () => {
  const ctx = setup();
  try {
    const project = await createProject(ctx.app, ctx.work.path);
    const task = await createTask(ctx.app, project.id, 'Implement task', 'Acceptance criteria:\n- works\n- tested');
    const response = await ctx.app.inject({ method: 'GET', url: `/api/dashboard/projects/${project.id}` });
    const state = response.json() as { tasks: { id: string; provider: string; acceptanceCriteria: string[] }[] };
    assert.equal(state.tasks[0]?.id, task.id);
    assert.equal(state.tasks[0]?.provider, 'SYSTEM');
    assert.deepEqual(state.tasks[0]?.acceptanceCriteria, ['works', 'tested']);
  } finally { await ctx.clean(); }
});

test('5. realtime state update over SSE', async () => {
  const ctx = setup();
  try {
    const project = await createProject(ctx.app, ctx.work.path);
    const task = await createTask(ctx.app, project.id);
    const taskReady = await ctx.app.inject({
      method: 'PATCH', url: `/api/projects/${project.id}/tasks/${task.id}/status`, payload: { status: 'ready', version: task.version },
    });
    assert.equal(taskReady.statusCode, 200);

    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    assert.ok(address && typeof address === 'object');
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/dashboard/projects/${project.id}/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const snapshots: string[] = [];
    const deadline = Date.now() + 6000;

    while (snapshots.length < 2 && Date.now() < deadline) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (event.startsWith('event: snapshot')) {
          snapshots.push(event);
          if (snapshots.length === 1) {
            const current = ctx.engine.repository.getTask(task.id);
            ctx.engine.repository.setTaskStatus(current.id, 'waiting_user', current.version);
          }
        }
      }
    }
    controller.abort();
    assert.equal(snapshots.length, 2);
    assert.match(snapshots[0] ?? '', /"status":"ready"/);
    assert.match(snapshots[1] ?? '', /"status":"waiting_user"/);
  } finally { await ctx.clean(); }
});

test('6. Git change rendering data', async () => {
  const ctx = setup();
  try {
    const project = await createProject(ctx.app, ctx.work.path);
    writeFileSync(join(ctx.work.path, 'README.md'), 'changed\n');
    writeFileSync(join(ctx.work.path, 'new-file.txt'), 'new\n');
    const response = await ctx.app.inject({ method: 'GET', url: `/api/dashboard/projects/${project.id}` });
    const state = response.json() as { git: { dirty: boolean; changes: { code: string; path: string }[]; diff: string } };
    assert.equal(state.git.dirty, true);
    assert.ok(state.git.changes.some(item => item.path === 'README.md'));
    assert.ok(state.git.changes.some(item => item.path === 'new-file.txt'));
    assert.match(state.git.diff, /README\.md/);
  } finally { await ctx.clean(); }
});

test('7. validation result rendering data', async () => {
  const ctx = setup();
  try {
    const project = await createProject(ctx.app, ctx.work.path);
    const store = new HandoffStore(ctx.engine.database);
    const session = store.create({
      id: 'validation-handoff',
      projectId: project.id,
      taskId: null,
      provider: 'manual-high',
      objective: 'Validate dashboard',
      bundlePath: join(ctx.work.path, 'handoff'),
      baseHead: ctx.engine.git(project.id).head(),
      baseBranch: ctx.engine.git(project.id).branch(),
    });
    store.update(session.id, 'awaiting_response', 'verified', {
      verification: {
        results: [
          { command: 'typecheck', status: 'PASS', exitCode: 0, output: 'ok' },
          { command: 'lint', status: 'PASS', exitCode: 0, output: 'ok' },
          { command: 'test', status: 'PASS', exitCode: 0, output: '22 pass' },
          { command: 'build', status: 'PASS', exitCode: 0, output: 'built' },
        ],
        rollback: 'NOT_NEEDED',
        codexTaskIds: [],
      },
    });
    const state = new DashboardService(ctx.engine).projectState(project.id);
    assert.equal(state.validation.find(item => item.key === 'typecheck')?.status, 'PASS');
    assert.equal(state.validation.find(item => item.key === 'unit_test')?.status, 'PASS');
    assert.equal(state.validation.find(item => item.key === 'integration_test')?.status, 'NOT RUN');
  } finally { await ctx.clean(); }
});

test('8. Codex state rendering data', async () => {
  const ctx = setup();
  try {
    const project = await createProject(ctx.app, ctx.work.path);
    const task = await createTask(ctx.app, project.id);
    const store = new CodexExecutionStore(ctx.engine.database);
    const execution = store.create({
      projectId: project.id,
      taskId: task.id,
      provider: 'codex-app-server',
      objective: 'Codex dashboard state',
      baseHead: ctx.engine.git(project.id).head(),
      baseBranch: ctx.engine.git(project.id).branch(),
    });
    store.update(execution.id, 'checking', 'high_ready', { threadId: 'thread-1', error: 'usage limit' });
    const state = new DashboardService(ctx.engine).projectState(project.id);
    assert.equal(state.codex.threadId, 'thread-1');
    assert.equal(state.codex.currentStatus, 'high_ready');
    assert.equal(state.codex.resumeAvailable, true);
    assert.equal(state.commandCenter.provider, 'CODEX');
  } finally { await ctx.clean(); }
});

test('9. checkpoint rendering data', async () => {
  const ctx = setup();
  try {
    const project = await createProject(ctx.app, ctx.work.path);
    const checkpoint = ctx.engine.checkpoint(project.id, 'Phase 4 checkpoint');
    const response = await ctx.app.inject({ method: 'GET', url: `/api/dashboard/projects/${project.id}` });
    const state = response.json() as { checkpoints: { id: string; note: string; snapshot: { head: string | null } }[] };
    assert.equal(state.checkpoints[0]?.id, checkpoint.id);
    assert.equal(state.checkpoints[0]?.note, 'Phase 4 checkpoint');
    assert.equal(state.checkpoints[0]?.snapshot.head, checkpoint.snapshot.head);
  } finally { await ctx.clean(); }
});

test('10. approval state', async () => {
  const ctx = setup();
  try {
    const project = await createProject(ctx.app, ctx.work.path);
    const approval = ctx.engine.repository.requestApproval(project.id, 'Apply reviewed patch');
    const before = new DashboardService(ctx.engine).projectState(project.id);
    assert.equal(before.commandCenter.approvalRequired, true);
    assert.equal(before.controls.approve.enabled, true);

    const resolved = await ctx.app.inject({
      method: 'POST',
      url: `/api/dashboard/projects/${project.id}/approvals/${approval.id}/resolve`,
      payload: { status: 'approved' },
    });
    assert.equal(resolved.statusCode, 200);
    const after = new DashboardService(ctx.engine).projectState(project.id);
    assert.equal(after.commandCenter.approvalRequired, false);
  } finally { await ctx.clean(); }
});

test('11. browser refresh preserves selected project and client settings', () => {
  const storage = new MemoryStorage();
  writeSelectedProject(storage, 'project-123');
  writeClientSettings(storage, { refreshSeconds: 45, providerPreference: 'high_then_codex' });
  assert.equal(readSelectedProject(storage), 'project-123');
  assert.deepEqual(readClientSettings(storage), { refreshSeconds: 45, providerPreference: 'high_then_codex' });
});

test('12. backend disconnected state', () => {
  assert.equal(connectionText(false, false), '백엔드 연결 끊김');
  assert.equal(connectionText(true, false), '연결됨');
  assert.equal(connectionText(false, true), '연결 중');
});

test('13. DB empty state', async () => {
  const ctx = setup();
  try {
    const service = new DashboardService(ctx.engine);
    assert.deepEqual(service.listProjects(), []);
    const response = await ctx.app.inject({ method: 'GET', url: '/api/dashboard/projects' });
    assert.deepEqual(response.json(), []);
  } finally { await ctx.clean(); }
});

test('14. error state returns explicit not-found response', async () => {
  const ctx = setup();
  try {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/dashboard/projects/missing-project' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: 'NOT_FOUND', message: 'Project not found' });
  } finally { await ctx.clean(); }
});

test('15. unsupported capability is explicit', async () => {
  const ctx = setup();
  try {
    const project = await createProject(ctx.app, ctx.work.path);
    const response = await ctx.app.inject({ method: 'GET', url: `/api/dashboard/projects/${project.id}/capabilities` });
    assert.equal(response.statusCode, 200);
    const rows = response.json() as { name: string; status: string }[];
    const mcp = rows.find(item => item.name === 'MCP');
    assert.ok(mcp);
    assert.equal(mcp.status, 'UNSUPPORTED');
  } finally { await ctx.clean(); }
});
