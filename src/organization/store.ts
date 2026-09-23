import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CoreDatabase } from '../core/database.js';
import { CoreError, nonEmpty, type Task, type TaskStatus } from '../core/domain.js';
import {
  GATE_KINDS, GATE_RESULTS, ORGANIZATION_PROVIDERS, ORGANIZATION_ROLES, PLAN_STAGES,
  type GateKind, type GateResult, type OrganizationAssignment, type OrganizationDependency,
  type OrganizationGate, type OrganizationPlan, type OrganizationProvider, type OrganizationRole,
  type PlanStage, type PlanStatus,
} from './types.js';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const id = (): string => randomUUID();
const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new CoreError('NOT_FOUND', `${label} not found`);
  return value;
};
const oneOf = <T extends string>(value: string, values: readonly T[], label: string): T => {
  if (!values.includes(value as T)) throw new CoreError('INVALID_INPUT', `Invalid ${label}: ${value}`);
  return value as T;
};

export interface StoredPlanTask {
  id: string;
  title: string;
  description: string;
  role: OrganizationRole;
  provider: OrganizationProvider;
  priority: number;
  dependencyIds: string[];
}

export class OrganizationStore {
  private readonly db: DatabaseSync;
  constructor(private readonly database: CoreDatabase) { this.db = database.db; }

