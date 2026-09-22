import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CoreDatabase } from '../core/database.js';
import { CoreError } from '../core/domain.js';
import type { HighResponse, ClassifiedCommand } from './schema.js';
import type { PatchTarget } from './patch.js';

export type HandoffStatus = 'awaiting_response' | 'ready_to_apply' | 'applying' | 'verified' | 'failed' | 'recovery_required';
export interface Preview {
  baseHead: string | null;
  baseBranch: string | null;
  preflightCheckpointId: string;
  targets: PatchTarget[];
  diff: string;
  commands: ClassifiedCommand[];
  dryRun: 'PASS';
}
export interface FileBackup { path: string; existed: boolean; sha256: string | null; contentBase64: string | null; appliedSha256: string | null }
export interface HandoffCheckpoint { gitCheckpointId: string; head: string | null; branch: string | null; scripts: Record<string, string>; files: FileBackup[]; createdAt: string }
export interface CheckResult { command: string; status: 'PASS' | 'FAIL'; exitCode: number | null; output: string }
export interface HandoffVerification { results: CheckResult[]; rollback: 'NOT_NEEDED' | 'PASS' | 'REQUIRES_USER'; codexTaskIds: string[] }
export interface HandoffSession {
  id: string; projectId: string; taskId: string | null; provider: string; status: HandoffStatus;
  objective: string; bundlePath: string; baseHead: string | null; baseBranch: string | null;
  response: HighResponse | null; preview: Preview | null; checkpoint: HandoffCheckpoint | null;
  verification: HandoffVerification | null; error: string | null; createdAt: string; updatedAt: string;
}
type Row = Record<string, unknown>;
const parse = <T>(value: unknown): T | null => value === null ? null : JSON.parse(String(value)) as T;

export class HandoffStore {
  private readonly db: DatabaseSync;
  constructor(private readonly database: CoreDatabase) { this.db = database.db; }

