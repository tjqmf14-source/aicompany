import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CoreEngine } from '../src/core/engine.js';
import { CodexExecutionService } from '../src/codex/service.js';
import { CodexExecutionStore } from '../src/codex/store.js';
import type {
  CodexAvailability, CodexExecutionProvider, CodexRunOutcome, CodexRunRequest,
} from '../src/codex/types.js';
import { committedFixture } from './helpers.js';

const available: CodexAvailability = {
  state: 'available',
  reason: null,
  rateLimit: { limitId: 'codex', primaryUsedPercent: 10, secondaryUsedPercent: 20, rateLimitReachedType: null, checkedAt: 'now' },
};
const limited: CodexAvailability = {
  state: 'rate_limited',
  reason: 'limit reached',
  rateLimit: { limitId: 'codex', primaryUsedPercent: 100, secondaryUsedPercent: 100, rateLimitReachedType: 'weekly', checkedAt: 'now' },
};

class FakeProvider implements CodexExecutionProvider {
  readonly id = 'fake-codex';
  availability: CodexAvailability = available;
  outcome: CodexRunOutcome = {
    status: 'completed', threadId: 'thread-new', turnId: 'turn-1', model: 'fake-model', effort: 'low',
    reusedThread: false, rateLimit: available.rateLimit, lastEvent: { method: 'turn/completed' }, error: null,
  };
  requests: CodexRunRequest[] = [];
  mutate: ((request: CodexRunRequest) => void) | null = null;

  async checkAvailability(): Promise<CodexAvailability> { return this.availability; }
  async run(request: CodexRunRequest): Promise<CodexRunOutcome> {
    this.requests.push(request);
    this.mutate?.(request);
    return { ...this.outcome, threadId: this.outcome.threadId ?? request.threadId };
  }
}

function setup() {
  const work = committedFixture();
  const databasePath = join(work.path, '.ai-company', 'state.sqlite');
  const engine = new CoreEngine(databasePath);
  const project = engine.createProject('Codex fixture', work.path);
  const task = engine.repository.createTask(project.id, 'Continue implementation', 'Implement the next verified step');
  engine.repository.setTaskStatus(task.id, 'ready');
  return { work, databasePath, engine, project, task };
}

test('preflight rate limit moves task to waiting_provider and creates a HIGH_READY handoff without starting a run', async () => {
  const { work, engine, project, task } = setup();
  const provider = new FakeProvider();
  provider.availability = limited;
  try {
    const service = new CodexExecutionService(engine, provider);
    const execution = await service.dispatch(task.id);
    assert.equal(execution.status, 'high_ready');
    assert.equal(engine.repository.getTask(task.id).status, 'waiting_provider');
    assert.equal(engine.repository.listRuns(task.id).length, 0);
    assert.ok(execution.handoffId);
    const handoffDir = join(work.path, '.ai-company', 'handoffs', execution.handoffId!, 'bundle');
    assert.equal(existsSync(join(handoffDir, 'HANDOFF_PROMPT.md')), true);
    assert.match(readFileSync(join(handoffDir, 'context.md'), 'utf8'), /Dirty tree: false/);
    assert.equal(service.store.list(project.id).length, 1);
  } finally { engine.close(); work.clean(); }
});

test('mid-run rate limit preserves partial diff, interrupts the run and creates a handoff', async () => {
  const { work, engine, task } = setup();
  const provider = new FakeProvider();
  provider.mutate = () => writeFileSync(join(work.path, 'README.md'), 'partial codex work\n');
  provider.outcome = {
    status: 'rate_limited', threadId: 'thread-keep', turnId: 'turn-limit', model: 'fake-model', effort: 'low',
    reusedThread: false, rateLimit: limited.rateLimit, lastEvent: { method: 'account/rateLimits/updated' }, error: 'limit reached',
  };
  try {
    const service = new CodexExecutionService(engine, provider);
    const execution = await service.dispatch(task.id);
    assert.equal(execution.status, 'high_ready');
    assert.equal(engine.repository.getTask(task.id).status, 'waiting_provider');
    const runs = engine.repository.listRuns(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'interrupted');
    assert.ok(execution.checkpointId);
    assert.ok(execution.handoffId);
    const checkpoint = engine.repository.listCheckpoints(execution.projectId).find(item => item.id === execution.checkpointId);
    assert.match(checkpoint?.snapshot.diff ?? '', /partial codex work/);
    const handoffDir = join(work.path, '.ai-company', 'handoffs', execution.handoffId!, 'bundle');
    assert.match(readFileSync(join(handoffDir, 'context.md'), 'utf8'), /Dirty tree: true/);
    assert.match(readFileSync(join(handoffDir, 'git.diff'), 'utf8'), /partial codex work/);
  } finally { engine.close(); work.clean(); }
});