  private event(projectId: string, type: string, payload: Record<string, unknown>, taskId: string | null = null): void {
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id(), projectId, taskId, null, type, JSON.stringify(payload), now(),
    );
  }

  private plan(row: Row): OrganizationPlan {
    return {
      id: String(row.id), projectId: String(row.project_id), objective: String(row.objective),
      status: row.status as PlanStatus, stage: row.stage as PlanStage,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private assignment(row: Row): OrganizationAssignment {
    return {
      taskId: String(row.task_id), planId: String(row.plan_id), role: row.role as OrganizationRole,
      priority: Number(row.priority), provider: row.provider as OrganizationProvider,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  create(projectId: string, objective: string, tasks: StoredPlanTask[]): OrganizationPlan {
    const timestamp = now();
    const plan: OrganizationPlan = {
      id: id(), projectId, objective: nonEmpty(objective, 'objective', 20_000),
      status: 'draft', stage: 'planning', createdAt: timestamp, updatedAt: timestamp,
    };
    this.database.transaction(() => {
      this.db.prepare('INSERT INTO organization_plans VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        plan.id, plan.projectId, plan.objective, plan.status, plan.stage, plan.createdAt, plan.updatedAt,
      );
      for (const item of tasks) {
        this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          item.id, projectId, item.title, item.description, 'queued', 1, timestamp, timestamp,
        );
        this.db.prepare('INSERT INTO organization_assignments VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          item.id, plan.id, item.role, item.priority, item.provider, timestamp, timestamp,
        );
        this.event(projectId, 'task.created', { title: item.title }, item.id);
        this.event(projectId, 'organization.task_assigned', {
          planId: plan.id, role: item.role, provider: item.provider, priority: item.priority,
        }, item.id);
      }
      for (const item of tasks) for (const dependencyId of item.dependencyIds) {
        this.db.prepare('INSERT INTO organization_dependencies VALUES (?, ?)').run(item.id, dependencyId);
      }
      this.event(projectId, 'organization.plan_created', { planId: plan.id, objective: plan.objective, taskCount: tasks.length });
    });
    return this.get(plan.id);
  }

  get(planId: string): OrganizationPlan {
    return this.plan(required(this.db.prepare('SELECT * FROM organization_plans WHERE id = ?').get(planId) as Row | undefined, 'Organization plan'));
  }

  latest(projectId: string): OrganizationPlan | null {
    const row = this.db.prepare('SELECT * FROM organization_plans WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(projectId) as Row | undefined;
    return row ? this.plan(row) : null;
  }

  listAssignments(planId: string): OrganizationAssignment[] {
    this.get(planId);
    return (this.db.prepare('SELECT * FROM organization_assignments WHERE plan_id = ? ORDER BY priority, created_at, task_id').all(planId) as Row[]).map(row => this.assignment(row));
  }

  assignment(taskId: string): OrganizationAssignment | null {
    const row = this.db.prepare('SELECT * FROM organization_assignments WHERE task_id = ?').get(taskId) as Row | undefined;
    return row ? this.assignment(row) : null;
  }

  dependencies(taskId: string): OrganizationDependency[] {
    return (this.db.prepare('SELECT * FROM organization_dependencies WHERE task_id = ? ORDER BY depends_on_task_id').all(taskId) as Row[]).map(row => ({
      taskId: String(row.task_id), dependsOnTaskId: String(row.depends_on_task_id),
    }));
  }

  private task(row: Row): Task {
    return {
      id: String(row.id), projectId: String(row.project_id), title: String(row.title),
      description: String(row.description), status: row.status as TaskStatus, version: Number(row.version),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  planTasks(planId: string): Task[] {
    this.get(planId);
    return (this.db.prepare(
      'SELECT t.* FROM tasks t JOIN organization_assignments a ON a.task_id = t.id WHERE a.plan_id = ? ORDER BY a.priority, t.created_at, t.id',
    ).all(planId) as Row[]).map(row => this.task(row));
  }

  dependenciesSatisfied(taskId: string): boolean {
    const rows = this.db.prepare(
      `SELECT t.status FROM organization_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id WHERE d.task_id = ?`,
    ).all(taskId) as Row[];
    return rows.every(row => row.status === 'passed');
  }

  refreshReady(planId: string): Task[] {
    const plan = this.get(planId);
    if (plan.status !== 'active' || plan.stage !== 'execution') return [];
    const ready: Task[] = [];
    this.database.transaction(() => {
      for (const task of this.planTasks(planId)) {
        if (task.status !== 'queued' || !this.dependenciesSatisfied(task.id)) continue;
        const timestamp = now();
        this.db.prepare("UPDATE tasks SET status = 'ready', version = version + 1, updated_at = ? WHERE id = ?").run(timestamp, task.id);
        const updated = this.task(required(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Row | undefined, 'Task'));
        ready.push(updated);
        const assignment = this.assignment(task.id);
        this.event(plan.projectId, 'organization.task_ready', {
          planId, role: assignment?.role ?? null, provider: assignment?.provider ?? null,
        }, task.id);
        if (assignment) this.event(plan.projectId, 'organization.role_activated', { planId, role: assignment.role }, task.id);
      }
    });
    return ready;
  }

  setPlan(planId: string, status: PlanStatus, stage: PlanStage): OrganizationPlan {
    oneOf(stage, PLAN_STAGES, 'plan stage');
    const plan = this.get(planId);
    const timestamp = now();
    this.database.transaction(() => {
      this.db.prepare('UPDATE organization_plans SET status = ?, stage = ?, updated_at = ? WHERE id = ?').run(status, stage, timestamp, planId);
      this.event(plan.projectId, 'organization.stage_changed', { planId, from: plan.stage, to: stage, status });
    });
    return this.get(planId);
  }

  addGate(planId: string, kind: string, result: string, summary: string, evidence: string): OrganizationGate {
    const plan = this.get(planId);
    const gate: OrganizationGate = {
      id: id(), planId, projectId: plan.projectId,
      kind: oneOf(kind, GATE_KINDS, 'gate kind'),
      result: oneOf(result, GATE_RESULTS, 'gate result'),
      summary: nonEmpty(summary, 'summary', 4000), evidence: evidence.trim().slice(0, 20_000), createdAt: now(),
    };
    this.database.transaction(() => {
      this.db.prepare('INSERT INTO organization_gates VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        gate.id, gate.planId, gate.projectId, gate.kind, gate.result, gate.summary, gate.evidence, gate.createdAt,
      );
      this.event(plan.projectId, `organization.${gate.kind}_completed`, {
        planId, result: gate.result, summary: gate.summary,
      });
    });
    return gate;
  }

  gates(planId: string): OrganizationGate[] {
    this.get(planId);
    return (this.db.prepare('SELECT * FROM organization_gates WHERE plan_id = ? ORDER BY created_at, rowid').all(planId) as Row[]).map(row => ({
      id: String(row.id), planId: String(row.plan_id), projectId: String(row.project_id),
      kind: row.kind as GateKind, result: row.result as GateResult, summary: String(row.summary),
      evidence: String(row.evidence), createdAt: String(row.created_at),
    }));
  }

  latestGate(planId: string, kind: GateKind): OrganizationGate | null {
    return [...this.gates(planId)].reverse().find(item => item.kind === kind) ?? null;
  }

  validateRole(value: string): OrganizationRole { return oneOf(value, ORGANIZATION_ROLES, 'organization role'); }
  validateProvider(value: string): OrganizationProvider { return oneOf(value, ORGANIZATION_PROVIDERS, 'organization provider'); }
}