  private event(session: HandoffSession, type: string, payload: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), session.projectId, session.taskId, null, type, JSON.stringify({ handoffId: session.id, ...payload }), new Date().toISOString());
  }
  private fromRow(row: Row): HandoffSession {
    return {
      id: String(row.id), projectId: String(row.project_id), taskId: row.task_id as string | null,
      provider: String(row.provider), status: row.status as HandoffStatus,
      objective: String(row.objective), bundlePath: String(row.bundle_path), baseHead: row.base_head as string | null, baseBranch: row.base_branch as string | null,
      response: parse<HighResponse>(row.response_json), preview: parse<Preview>(row.preview_json),
      checkpoint: parse<HandoffCheckpoint>(row.checkpoint_json), verification: parse<HandoffVerification>(row.verification_json),
      error: row.error as string | null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
  get(handoffId: string): HandoffSession {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE id = ?').get(handoffId) as Row | undefined;
    if (!row) throw new CoreError('NOT_FOUND', 'Handoff not found');
    return this.fromRow(row);
  }
  list(projectId: string): HandoffSession[] {
    return (this.db.prepare('SELECT * FROM handoffs WHERE project_id = ? ORDER BY created_at, id').all(projectId) as Row[]).map(row => this.fromRow(row));
  }
  create(input: Omit<HandoffSession, 'status' | 'response' | 'preview' | 'checkpoint' | 'verification' | 'error' | 'createdAt' | 'updatedAt'>): HandoffSession {
    const timestamp = new Date().toISOString();
    const session: HandoffSession = { ...input, status: 'awaiting_response', response: null, preview: null, checkpoint: null, verification: null, error: null, createdAt: timestamp, updatedAt: timestamp };
    this.database.transaction(() => {
      this.db.prepare('INSERT INTO handoffs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        session.id, session.projectId, session.taskId, session.provider, session.status, session.objective,
        session.bundlePath, session.baseHead, session.baseBranch, null, null, null, null, null, timestamp, timestamp,
      );
      this.event(session, 'handoff.created', { provider: session.provider });
    });
    return session;
  }
  update(handoffId: string, expectedStatus: HandoffStatus, status: HandoffStatus, fields: Partial<Pick<HandoffSession, 'response' | 'preview' | 'checkpoint' | 'verification' | 'error'>> = {}): HandoffSession {
    return this.database.transaction(() => {
      const current = this.get(handoffId);
      if (current.status !== expectedStatus) throw new CoreError('CONFLICT', `Handoff is ${current.status}, expected ${expectedStatus}`);
      const next = { ...current, ...fields, status, updatedAt: new Date().toISOString() };
      this.db.prepare(`UPDATE handoffs SET status = ?, response_json = ?, preview_json = ?, checkpoint_json = ?, verification_json = ?, error = ?, updated_at = ? WHERE id = ?`).run(
        next.status, next.response === null ? null : JSON.stringify(next.response), next.preview === null ? null : JSON.stringify(next.preview),
        next.checkpoint === null ? null : JSON.stringify(next.checkpoint), next.verification === null ? null : JSON.stringify(next.verification),
        next.error, next.updatedAt, handoffId,
      );
      this.event(next, 'handoff.status_changed', { from: current.status, to: status });
      return next;
    });
  }
  importValidated(handoffId: string, response: HighResponse, preview: Preview): HandoffSession {
    return this.database.transaction(() => {
      const current = this.get(handoffId);
      if (current.status !== 'awaiting_response') throw new CoreError('CONFLICT', 'Handoff already has a response');
      const timestamp = new Date().toISOString();
      for (const command of preview.commands) {
        if (command.risk !== 'DANGEROUS') continue;
        const approvalId = randomUUID();
        command.approvalId = approvalId;
        this.db.prepare('INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          approvalId, current.projectId, current.taskId, `Proposed command for review: ${command.command}`, 'pending', timestamp, null,
        );
        this.event(current, 'approval.requested', { approvalId, source: 'handoff_command' });
      }
      this.db.prepare('UPDATE handoffs SET status = ?, response_json = ?, preview_json = ?, updated_at = ? WHERE id = ?').run(
        'ready_to_apply', JSON.stringify(response), JSON.stringify(preview), timestamp, handoffId,
      );
      this.event(current, 'handoff.status_changed', { from: current.status, to: 'ready_to_apply' });
      return this.get(handoffId);
    });
  }
  recoverApplying(): number {
    const rows = this.db.prepare("SELECT id FROM handoffs WHERE status = 'applying'").all() as { id: string }[];
    for (const row of rows) this.update(row.id, 'applying', 'recovery_required', { error: 'Process stopped during patch or validation; inspect and roll back safely' });
    return rows.length;
  }

  finalizeVerified(handoffId: string, results: CheckResult[]): HandoffSession {
    return this.database.transaction(() => {
      const current = this.get(handoffId);
      if (current.status !== 'applying' || !current.response) throw new CoreError('CONFLICT', 'Handoff is not ready to finalize');
      const timestamp = new Date().toISOString();
      const taskIds: string[] = [];
      for (const spec of current.response.codexTasks) {
        const taskId = randomUUID();
        const description = `${spec.description}\n\nAcceptance criteria:\n${spec.acceptanceCriteria.map(item => `- ${item}`).join('\n')}\n\nSource handoff: ${handoffId}`;
        this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(taskId, current.projectId, spec.title, description, 'queued', 1, timestamp, timestamp);
        taskIds.push(taskId);
        this.event(current, 'task.created', { taskId, source: 'handoff' });
      }
      for (const decision of current.response.decisions.filter(item => item.trim())) {
        const decisionId = randomUUID();
        this.db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?)').run(decisionId, current.projectId, current.taskId, decision.trim(), `Imported from handoff ${handoffId}`, timestamp);
        this.event(current, 'decision.added', { decisionId, source: 'handoff' });
      }
      const verification: HandoffVerification = { results, rollback: 'NOT_NEEDED', codexTaskIds: taskIds };
      this.db.prepare('UPDATE handoffs SET status = ?, verification_json = ?, updated_at = ? WHERE id = ?').run('verified', JSON.stringify(verification), timestamp, handoffId);
      this.event(current, 'handoff.verified', { codexTaskIds: taskIds });
      return this.get(handoffId);
    });
  }
}
