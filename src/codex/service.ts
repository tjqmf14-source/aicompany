import { CoreError, nonEmpty, type GitSnapshot } from '../core/domain.js';
import { CoreEngine } from '../core/engine.js';
import { HandoffCore } from '../handoff/service.js';
import { CodexExecutionStore, type CodexExecution } from './store.js';
import type { CodexAvailability, CodexExecutionProvider, CodexRunOutcome, CodexEffort } from './types.js';

export interface DispatchOptions {
  model?: string;
  effort?: CodexEffort;
}

const sameSnapshot = (left: GitSnapshot, right: GitSnapshot): boolean =>
  left.head === right.head
  && left.branch === right.branch
  && left.diff === right.diff
  && JSON.stringify(left.changes) === JSON.stringify(right.changes);

export class CodexExecutionService {
  readonly store: CodexExecutionStore;
  readonly recoveredExecutions: number;

  constructor(readonly engine: CoreEngine, readonly provider: CodexExecutionProvider) {
    this.store = new CodexExecutionStore(engine.database);
    this.recoveredExecutions = this.store.recoverInFlight();
  }

  private objective(taskId: string, override?: string): string {
    const task = this.engine.repository.getTask(taskId);
    return nonEmpty(override?.trim() || task.description.trim() || task.title, 'objective', 20_000);
  }

  private highReady(execution: CodexExecution, availability: CodexAvailability, reason: string): CodexExecution {
    const task = this.engine.repository.getTask(execution.taskId);
    if (task.status === 'ready') this.engine.repository.setTaskStatus(task.id, 'waiting_provider');
    const checkpoint = this.engine.checkpoint(execution.projectId, `Codex execution ${execution.id} HIGH_READY`, execution.taskId);
    const handoff = new HandoffCore(this.engine).create(execution.projectId, execution.objective, execution.taskId);
    return this.store.update(execution.id, ['checking', 'running', 'recovery_required', 'high_ready'], 'high_ready', {
      checkpointId: checkpoint.id,
      handoffId: handoff.id,
      rateLimit: availability.rateLimit,
      error: reason,
    });
  }

  private async finishRun(execution: CodexExecution, runId: string, outcome: CodexRunOutcome): Promise<CodexExecution> {
    const checkpoint = this.engine.checkpoint(
      execution.projectId,
      `Codex execution ${execution.id} ${outcome.status}`,
      execution.taskId,
      runId,
    );
    const common = {
      threadId: outcome.threadId,
      turnId: outcome.turnId,
      model: outcome.model,
      effort: outcome.effort,
      checkpointId: checkpoint.id,
      rateLimit: outcome.rateLimit,
      lastEvent: outcome.lastEvent,
      error: outcome.error,
    };
    if (outcome.status === 'completed') {
      this.engine.repository.finishRun(runId, 'completed');
      return this.store.update(execution.id, 'running', 'completed', common);
    }

    this.store.interruptRun(runId, outcome.error ?? `Codex execution ${outcome.status}`);
    const handoff = new HandoffCore(this.engine).create(execution.projectId, execution.objective, execution.taskId);
    return this.store.update(execution.id, 'running', outcome.status === 'failed' ? 'recovery_required' : 'high_ready', {
      ...common,
      handoffId: handoff.id,
    });
  }

