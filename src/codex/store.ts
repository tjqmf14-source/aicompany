import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CoreDatabase } from '../core/database.js';
import { CoreError } from '../core/domain.js';
import type { CodexEffort, CodexRateLimitSnapshot } from './types.js';

export type CodexExecutionStatus = 'checking' | 'running' | 'high_ready' | 'completed' | 'failed' | 'recovery_required';

export interface CodexExecution {
  id: string;
  projectId: string;
  taskId: string;
  runId: string | null;
  provider: string;
  status: CodexExecutionStatus;
  objective: string;
  threadId: string | null;
  turnId: string | null;
  model: string | null;
  effort: CodexEffort | null;
  baseHead: string | null;
  baseBranch: string | null;
  checkpointId: string | null;
  handoffId: string | null;
  rateLimit: CodexRateLimitSnapshot | null;
  lastEvent: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const parse = <T>(value: unknown): T | null => value === null || value === undefined ? null : JSON.parse(String(value)) as T;

export class CodexExecutionStore {
  private readonly db: DatabaseSync;
  constructor(private readonly database: CoreDatabase) { this.db = database.db; }

  private row(row: Row): CodexExecution {
    return {
      id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id),
      runId: row.run_id === null ? null : String(row.run_id), provider: String(row.provider),
      status: row.status as CodexExecutionStatus, objective: String(row.objective),
      threadId: row.thread_id === null ? null : String(row.thread_id),
      turnId: row.turn_id === null ? null : String(row.turn_id),
      model: row.model === null ? null : String(row.model),
      effort: row.effort === null ? null : row.effort as CodexEffort,
      baseHead: row.base_head === null ? null : String(row.base_head),
      baseBranch: row.base_branch === null ? null : String(row.base_branch),
      checkpointId: row.checkpoint_id === null ? null : String(row.checkpoint_id),
      handoffId: row.handoff_id === null ? null : String(row.handoff_id),
      rateLimit: parse<CodexRateLimitSnapshot>(row.rate_limit_json),
      lastEvent: parse<Record<string, unknown>>(row.last_event_json),
      error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private event(execution: CodexExecution, type: string, payload: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      randomUUID(), execution.projectId, execution.taskId, execution.runId, type, JSON.stringify({ executionId: execution.id, ...payload }), now(),
    );
  }

  create(input: {
    projectId: string; taskId: string; provider: string; objective: string;
    baseHead: string | null; baseBranch: string | null;
  }): CodexExecution {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO codex_executions (
      id, project_id, task_id, run_id, provider, status, objective, thread_id, turn_id, model, effort,
      base_head, base_branch, checkpoint_id, handoff_id, rate_limit_json, last_event_json, error, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, 'checking', ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`).run(
      id, input.projectId, input.taskId, input.provider, input.objective, input.baseHead, input.baseBranch, timestamp, timestamp,
    );
    const created = this.get(id);
    this.event(created, 'codex.execution_created', { status: created.status });
    return created;
  }

  get(id: string): CodexExecution {
    const row = this.db.prepare('SELECT * FROM codex_executions WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new CoreError('NOT_FOUND', 'Codex execution not found');
    return this.row(row);
  }

  list(projectId: string): CodexExecution[] {
    return (this.db.prepare('SELECT * FROM codex_executions WHERE project_id = ? ORDER BY created_at, id').all(projectId) as Row[]).map(row => this.row(row));
  }

  update(
    id: string,
    expected: CodexExecutionStatus | CodexExecutionStatus[],
    next: CodexExecutionStatus,
    patch: Partial<Pick<CodexExecution, 'runId' | 'threadId' | 'turnId' | 'model' | 'effort' | 'checkpointId' | 'handoffId' | 'rateLimit' | 'lastEvent' | 'error'>> = {},
  ): CodexExecution {
    return this.database.transaction(() => {
      const current = this.get(id);
      const expectedValues = Array.isArray(expected) ? expected : [expected];
      if (!expectedValues.includes(current.status)) throw new CoreError('CONFLICT', `Expected Codex execution ${expectedValues.join('/')} but found ${current.status}`);
      const value = <T>(key: keyof typeof patch, existing: T): T => patch[key] === undefined ? existing : patch[key] as T;
      const timestamp = now();
      this.db.prepare(`UPDATE codex_executions SET
        run_id = ?, status = ?, thread_id = ?, turn_id = ?, model = ?, effort = ?, checkpoint_id = ?, handoff_id = ?,
        rate_limit_json = ?, last_event_json = ?, error = ?, updated_at = ? WHERE id = ?`).run(
        value('runId', current.runId), next, value('threadId', current.threadId), value('turnId', current.turnId),
        value('model', current.model), value('effort', current.effort), value('checkpointId', current.checkpointId),
        value('handoffId', current.handoffId),
        JSON.stringify(value('rateLimit', current.rateLimit)),
        JSON.stringify(value('lastEvent', current.lastEvent)),
        value('error', current.error), timestamp, id,
      );
      const updated = this.get(id);
      this.event(updated, 'codex.execution_status_changed', { from: current.status, to: next });
      return updated;
    });
  }

  recoverInFlight(): number {
    const rows = this.db.prepare("SELECT id FROM codex_executions WHERE status IN ('checking','running')").all() as { id: string }[];
    for (const row of rows) {
      const current = this.get(row.id);
      this.update(current.id, current.status, 'recovery_required', {
        error: current.error ?? 'Process stopped while Codex execution was in flight',
      });
    }
    return rows.length;
  }

  interruptRun(runId: string, reason: string): void {
    this.database.transaction(() => {
      const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Row | undefined;
      if (!row) throw new CoreError('NOT_FOUND', 'Run not found');
      if (row.status === 'interrupted') return;
      if (row.status !== 'running') throw new CoreError('INVALID_TRANSITION', 'Run is not running');
      const timestamp = now();
      const projectId = String(row.project_id);
      const taskId = String(row.task_id);
      this.db.prepare("UPDATE runs SET status = 'interrupted', recovered_at = ?, finished_at = ?, error = ? WHERE id = ?").run(timestamp, timestamp, reason, runId);
      this.db.prepare("UPDATE tasks SET status = 'waiting_provider', version = version + 1, updated_at = ? WHERE id = ? AND status = 'running'").run(timestamp, taskId);
      this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        randomUUID(), projectId, taskId, runId, 'run.interrupted', JSON.stringify({ reason: 'codex_provider', detail: reason }), timestamp,
      );
    });
  }
}
