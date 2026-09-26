import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CoreDatabase } from '../core/database.js';
import { CoreError } from '../core/domain.js';
import {
  ASSURANCE_KINDS, ASSURANCE_RESULTS, ASSURANCE_STATUSES, RECOVERY_SOURCE_KINDS,
  type AssuranceCheck, type AssuranceKind, type AssuranceResult, type AssuranceRun,
  type AssuranceRunDetail, type AssuranceState, type AssuranceStatus, type RecoveryIncident,
  type RecoveryIncidentStatus, type RecoverySourceKind,
} from './types.js';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const id = (): string => randomUUID();
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new CoreError('NOT_FOUND', `${label} not found`);
  return value;
};
const oneOf = <T extends string>(value: string, values: readonly T[], label: string): T => {
  if (!values.includes(value as T)) throw new CoreError('INVALID_INPUT', `Invalid ${label}: ${value}`);
  return value as T;
};

export class AssuranceStore {
  private readonly db: DatabaseSync;
  constructor(private readonly database: CoreDatabase) { this.db = database.db; }

  private event(projectId: string, type: string, payload: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id(), projectId, null, null, type, JSON.stringify(payload), now(),
    );
  }

  private runRow(row: Row): AssuranceRun {
    return {
      id: String(row.id), projectId: String(row.project_id), kind: row.kind as AssuranceKind,
      status: row.status as AssuranceStatus,
      baseHead: row.base_head === null ? null : String(row.base_head),
      baseBranch: row.base_branch === null ? null : String(row.base_branch),
      summary: parse<Record<string, unknown>>(row.summary_json),
      createdAt: String(row.created_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
    };
  }

  private checkRow(row: Row): AssuranceCheck {
    return {
      id: String(row.id), runId: String(row.run_id), checkKey: String(row.check_key),
      category: row.category as AssuranceKind,
      severity: row.severity as AssuranceCheck['severity'],
      result: row.result as AssuranceResult,
      detail: String(row.detail),
      evidence: parse<Record<string, unknown>>(row.evidence_json),
      checkedAt: String(row.checked_at),
    };
  }

  private incidentRow(row: Row): RecoveryIncident {
    return {
      id: String(row.id), projectId: String(row.project_id),
      sourceKind: row.source_kind as RecoverySourceKind, sourceId: String(row.source_id),
      status: row.status as RecoveryIncidentStatus, action: String(row.action),
      evidence: parse<Record<string, unknown>>(row.evidence_json),
      detectedAt: String(row.detected_at), updatedAt: String(row.updated_at),
      resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
    };
  }

  createRun(projectId: string, kind: AssuranceKind, baseHead: string | null, baseBranch: string | null): AssuranceRun {
    oneOf(kind, ASSURANCE_KINDS, 'assurance kind');
    const timestamp = now();
    const run: AssuranceRun = {
      id: id(), projectId, kind, status: 'RUNNING', baseHead, baseBranch,
      summary: {}, createdAt: timestamp, completedAt: null,
    };
    this.db.prepare('INSERT INTO assurance_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      run.id, run.projectId, run.kind, run.status, run.baseHead, run.baseBranch,
      JSON.stringify(run.summary), run.createdAt, null,
    );
    this.event(projectId, 'assurance.run_started', { runId: run.id, kind });
    return run;
  }

  getRun(runId: string): AssuranceRun {
    return this.runRow(required(this.db.prepare('SELECT * FROM assurance_runs WHERE id = ?').get(runId) as Row | undefined, 'Assurance run'));
  }

  addCheck(
    runId: string,
    input: {
      checkKey: string;
      category: AssuranceKind;
      severity: AssuranceCheck['severity'];
      result: AssuranceResult;
      detail: string;
      evidence?: Record<string, unknown>;
    },
  ): AssuranceCheck {
    oneOf(input.category, ASSURANCE_KINDS, 'assurance category');
    oneOf(input.result, ASSURANCE_RESULTS, 'assurance result');
    const run = this.getRun(runId);
    if (run.status !== 'RUNNING') throw new CoreError('INVALID_TRANSITION', 'Assurance run is already finished');
    const check: AssuranceCheck = {
      id: id(), runId, checkKey: input.checkKey.trim().slice(0, 200),
      category: input.category, severity: input.severity, result: input.result,
      detail: input.detail.slice(0, 4000), evidence: input.evidence ?? {}, checkedAt: now(),
    };
    this.db.prepare('INSERT INTO assurance_checks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      check.id, check.runId, check.checkKey, check.category, check.severity, check.result,
      check.detail, JSON.stringify(check.evidence), check.checkedAt,
    );
    return check;
  }

  checks(runId: string): AssuranceCheck[] {
    this.getRun(runId);
    return (this.db.prepare('SELECT * FROM assurance_checks WHERE run_id = ? ORDER BY checked_at, rowid').all(runId) as Row[])
      .map(row => this.checkRow(row));
  }

  finish(runId: string, status: AssuranceStatus, summary: Record<string, unknown>): AssuranceRunDetail {
    oneOf(status, ASSURANCE_STATUSES, 'assurance status');
    if (status === 'RUNNING') throw new CoreError('INVALID_TRANSITION', 'Cannot finish assurance run as RUNNING');
    const current = this.getRun(runId);
    if (current.status !== 'RUNNING') throw new CoreError('INVALID_TRANSITION', 'Assurance run is already finished');
    const completedAt = now();
    this.db.prepare('UPDATE assurance_runs SET status = ?, summary_json = ?, completed_at = ? WHERE id = ?').run(
      status, JSON.stringify(summary), completedAt, runId,
    );
    this.event(current.projectId, 'assurance.run_completed', { runId, kind: current.kind, status });
    return { run: this.getRun(runId), checks: this.checks(runId) };
  }

  latest(projectId: string, kind: AssuranceKind): AssuranceRunDetail | null {
    const row = this.db.prepare(
      'SELECT * FROM assurance_runs WHERE project_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).get(projectId, kind) as Row | undefined;
    if (!row) return null;
    const run = this.runRow(row);
    return { run, checks: this.checks(run.id) };
  }

  incidents(projectId: string): RecoveryIncident[] {
    return (this.db.prepare('SELECT * FROM recovery_incidents WHERE project_id = ? ORDER BY detected_at, rowid').all(projectId) as Row[])
      .map(row => this.incidentRow(row));
  }

  syncIncident(input: {
    projectId: string;
    sourceKind: RecoverySourceKind;
    sourceId: string;
    active: boolean;
    blocked: boolean;
    action: string;
    evidence?: Record<string, unknown>;
  }): RecoveryIncident | null {
    oneOf(input.sourceKind, RECOVERY_SOURCE_KINDS, 'recovery source kind');
    const existingRow = this.db.prepare(
      'SELECT * FROM recovery_incidents WHERE project_id = ? AND source_kind = ? AND source_id = ?',
    ).get(input.projectId, input.sourceKind, input.sourceId) as Row | undefined;
    const timestamp = now();
    if (!input.active) {
      if (!existingRow) return null;
      const existing = this.incidentRow(existingRow);
      if (existing.status !== 'RESOLVED') {
        this.db.prepare('UPDATE recovery_incidents SET status = ?, updated_at = ?, resolved_at = ? WHERE id = ?').run(
          'RESOLVED', timestamp, timestamp, existing.id,
        );
        this.event(input.projectId, 'recovery.incident_resolved', {
          incidentId: existing.id, sourceKind: existing.sourceKind, sourceId: existing.sourceId,
        });
      }
      const row = this.db.prepare('SELECT * FROM recovery_incidents WHERE id = ?').get(existing.id) as Row;
      return this.incidentRow(row);
    }

    const status: RecoveryIncidentStatus = input.blocked ? 'BLOCKED' : 'OPEN';
    if (!existingRow) {
      const incident: RecoveryIncident = {
        id: id(), projectId: input.projectId, sourceKind: input.sourceKind, sourceId: input.sourceId,
        status, action: input.action.slice(0, 4000), evidence: input.evidence ?? {},
        detectedAt: timestamp, updatedAt: timestamp, resolvedAt: null,
      };
      this.db.prepare('INSERT INTO recovery_incidents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        incident.id, incident.projectId, incident.sourceKind, incident.sourceId, incident.status,
        incident.action, JSON.stringify(incident.evidence), incident.detectedAt, incident.updatedAt, null,
      );
      this.event(input.projectId, 'recovery.incident_detected', {
        incidentId: incident.id, sourceKind: incident.sourceKind, sourceId: incident.sourceId, status,
      });
      return incident;
    }

    const existing = this.incidentRow(existingRow);
    this.db.prepare(`UPDATE recovery_incidents SET
      status = ?, action = ?, evidence_json = ?, updated_at = ?, resolved_at = NULL WHERE id = ?`).run(
      status, input.action.slice(0, 4000), JSON.stringify(input.evidence ?? {}), timestamp, existing.id,
    );
    const row = this.db.prepare('SELECT * FROM recovery_incidents WHERE id = ?').get(existing.id) as Row;
    return this.incidentRow(row);
  }

  state(projectId: string): AssuranceState {
    return {
      projectId,
      latestSecurity: this.latest(projectId, 'SECURITY'),
      latestRecovery: this.latest(projectId, 'RECOVERY'),
      latestQa: this.latest(projectId, 'QA'),
      incidents: this.incidents(projectId),
    };
  }
}
