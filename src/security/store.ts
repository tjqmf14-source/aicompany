import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CoreDatabase } from '../core/database.js';
import { CoreError } from '../core/domain.js';
import { testEvidenceFailure } from '../core/qa-evidence.js';
import { redactSensitive } from '../core/redaction.js';
import type {
  QaCheck, QaRun, QaRunStatus, SecurityAudit, SecurityAuditStatus, SecurityCheck,
} from './types.js';

type Row = Record<string, unknown>;
const id = (): string => randomUUID();
const now = (): string => new Date().toISOString();
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new CoreError('NOT_FOUND', `${label} not found`);
  return value;
};

export class SecurityStore {
  private readonly db: DatabaseSync;
  constructor(private readonly database: CoreDatabase) { this.db = database.db; }

  private event(projectId: string, type: string, payload: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id(), projectId, null, null, type, JSON.stringify(payload), now(),
    );
  }

  private audit(row: Row): SecurityAudit {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      status: row.status as SecurityAuditStatus,
      checks: parse<SecurityCheck[]>(row.checks_json),
      createdAt: String(row.created_at),
    };
  }

  addAudit(projectId: string, status: SecurityAuditStatus, checks: SecurityCheck[]): SecurityAudit {
    const audit: SecurityAudit = { id: id(), projectId, status, checks, createdAt: now() };
    this.database.transaction(() => {
      this.db.prepare('INSERT INTO security_audits VALUES (?, ?, ?, ?, ?)').run(
        audit.id, audit.projectId, audit.status, JSON.stringify(audit.checks), audit.createdAt,
      );
      this.event(projectId, 'security.audit_completed', {
        auditId: audit.id, status: audit.status,
        failCount: checks.filter(item => item.status === 'FAIL' || item.status === 'BLOCKED').length,
      });
    });
    return audit;
  }

  listAudits(projectId: string): SecurityAudit[] {
    return (this.db.prepare('SELECT * FROM security_audits WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as Row[])
      .map(row => this.audit(row));
  }

  latestAudit(projectId: string): SecurityAudit | null {
    const row = this.db.prepare('SELECT * FROM security_audits WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(projectId) as Row | undefined;
    return row ? this.audit(row) : null;
  }

  private qa(row: Row): QaRun {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      status: row.status as QaRunStatus,
      baseHead: row.base_head === null ? null : String(row.base_head),
      baseBranch: row.base_branch === null ? null : String(row.base_branch),
      checks: parse<QaCheck[]>(row.checks_json),
      error: row.error === null ? null : String(row.error),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
    };
  }

  startQa(projectId: string, baseHead: string | null, baseBranch: string | null): QaRun {
    const current = this.db.prepare("SELECT id FROM qa_runs WHERE project_id = ? AND status = 'RUNNING' LIMIT 1").get(projectId) as Row | undefined;
    if (current) throw new CoreError('CONFLICT', 'A QA run is already active for this project');
    const run: QaRun = {
      id: id(), projectId, status: 'RUNNING', baseHead, baseBranch,
      checks: [], error: null, startedAt: now(), finishedAt: null,
    };
    this.database.transaction(() => {
      this.db.prepare('INSERT INTO qa_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        run.id, run.projectId, run.status, run.baseHead, run.baseBranch,
        JSON.stringify(run.checks), run.error, run.startedAt, run.finishedAt,
      );
      this.event(projectId, 'qa.run_started', { qaRunId: run.id, baseHead, baseBranch });
    });
    return run;
  }

  finishQa(runId: string, status: 'PASS' | 'FAIL', checks: QaCheck[], error: string | null): QaRun {
    const current = this.getQa(runId);
    if (current.status !== 'RUNNING') throw new CoreError('INVALID_TRANSITION', 'QA run is not running');
    const finishedAt = now();
    const names = ['git_diff_check', 'typecheck', 'lint', 'test', 'build', 'npm_audit'];
    if (status === 'PASS' && (checks.length !== names.length
      || names.some(name => checks.filter(check => check.name === name && check.status === 'PASS' && check.exitCode === 0).length !== 1)
      || testEvidenceFailure(checks.find(check => check.name === 'test')?.output ?? ''))) {
      status = 'FAIL';
      error = 'Incomplete or invalid QA evidence cannot be PASS';
    }
    checks = checks.map(check => ({ ...check, output: redactSensitive(check.output) }));
    error = error === null ? null : redactSensitive(error);
    this.database.transaction(() => {
      const updated = this.db.prepare("UPDATE qa_runs SET status = ?, checks_json = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'RUNNING'").run(
        status, JSON.stringify(checks), error, finishedAt, runId,
      );
      if (updated.changes !== 1) throw new CoreError('CONFLICT', 'QA state changed before completion');
      this.event(current.projectId, 'qa.run_finished', {
        qaRunId: runId, status,
        checks: checks.map(item => ({ name: item.name, status: item.status })),
      });
    });
    return this.getQa(runId);
  }

  saveProgress(runId: string, checks: QaCheck[]): void {
    this.database.transaction(() => {
      const current = this.getQa(runId);
      const safeChecks = checks.map(check => ({ ...check, output: redactSensitive(check.output) }));
      const updated = this.db.prepare("UPDATE qa_runs SET checks_json = ? WHERE id = ? AND status = 'RUNNING'")
        .run(JSON.stringify(safeChecks), runId);
      if (updated.changes !== 1) throw new CoreError('CONFLICT', 'QA state changed before progress was saved');
      this.event(current.projectId, 'qa.check_completed', { qaRunId: runId, check: safeChecks.at(-1)?.name, status: safeChecks.at(-1)?.status });
    });
  }

  getQa(runId: string): QaRun {
    return this.qa(required(this.db.prepare('SELECT * FROM qa_runs WHERE id = ?').get(runId) as Row | undefined, 'QA run'));
  }

  listQa(projectId: string): QaRun[] {
    return (this.db.prepare('SELECT * FROM qa_runs WHERE project_id = ? ORDER BY started_at, rowid').all(projectId) as Row[])
      .map(row => this.qa(row));
  }

  latestQa(projectId: string): QaRun | null {
    const row = this.db.prepare('SELECT * FROM qa_runs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(projectId) as Row | undefined;
    return row ? this.qa(row) : null;
  }

  recoverRunningQa(): number {
    const rows = this.db.prepare("SELECT id, project_id FROM qa_runs WHERE status = 'RUNNING'").all() as { id: string; project_id: string }[];
    const timestamp = now();
    for (const row of rows) {
      this.database.transaction(() => {
        const updated = this.db.prepare("UPDATE qa_runs SET status = 'INTERRUPTED', error = ?, finished_at = ? WHERE id = ? AND status = 'RUNNING'").run(
          'Process stopped before QA completed', timestamp, row.id,
        );
        if (updated.changes === 1) this.event(row.project_id, 'qa.run_interrupted', { qaRunId: row.id, reason: 'startup_recovery' });
      });
    }
    return rows.length;
  }
}
