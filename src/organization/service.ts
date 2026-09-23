import { randomUUID } from 'node:crypto';
import { CoreError, nonEmpty } from '../core/domain.js';
import { CoreEngine } from '../core/engine.js';
import { OrganizationStore, type StoredPlanTask } from './store.js';
import {
  type CreateOrganizationPlanInput, type GateKind, type GateResult, type OrganizationAssignment,
  type OrganizationPlan, type OrganizationRole, type OrganizationState, type OrganizationTask, type PlanTaskInput,
} from './types.js';

function priority(value: number | undefined): number {
  const result = value ?? 100;
  if (!Number.isSafeInteger(result) || result < 1 || result > 10_000) throw new CoreError('INVALID_INPUT', 'priority must be an integer from 1 to 10000');
  return result;
}

function detectCycle(tasks: PlanTaskInput[]): void {
  const graph = new Map(tasks.map(task => [task.key, task.dependsOn ?? []] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new CoreError('INVALID_INPUT', 'Task dependency cycle detected');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const next of graph.get(key) ?? []) visit(next);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of graph.keys()) visit(key);
}

export class OrganizationService {
  readonly store: OrganizationStore;
  constructor(readonly engine: CoreEngine) { this.store = new OrganizationStore(engine.database); }

  createPlan(projectId: string, input: CreateOrganizationPlanInput): OrganizationPlan {
    this.engine.repository.getProject(projectId);
    const objective = nonEmpty(input.objective, 'objective', 20_000);
    if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 200) {
      throw new CoreError('INVALID_INPUT', 'tasks must contain 1-200 items');
    }
    const keys = new Set<string>();
    const ids = new Map<string, string>();
    for (const item of input.tasks) {
      const key = nonEmpty(item.key, 'task key', 100);
      if (keys.has(key)) throw new CoreError('INVALID_INPUT', `Duplicate task key: ${key}`);
      keys.add(key);
      ids.set(key, randomUUID());
      nonEmpty(item.title, 'task title', 300);
      this.store.validateRole(item.role);
      this.store.validateProvider(item.provider);
      priority(item.priority);
    }
    for (const item of input.tasks) for (const dep of item.dependsOn ?? []) {
      if (!keys.has(dep)) throw new CoreError('INVALID_INPUT', `Unknown dependency key: ${dep}`);
      if (dep === item.key) throw new CoreError('INVALID_INPUT', 'Task cannot depend on itself');
    }
    detectCycle(input.tasks);
    const stored: StoredPlanTask[] = input.tasks.map(item => ({
      id: ids.get(item.key)!,
      title: nonEmpty(item.title, 'task title', 300),
      description: item.description ?? '',
      role: this.store.validateRole(item.role),
      provider: this.store.validateProvider(item.provider),
      priority: priority(item.priority),
      dependencyIds: (item.dependsOn ?? []).map(key => ids.get(key)!),
    }));
    return this.store.create(projectId, objective, stored);
  }

  start(planId: string): OrganizationPlan {
    const plan = this.store.get(planId);
    if (plan.status !== 'draft' || plan.stage !== 'planning') throw new CoreError('INVALID_TRANSITION', 'Plan must be draft/planning');
    const updated = this.store.setPlan(planId, 'active', 'execution');
    this.store.refreshReady(planId);
    return updated;
  }

  refresh(planId: string): OrganizationState {
    this.store.refreshReady(planId);
    return this.stateByPlan(planId);
  }

  private latestPlan(projectId: string): OrganizationPlan | null { return this.store.latest(projectId); }

  state(projectId: string): OrganizationState {
    const plan = this.latestPlan(projectId);
    if (!plan) return {
      plan: null, tasks: [], gates: [], activeRoles: [], currentRole: null,
      pendingReview: false, qaStatus: 'NOT RUN', pdAcceptance: 'NOT RUN',
    };
    return this.stateByPlan(plan.id);
  }

  stateByPlan(planId: string): OrganizationState {
    const plan = this.store.get(planId);
    const assignments = this.store.listAssignments(planId);
    const assignmentMap = new Map(assignments.map(item => [item.taskId, item]));
    const tasks: OrganizationTask[] = this.store.planTasks(planId).map(task => ({
      task,
      assignment: assignmentMap.get(task.id)!,
      dependencies: this.store.dependencies(task.id),
      ready: this.store.dependenciesSatisfied(task.id),
    }));
    const activeStatuses = new Set(['ready', 'running', 'waiting_user', 'waiting_provider', 'reviewing']);
    const activeRoles = [...new Set(tasks.filter(item => activeStatuses.has(item.task.status)).map(item => item.assignment.role))];
    const current = tasks.find(item => item.task.status === 'running')
      ?? tasks.find(item => item.task.status === 'waiting_user' || item.task.status === 'waiting_provider')
      ?? tasks.find(item => item.task.status === 'ready')
      ?? null;
    const gates = this.store.gates(planId);
    return {
      plan, tasks, gates, activeRoles, currentRole: current?.assignment.role ?? null,
      pendingReview: plan.stage === 'independent_review' && this.store.latestGate(planId, 'independent_review')?.result !== 'PASS',
      qaStatus: this.store.latestGate(planId, 'qa')?.result ?? 'NOT RUN',
      pdAcceptance: this.store.latestGate(planId, 'pd_acceptance')?.result ?? 'NOT RUN',
    };
  }

  route(taskId: string): OrganizationAssignment {
    const assignment = this.store.assignment(taskId);
    if (!assignment) throw new CoreError('NOT_FOUND', 'Organization assignment not found');
    const task = this.engine.repository.getTask(taskId);
    if (!this.store.dependenciesSatisfied(taskId)) throw new CoreError('CONFLICT', 'Task dependencies are not complete');
    if (task.status !== 'ready' && task.status !== 'waiting_provider') {
      throw new CoreError('INVALID_TRANSITION', 'Task must be ready or waiting_provider before routing');
    }
    return assignment;
  }

  recordGate(planId: string, kind: GateKind, result: GateResult, summary: string, evidence = '') {
    const plan = this.store.get(planId);
    if (plan.stage !== kind) throw new CoreError('INVALID_TRANSITION', `Plan stage ${plan.stage} cannot record ${kind}`);
    const gate = this.store.addGate(planId, kind, result, summary, evidence);
    if (result === 'FAIL') this.store.setPlan(planId, 'blocked', 'blocked');
    return gate;
  }

  advance(planId: string): OrganizationPlan {
    const plan = this.store.get(planId);
    if (plan.stage === 'planning') return this.start(planId);
    if (plan.status === 'blocked' || plan.stage === 'blocked') throw new CoreError('INVALID_TRANSITION', 'Blocked plan requires rework');
    if (plan.stage === 'execution') {
      const tasks = this.store.planTasks(planId);
      if (!tasks.length || tasks.some(task => task.status !== 'passed')) throw new CoreError('CONFLICT', 'All plan tasks must pass before validation');
      return this.store.setPlan(planId, 'active', 'validation');
    }
    const next: Partial<Record<typeof plan.stage, { gate: GateKind; stage: typeof plan.stage }>> = {
      validation: { gate: 'validation', stage: 'independent_review' },
      independent_review: { gate: 'independent_review', stage: 'qa' },
      qa: { gate: 'qa', stage: 'pd_acceptance' },
      pd_acceptance: { gate: 'pd_acceptance', stage: 'completed' },
    };
    const transition = next[plan.stage];
    if (!transition) throw new CoreError('INVALID_TRANSITION', `Plan cannot advance from ${plan.stage}`);
    if (this.store.latestGate(planId, transition.gate)?.result !== 'PASS') {
      throw new CoreError('CONFLICT', `${transition.gate} must PASS before advancing`);
    }
    return this.store.setPlan(planId, transition.stage === 'completed' ? 'completed' : 'active', transition.stage);
  }

  rework(planId: string): OrganizationPlan {
    const plan = this.store.get(planId);
    if (plan.status !== 'blocked' || plan.stage !== 'blocked') throw new CoreError('INVALID_TRANSITION', 'Only blocked plans can enter rework');
    const updated = this.store.setPlan(planId, 'active', 'execution');
    this.store.refreshReady(planId);
    return updated;
  }

  roleForTask(taskId: string): OrganizationRole | null { return this.store.assignment(taskId)?.role ?? null; }
}