test('resume reuses the old thread only when the dirty workspace exactly matches the interruption checkpoint', async () => {
  const { work, engine, task } = setup();
  const provider = new FakeProvider();
  provider.mutate = () => writeFileSync(join(work.path, 'README.md'), 'partial codex work\n');
  provider.outcome = {
    status: 'rate_limited', threadId: 'thread-keep', turnId: 'turn-limit', model: 'fake-model', effort: 'low',
    reusedThread: false, rateLimit: limited.rateLimit, lastEvent: null, error: 'limit reached',
  };
  try {
    const service = new CodexExecutionService(engine, provider);
    const interrupted = await service.dispatch(task.id);
    provider.availability = available;
    provider.mutate = () => writeFileSync(join(work.path, 'README.md'), 'completed codex work\n');
    provider.outcome = {
      status: 'completed', threadId: 'thread-keep', turnId: 'turn-resume', model: 'fake-model', effort: 'low',
      reusedThread: true, rateLimit: available.rateLimit, lastEvent: { method: 'turn/completed' }, error: null,
    };
    const resumed = await service.resume(interrupted.id);
    assert.equal(provider.requests.at(-1)?.threadId, 'thread-keep');
    assert.equal(resumed.status, 'completed');
    assert.equal(engine.repository.getTask(task.id).status, 'reviewing');
    assert.equal(engine.repository.listRuns(task.id).at(-1)?.status, 'completed');
    assert.equal(readFileSync(join(work.path, 'README.md'), 'utf8'), 'completed codex work\n');
  } finally { engine.close(); work.clean(); }
});

test('completed execution records the resulting dirty state and moves the task to review', async () => {
  const { work, engine, task } = setup();
  const provider = new FakeProvider();
  provider.mutate = () => writeFileSync(join(work.path, 'README.md'), 'codex completed\n');
  try {
    const service = new CodexExecutionService(engine, provider);
    const execution = await service.dispatch(task.id);
    assert.equal(execution.status, 'completed');
    assert.equal(engine.repository.getTask(task.id).status, 'reviewing');
    const checkpoint = engine.repository.listCheckpoints(execution.projectId).find(item => item.id === execution.checkpointId);
    assert.equal(checkpoint?.snapshot.dirty, true);
    assert.match(checkpoint?.snapshot.diff ?? '', /codex completed/);
  } finally { engine.close(); work.clean(); }
});

test('process restart converts in-flight execution to recovery_required and recovery creates a durable handoff', () => {
  const { work, databasePath, engine, project, task } = setup();
  const provider = new FakeProvider();
  let reopened: CoreEngine | null = null;
  try {
    const base = engine.git(project.id).snapshot();
    const store = new CodexExecutionStore(engine.database);
    let execution = store.create({
      projectId: project.id, taskId: task.id, provider: provider.id,
      objective: 'Recover interrupted work', baseHead: base.head, baseBranch: base.branch,
    });
    const run = engine.startRun(task.id);
    execution = store.update(execution.id, 'checking', 'running', { runId: run.id });
    writeFileSync(join(work.path, 'README.md'), 'work before crash\n');
    engine.close();

    reopened = new CoreEngine(databasePath);
    const service = new CodexExecutionService(reopened, provider);
    assert.equal(reopened.repository.getRun(run.id).status, 'interrupted');
    assert.equal(reopened.repository.getTask(task.id).status, 'waiting_provider');
    assert.equal(service.recoveredExecutions, 1);
    assert.equal(service.store.get(execution.id).status, 'recovery_required');
    const recovered = service.recover(execution.id);
    assert.equal(recovered.status, 'high_ready');
    assert.ok(recovered.handoffId);
    const handoffDir = join(work.path, '.ai-company', 'handoffs', recovered.handoffId!, 'bundle');
    assert.match(readFileSync(join(handoffDir, 'git.diff'), 'utf8'), /work before crash/);
  } finally { reopened?.close(); work.clean(); }
});
