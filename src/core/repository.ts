import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CoreDatabase } from './database.js';
import {
  APPROVAL_STATUSES, CAPABILITY_STATUSES, CoreError, PROJECT_STATUSES, TASK_STATUSES,
  assertOneOf, nonEmpty, projectTransitions, taskTransitions,
  type Approval, type Artifact, type Capability, type Checkpoint, type Decision,
  type Event, type GitSnapshot, type Project, type ProjectStatus, type Run,
  type Task, type TaskStatus,
} from './domain.js';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const id = (): string => randomUUID();
const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new CoreError('NOT_FOUND', `${label} not found`);
  return value;
};
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

export class CoreRepository {
  private readonly db: DatabaseSync;
  constructor(private readonly database: CoreDatabase) { this.db = database.db; }

  private event(projectId: string, type: string, payload: Record<string, unknown>, taskId: string | null = null, runId: string | null = null): Event {
    const event: Event = { id: id(), projectId, taskId, runId, type, payload, createdAt: now() };
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(event.id, event.projectId, event.taskId, event.runId, event.type, JSON.stringify(payload), event.createdAt);
    return event;
  }

  createProject(name: string, rootPath: string): Project {
    const timestamp = now();
    const project: Project = { id: id(), name: nonEmpty(name, 'name', 200), rootPath, status: 'draft', version: 1, createdAt: timestamp, updatedAt: timestamp };
    this.database.transaction(() => {
      this.db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)').run(project.id, project.name, project.rootPath, project.status, project.version, project.createdAt, project.updatedAt);
      this.event(project.id, 'project.created', { status: project.status });
    });
    return project;
  }

  private project(row: Row): Project {
    return { id: String(row.id), name: String(row.name), rootPath: String(row.root_path), status: row.status as ProjectStatus, version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }
  getProject(projectId: string): Project {
    return this.project(required(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Row | undefined, 'Project'));
  }
  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at, id').all() as Row[]).map(row => this.project(row));
  }
  setProjectStatus(projectId: string, status: string, expectedVersion?: number): Project {
    const next = assertOneOf(status, PROJECT_STATUSES, 'project status');
    return this.database.transaction(() => {
      const current = this.getProject(projectId);
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw new CoreError('CONFLICT', 'Stale project version');
      if (!projectTransitions[current.status].includes(next)) throw new CoreError('INVALID_TRANSITION', `${current.status} -> ${next}`);
      this.db.prepare('UPDATE projects SET status = ?, version = version + 1, updated_at = ? WHERE id = ?').run(next, now(), projectId);
      this.event(projectId, 'project.status_changed', { from: current.status, to: next });
      return this.getProject(projectId);
    });
  }

  createTask(projectId: string, title: string, description = ''): Task {
    this.getProject(projectId);
    const timestamp = now();
    const task: Task = { id: id(), projectId, title: nonEmpty(title, 'title', 300), description, status: 'queued', version: 1, createdAt: timestamp, updatedAt: timestamp };
    this.database.transaction(() => {
      this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(task.id, task.projectId, task.title, task.description, task.status, task.version, task.createdAt, task.updatedAt);
      this.event(projectId, 'task.created', { title: task.title }, task.id);
    });
    return task;
  }
  private task(row: Row): Task {
    return { id: String(row.id), projectId: String(row.project_id), title: String(row.title), description: String(row.description), status: row.status as TaskStatus, version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }
  getTask(taskId: string): Task {
    return this.task(required(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined, 'Task'));
  }
  listTasks(projectId: string): Task[] {
    this.getProject(projectId);
    return (this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id').all(projectId) as Row[]).map(row => this.task(row));
  }
  setTaskStatus(taskId: string, status: string, expectedVersion?: number): Task {
    const next = assertOneOf(status, TASK_STATUSES, 'task status');
    return this.database.transaction(() => {
      const current = this.getTask(taskId);
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw new CoreError('CONFLICT', 'Stale task version');
      if (next === 'running') throw new CoreError('INVALID_TRANSITION', 'Start a Run to enter running state');
      if (!taskTransitions[current.status].includes(next)) throw new CoreError('INVALID_TRANSITION', `${current.status} -> ${next}`);
      if (current.status === 'running') {
        const active = this.db.prepare("SELECT id FROM runs WHERE task_id = ? AND status = 'running'").get(taskId) as Row | undefined;
        if (active) throw new CoreError('CONFLICT', 'Finish active run before changing task status');
      }
      this.db.prepare('UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ?').run(next, now(), taskId);
      this.event(current.projectId, 'task.status_changed', { from: current.status, to: next }, taskId);
      return this.getTask(taskId);
    });
  }

  private run(row: Row): Run {
    return { id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id), status: row.status as Run['status'], startedAt: String(row.started_at), finishedAt: row.finished_at === null ? null : String(row.finished_at), recoveredAt: row.recovered_at === null ? null : String(row.recovered_at), error: row.error === null ? null : String(row.error) };
  }
  getRun(runId: string): Run {
    return this.run(required(this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Row | undefined, 'Run'));
  }
  listRuns(taskId: string): Run[] {
    this.getTask(taskId);
    return (this.db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at, id').all(taskId) as Row[]).map(row => this.run(row));
  }
  startRun(taskId: string): Run {
    return this.database.transaction(() => {
      const task = this.getTask(taskId);
      if (task.status !== 'ready' && task.status !== 'waiting_provider') throw new CoreError('INVALID_TRANSITION', 'Task must be ready or waiting_provider');
      const run: Run = { id: id(), projectId: task.projectId, taskId, status: 'running', startedAt: now(), finishedAt: null, recoveredAt: null, error: null };
      this.db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(run.id, run.projectId, run.taskId, run.status, run.startedAt, null, null, null);
      this.db.prepare("UPDATE tasks SET status = 'running', version = version + 1, updated_at = ? WHERE id = ?").run(now(), taskId);
      this.event(task.projectId, 'run.started', {}, taskId, run.id);
      return run;
    });
  }
  finishRun(runId: string, result: 'completed' | 'failed' | 'cancelled', error: string | null = null): Run {
    return this.database.transaction(() => {
      const run = this.getRun(runId);
      if (run.status !== 'running') throw new CoreError('INVALID_TRANSITION', 'Run is not running');
      const taskStatus: TaskStatus = result === 'completed' ? 'reviewing' : result === 'failed' ? 'failed' : 'cancelled';
      this.db.prepare('UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?').run(result, now(), error, runId);
      this.db.prepare('UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ?').run(taskStatus, now(), run.taskId);
      this.event(run.projectId, 'run.finished', { result }, run.taskId, runId);
      return this.getRun(runId);
    });
  }
  recoverInterruptedRuns(): number {
    return this.database.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM runs WHERE status = 'running'").all() as Row[];
      for (const row of rows) {
        const run = this.run(row);
        const timestamp = now();
        this.db.prepare("UPDATE runs SET status = 'interrupted', recovered_at = ?, finished_at = ?, error = ? WHERE id = ?").run(timestamp, timestamp, 'Process stopped before completion', run.id);
        this.db.prepare("UPDATE tasks SET status = 'waiting_provider', version = version + 1, updated_at = ? WHERE id = ? AND status = 'running'").run(timestamp, run.taskId);
        this.event(run.projectId, 'run.interrupted', { reason: 'startup_recovery' }, run.taskId, run.id);
      }
      const orphanTasks = this.db.prepare("SELECT * FROM tasks WHERE status = 'running' AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.task_id = tasks.id AND runs.status = 'running')").all() as Row[];
      for (const row of orphanTasks) {
        const task = this.task(row);
        this.db.prepare("UPDATE tasks SET status = 'waiting_provider', version = version + 1, updated_at = ? WHERE id = ?").run(now(), task.id);
        this.event(task.projectId, 'task.recovered', { reason: 'orphan_running_state' }, task.id);
      }
      return rows.length;
    });
  }

  private assertRelations(projectId: string, taskId: string | null, runId: string | null): void {
    this.getProject(projectId);
    if (taskId && this.getTask(taskId).projectId !== projectId) throw new CoreError('INVALID_INPUT', 'Task belongs to another project');
    if (runId) {
      const run = this.getRun(runId);
      if (run.projectId !== projectId || (taskId && run.taskId !== taskId)) throw new CoreError('INVALID_INPUT', 'Run belongs to another task or project');
    }
  }
  addCheckpoint(projectId: string, snapshot: GitSnapshot, note = '', taskId: string | null = null, runId: string | null = null): Checkpoint {
    this.assertRelations(projectId, taskId, runId);
    const checkpoint: Checkpoint = { id: id(), projectId, taskId, runId, note, snapshot, createdAt: now() };
    this.database.transaction(() => {
      this.db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)').run(checkpoint.id, projectId, taskId, runId, note, JSON.stringify(snapshot), checkpoint.createdAt);
      this.event(projectId, 'checkpoint.captured', { dirty: snapshot.dirty, head: snapshot.head }, taskId, runId);
    });
    return checkpoint;
  }
  listCheckpoints(projectId: string): Checkpoint[] {
    this.getProject(projectId);
    return (this.db.prepare('SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at, id').all(projectId) as Row[]).map(row => ({ id: String(row.id), projectId: String(row.project_id), taskId: row.task_id as string | null, runId: row.run_id as string | null, note: String(row.note), snapshot: parse<GitSnapshot>(row.snapshot_json), createdAt: String(row.created_at) }));
  }
  addArtifact(projectId: string, relativePath: string, sha256: string, kind: string, taskId: string | null = null, runId: string | null = null): Artifact {
    this.assertRelations(projectId, taskId, runId);
    const artifact: Artifact = { id: id(), projectId, taskId, runId, relativePath, sha256, kind: nonEmpty(kind, 'kind', 100), createdAt: now() };
    this.database.transaction(() => {
      this.db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(artifact.id, projectId, taskId, runId, relativePath, sha256, artifact.kind, artifact.createdAt);
      this.event(projectId, 'artifact.added', { path: relativePath }, taskId, runId);
    });
    return artifact;
  }
  listArtifacts(projectId: string): Artifact[] {
    this.getProject(projectId);
    return (this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at, id').all(projectId) as Row[]).map(row => ({ id: String(row.id), projectId: String(row.project_id), taskId: row.task_id as string | null, runId: row.run_id as string | null, relativePath: String(row.relative_path), sha256: String(row.sha256), kind: String(row.kind), createdAt: String(row.created_at) }));
  }
  addDecision(projectId: string, summary: string, rationale = '', taskId: string | null = null): Decision {
    this.assertRelations(projectId, taskId, null);
    const decision: Decision = { id: id(), projectId, taskId, summary: nonEmpty(summary, 'summary'), rationale, createdAt: now() };
    this.database.transaction(() => {
      this.db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?)').run(decision.id, projectId, taskId, decision.summary, decision.rationale, decision.createdAt);
      this.event(projectId, 'decision.added', { summary: decision.summary }, taskId);
    });
    return decision;
  }
  listDecisions(projectId: string): Decision[] {
    this.getProject(projectId);
    return (this.db.prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at, id').all(projectId) as Row[]).map(row => ({ id: String(row.id), projectId: String(row.project_id), taskId: row.task_id as string | null, summary: String(row.summary), rationale: String(row.rationale), createdAt: String(row.created_at) }));
  }
  listEvents(projectId: string): Event[] {
    this.getProject(projectId);
    return (this.db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as Row[]).map(row => ({ id: String(row.id), projectId: String(row.project_id), taskId: row.task_id as string | null, runId: row.run_id as string | null, type: String(row.type), payload: parse<Record<string, unknown>>(row.payload_json), createdAt: String(row.created_at) }));
  }
  requestApproval(projectId: string, action: string, taskId: string | null = null): Approval {
    this.assertRelations(projectId, taskId, null);
    const approval: Approval = { id: id(), projectId, taskId, action: nonEmpty(action, 'action'), status: 'pending', requestedAt: now(), resolvedAt: null };
    this.database.transaction(() => {
      this.db.prepare('INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, ?)').run(approval.id, projectId, taskId, approval.action, approval.status, approval.requestedAt, null);
      this.event(projectId, 'approval.requested', { action: approval.action }, taskId);
    });
    return approval;
  }
  private approval(row: Row): Approval {
    return { id: String(row.id), projectId: String(row.project_id), taskId: row.task_id as string | null, action: String(row.action), status: row.status as Approval['status'], requestedAt: String(row.requested_at), resolvedAt: row.resolved_at as string | null };
  }
  listApprovals(projectId: string): Approval[] {
    this.getProject(projectId);
    return (this.db.prepare('SELECT * FROM approvals WHERE project_id = ? ORDER BY requested_at, id').all(projectId) as Row[]).map(row => this.approval(row));
  }
  resolveApproval(approvalId: string, status: string): Approval {
    const next = assertOneOf(status, APPROVAL_STATUSES, 'approval status');
    if (next === 'pending') throw new CoreError('INVALID_TRANSITION', 'Approval cannot return to pending');
    return this.database.transaction(() => {
      const row = required(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Row | undefined, 'Approval');
      const approval = this.approval(row);
      if (approval.status !== 'pending') throw new CoreError('INVALID_TRANSITION', 'Approval already resolved');
      this.db.prepare('UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?').run(next, now(), approvalId);
      this.event(approval.projectId, 'approval.resolved', { status: next }, approval.taskId);
      return this.approval(required(this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Row | undefined, 'Approval'));
    });
  }
  setCapability(name: string, status: string, source: string, details: Record<string, unknown> = {}): Capability {
    const capability: Capability = { id: id(), name: nonEmpty(name, 'name', 200), status: assertOneOf(status, CAPABILITY_STATUSES, 'capability status'), source: nonEmpty(source, 'source', 200), details, checkedAt: now() };
    this.db.prepare(`INSERT INTO capabilities VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET status = excluded.status, source = excluded.source,
      details_json = excluded.details_json, checked_at = excluded.checked_at`).run(capability.id, capability.name, capability.status, capability.source, JSON.stringify(details), capability.checkedAt);
    return this.getCapability(capability.name);
  }
  getCapability(name: string): Capability {
    const row = required(this.db.prepare('SELECT * FROM capabilities WHERE name = ?').get(name) as Row | undefined, 'Capability');
    return { id: String(row.id), name: String(row.name), status: row.status as Capability['status'], source: String(row.source), details: parse<Record<string, unknown>>(row.details_json), checkedAt: String(row.checked_at) };
  }
  listCapabilities(): Capability[] {
    return (this.db.prepare('SELECT name FROM capabilities ORDER BY name').all() as Row[]).map(row => this.getCapability(String(row.name)));
  }
}
