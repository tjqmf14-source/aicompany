export const PROJECT_STATUSES = ['draft', 'active', 'paused', 'blocked', 'review', 'completed', 'failed'] as const;
export const TASK_STATUSES = ['queued', 'ready', 'running', 'waiting_user', 'waiting_provider', 'reviewing', 'passed', 'failed', 'cancelled'] as const;
export const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const CAPABILITY_STATUSES = ['available', 'unavailable', 'degraded'] as const;

export type ProjectStatus = typeof PROJECT_STATUSES[number];
export type TaskStatus = typeof TASK_STATUSES[number];
export type RunStatus = typeof RUN_STATUSES[number];
export type ApprovalStatus = typeof APPROVAL_STATUSES[number];
export type CapabilityStatus = typeof CAPABILITY_STATUSES[number];

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  status: ProjectStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  projectId: string;
  taskId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  recoveredAt: string | null;
  error: string | null;
}

export interface GitChange {
  code: string;
  path: string;
  originalPath: string | null;
}

export interface GitSnapshot {
  rootPath: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  changes: GitChange[];
  diff: string;
  capturedAt: string;
}

export interface Checkpoint {
  id: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  note: string;
  snapshot: GitSnapshot;
  createdAt: string;
}

export interface Artifact {
  id: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  relativePath: string;
  sha256: string;
  kind: string;
  createdAt: string;
}

export interface Decision {
  id: string;
  projectId: string;
  taskId: string | null;
  summary: string;
  rationale: string;
  createdAt: string;
}

export interface Event {
  id: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Approval {
  id: string;
  projectId: string;
  taskId: string | null;
  action: string;
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt: string | null;
}

export interface Capability {
  id: string;
  name: string;
  status: CapabilityStatus;
  source: string;
  details: Record<string, unknown>;
  checkedAt: string;
}

export class CoreError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'INVALID_INPUT' | 'INVALID_TRANSITION' | 'DIRTY_WORKTREE' | 'NOT_GIT_REPOSITORY' | 'CONFLICT' | 'FORBIDDEN', message: string) {
    super(message);
    this.name = 'CoreError';
  }
}

export function nonEmpty(value: string, field: string, maxLength = 1000): string {
  const result = value.trim();
  if (!result || result.length > maxLength) throw new CoreError('INVALID_INPUT', `${field} must contain 1-${maxLength} characters`);
  return result;
}

export function assertOneOf<T extends string>(value: string, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) throw new CoreError('INVALID_INPUT', `Invalid ${field}: ${value}`);
  return value as T;
}

export const projectTransitions: Record<ProjectStatus, readonly ProjectStatus[]> = {
  draft: ['active', 'failed'],
  active: ['paused', 'blocked', 'review', 'completed', 'failed'],
  paused: ['active', 'failed'],
  blocked: ['active', 'failed'],
  review: ['active', 'completed', 'failed'],
  completed: [],
  failed: [],
};

export const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['ready', 'cancelled'],
  ready: ['running', 'waiting_user', 'waiting_provider', 'cancelled'],
  running: ['waiting_user', 'waiting_provider', 'reviewing', 'failed', 'cancelled'],
  waiting_user: ['ready', 'running', 'cancelled'],
  waiting_provider: ['ready', 'running', 'cancelled'],
  reviewing: ['passed', 'failed', 'ready', 'cancelled'],
  passed: [],
  failed: ['ready', 'cancelled'],
  cancelled: [],
};