  async dispatch(taskId: string, objective?: string, options: DispatchOptions = {}): Promise<CodexExecution> {
    const task = this.engine.repository.getTask(taskId);
    if (task.status !== 'ready' && task.status !== 'waiting_provider') {
      throw new CoreError('INVALID_TRANSITION', 'Task must be ready or waiting_provider before Codex dispatch');
    }
    const git = this.engine.git(task.projectId);
    git.requireClean();
    const base = git.snapshot();
    let execution = this.store.create({
      projectId: task.projectId, taskId, provider: this.provider.id,
      objective: this.objective(taskId, objective), baseHead: base.head, baseBranch: base.branch,
    });
    const availability = await this.provider.checkAvailability(git.rootPath);
    if (availability.state !== 'available') {
      return this.highReady(execution, availability, availability.reason ?? 'Codex is unavailable');
    }

    const run = this.engine.startRun(taskId);
    const startCheckpoint = this.engine.checkpoint(task.projectId, `Before Codex execution ${execution.id}`, taskId, run.id);
    execution = this.store.update(execution.id, 'checking', 'running', {
      runId: run.id, checkpointId: startCheckpoint.id, rateLimit: availability.rateLimit, error: null,
    });
    const outcome = await this.provider.run({
      cwd: git.rootPath,
      objective: execution.objective,
      threadId: null,
      model: options.model,
      effort: options.effort,
      allowNewThreadOnResumeFailure: false,
    });
    return this.finishRun(execution, run.id, outcome);
  }

  private interruptionSnapshot(execution: CodexExecution): GitSnapshot | null {
    if (!execution.checkpointId) return null;
    return this.engine.repository.listCheckpoints(execution.projectId).find(item => item.id === execution.checkpointId)?.snapshot ?? null;
  }

  async resume(executionId: string, options: DispatchOptions = {}): Promise<CodexExecution> {
    let execution = this.store.get(executionId);
    if (execution.status !== 'high_ready' && execution.status !== 'recovery_required') {
      throw new CoreError('INVALID_TRANSITION', 'Codex execution is not resumable');
    }
    const task = this.engine.repository.getTask(execution.taskId);
    if (task.status !== 'waiting_provider' && task.status !== 'ready') {
      throw new CoreError('INVALID_TRANSITION', 'Task is not waiting for a provider');
    }

    const git = this.engine.git(execution.projectId);
    const current = git.snapshot();
    const checkpoint = this.interruptionSnapshot(execution);
    const exactContinuation = checkpoint !== null && sameSnapshot(checkpoint, current);
    if (!exactContinuation && current.dirty) {
      throw new CoreError('CONFLICT', 'Repository changed since the Codex checkpoint and is still dirty; review or commit it before starting a safe new thread');
    }

    const availability = await this.provider.checkAvailability(git.rootPath);
    if (availability.state !== 'available') {
      return this.store.update(execution.id, execution.status, 'high_ready', {
        rateLimit: availability.rateLimit,
        error: availability.reason ?? 'Codex is still unavailable',
      });
    }

    const run = exactContinuation && current.dirty
      ? this.engine.repository.startRun(task.id)
      : this.engine.startRun(task.id);
    const startCheckpoint = this.engine.checkpoint(execution.projectId, `Before resumed Codex execution ${execution.id}`, task.id, run.id);
    execution = this.store.update(execution.id, execution.status, 'running', {
      runId: run.id, checkpointId: startCheckpoint.id, rateLimit: availability.rateLimit, error: null,
    });
    const outcome = await this.provider.run({
      cwd: git.rootPath,
      objective: execution.objective,
      threadId: exactContinuation ? execution.threadId : null,
      model: options.model,
      effort: options.effort,
      allowNewThreadOnResumeFailure: true,
    });
    return this.finishRun(execution, run.id, outcome);
  }

  recover(executionId: string): CodexExecution {
    const execution = this.store.get(executionId);
    if (execution.status !== 'recovery_required') throw new CoreError('INVALID_TRANSITION', 'Codex execution does not require recovery');
    const task = this.engine.repository.getTask(execution.taskId);
    if (task.status === 'ready') this.engine.repository.setTaskStatus(task.id, 'waiting_provider');
    const checkpoint = this.engine.checkpoint(execution.projectId, `Recovered Codex execution ${execution.id}`, execution.taskId);
    const handoff = execution.handoffId
      ? null
      : new HandoffCore(this.engine).create(execution.projectId, execution.objective, execution.taskId);
    return this.store.update(execution.id, 'recovery_required', 'high_ready', {
      checkpointId: checkpoint.id,
      handoffId: handoff?.id ?? execution.handoffId,
      error: execution.error ?? 'Recovered interrupted Codex execution',
    });
  }
}
