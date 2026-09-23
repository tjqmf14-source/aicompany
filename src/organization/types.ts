import type { Task } from '../core/domain.js';

export const ORGANIZATION_ROLES = [
  'Executive PD', 'Planning', 'Research', 'Design Director', 'UI/UX', 'Visual Design',
  'Engineering Director', 'Coding', 'Code Review', 'QA', 'Security', 'Release',
] as const;
export const ORGANIZATION_PROVIDERS = ['GPT_HIGH', 'CODEX', 'SYSTEM'] as const;
export const PLAN_STAGES = ['planning', 'execution', 'validation', 'independent_review', 'qa', 'pd_acceptance', 'completed', 'blocked'] as const;
export const PLAN_STATUSES = ['draft', 'active', 'blocked', 'completed'] as const;
export const GATE_KINDS = ['validation', 'independent_review', 'qa', 'pd_acceptance'] as const;
export const GATE_RESULTS = ['PASS', 'FAIL'] as const;

export type OrganizationRole = typeof ORGANIZATION_ROLES[number];
export type OrganizationProvider = typeof ORGANIZATION_PROVIDERS[number];
export type PlanStage = typeof PLAN_STAGES[number];
export type PlanStatus = typeof PLAN_STATUSES[number];
export type GateKind = typeof GATE_KINDS[number];
export type GateResult = typeof GATE_RESULTS[number];

export interface OrganizationPlan {
  id: string;
  projectId: string;
  objective: string;
  status: PlanStatus;
  stage: PlanStage;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationAssignment {
  taskId: string;
  planId: string;
  role: OrganizationRole;
  priority: number;
  provider: OrganizationProvider;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationDependency {
  taskId: string;
  dependsOnTaskId: string;
}

export interface OrganizationGate {
  id: string;
  planId: string;
  projectId: string;
  kind: GateKind;
  result: GateResult;
  summary: string;
  evidence: string;
  createdAt: string;
}

export interface PlanTaskInput {
  key: string;
  title: string;
  description?: string;
  role: OrganizationRole;
  provider: OrganizationProvider;
  priority?: number;
  dependsOn?: string[];
}

export interface CreateOrganizationPlanInput {
  objective: string;
  tasks: PlanTaskInput[];
}

export interface OrganizationTask {
  task: Task;
  assignment: OrganizationAssignment;
  dependencies: OrganizationDependency[];
  ready: boolean;
}

export interface OrganizationState {
  plan: OrganizationPlan | null;
  tasks: OrganizationTask[];
  gates: OrganizationGate[];
  activeRoles: OrganizationRole[];
  currentRole: OrganizationRole | null;
  pendingReview: boolean;
  qaStatus: GateResult | 'NOT RUN';
  pdAcceptance: GateResult | 'NOT RUN';
}
