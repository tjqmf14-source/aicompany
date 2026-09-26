import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CoreDatabase } from '../core/database.js';
import { CoreError } from '../core/domain.js';
import type {
  ParallelLane, ParallelLaneStatus, ParallelState, ParallelValidation,
} from './types.js';
import type { OrganizationProvider, OrganizationRole } from '../organization/types.js';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const id = (): string => randomUUID();
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new CoreError('NOT_FOUND', `${label} not found`);
  return value;
};

export class ParallelStore {
  private readonly db: DatabaseSync;
  constructor(private readonly database: CoreDatabase) { this.db = database.db; }

  private event(projectId: string, taskId: string, type: string, payload: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id(), projectId, taskId, null, type, JSON.stringify(payload), now(),
    );
  }

  private lane(row: Row): ParallelLane {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      taskId: String(row.task_id),
      planId: row.plan_id === null ? null : String(row.plan_id),
      role: row.role === null ? null : row.role as OrganizationRole,
      provider: row.provider === null ? null : row.provider as OrganizationProvider,
      status: row.status as ParallelLaneStatus,
      branchName: String(row.branch_name),
      worktreePath: String(row.worktree_path),
      baseHead: String(row.base_head),
      baseBranch: String(row.base_branch),
      runId: row.run_id === null ? null : String(row.run_id),
      resultHead: row.result_head === null ? null : String(row.result_head),
      changedFiles: parse<string[]>(row.changed_files_json),
      scopePaths: parse<string[]>(row.scope_paths_json),
      targetHead: row.target_head === null ? null : String(row.target_head),
      integrationCommit: row.integration_commit === null ? null : String(row.integration_commit),
      approvalId: row.approval_id === null ? null : String(row.approval_id),
      validation: parse<ParallelValidation[]>(row.validation_json),
      error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  create(lane: ParallelLane): ParallelLane {
    this.database.transaction(() => {
      this.db.prepare(`INSERT INTO parallel_lanes VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`).run(
        lane.id, lane.projectId, lane.taskId, lane.planId, lane.role, lane.provider, lane.status,
        lane.branchName, lane.worktreePath, lane.baseHead, lane.baseBranch, lane.runId, lane.resultHead,
        JSON.stringify(lane.changedFiles), JSON.stringify(lane.scopePaths), lane.targetHead,
        lane.integrationCommit, lane.approvalId, JSON.stringify(lane.validation), lane.error,
        lane.createdAt, lane.updatedAt,
      );
      this.event(lane.projectId, lane.taskId, 'parallel.lane_created', {
        laneId: lane.id, branch: lane.branchName, provider: lane.provider, role: lane.role,
      });
    });
    return this.get(lane.id);
  }

  get(laneId: string): ParallelLane {
    return this.lane(required(this.db.prepare('SELECT * FROM parallel_lanes WHERE id = ?').get(laneId) as Row | undefined, 'Parallel lane'));
  }

  list(projectId: string): ParallelLane[] {
    return (this.db.prepare('SELECT * FROM parallel_lanes WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as Row[])
      .map(row => this.lane(row));
  }

  active(projectId: string): ParallelLane[] {
    return this.list(projectId).filter(lane => !['COMPLETED','FAILED','RELEASED'].includes(lane.status));
  }

  update(laneId: string, patch: Partial<Omit<ParallelLane, 'id' | 'projectId' | 'taskId' | 'createdAt'>>): ParallelLane {
    const current = this.get(laneId);
    const next: ParallelLane = {
      ...current,
      ...patch,
      updatedAt: now(),
    };
    this.database.transaction(() => {
      this.db.prepare(`UPDATE parallel_lanes SET
        plan_id = ?, role = ?, provider = ?, status = ?, branch_name = ?, worktree_path = ?,
        base_head = ?, base_branch = ?, run_id = ?, result_head = ?, changed_files_json = ?,
        scope_paths_json = ?, target_head = ?, integration_commit = ?, approval_id = ?,
        validation_json = ?, error = ?, updated_at = ? WHERE id = ?`).run(
        next.planId, next.role, next.provider, next.status, next.branchName, next.worktreePath,
        next.baseHead, next.baseBranch, next.runId, next.resultHead, JSON.stringify(next.changedFiles),
        JSON.stringify(next.scopePaths), next.targetHead, next.integrationCommit, next.approvalId,
        JSON.stringify(next.validation), next.error, next.updatedAt, next.id,
      );
      if (current.status !== next.status) {
        this.event(next.projectId, next.taskId, 'parallel.lane_status_changed', {
          laneId: next.id, from: current.status, to: next.status, error: next.error,
        });
      }
    });
    return this.get(laneId);
  }

  recoverStartupStates(): number {
    const rows = this.db.prepare(`
      SELECT l.* FROM parallel_lanes l
      LEFT JOIN runs r ON r.id = l.run_id
      WHERE l.status IN ('PREPARING','INTEGRATING')
         OR (l.status = 'WORKING' AND r.status = 'interrupted')
    `).all() as Row[];
    for (const row of rows) {
      const lane = this.lane(row);
      this.update(lane.id, {
        status: 'RECOVERY_REQUIRED',
        error: lane.status === 'WORKING'
          ? 'Worker process stopped while the Core Run was active'
          : `Process stopped while lane was ${lane.status}`,
      });
    }
    return rows.length;
  }

  state(projectId: string): ParallelState {
    const lanes = this.list(projectId);
    return {
      projectId,
      lanes,
      active: lanes.filter(lane => !['COMPLETED','FAILED','RELEASED'].includes(lane.status)).length,
      awaitingIntegration: lanes.filter(lane => lane.status === 'REVIEW' || lane.status === 'APPROVAL_PENDING').length,
      completed: lanes.filter(lane => lane.status === 'COMPLETED' || lane.status === 'RELEASED').length,
    };
  }
}
