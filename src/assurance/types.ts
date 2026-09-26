export const ASSURANCE_KINDS = ['SECURITY','RECOVERY','QA'] as const;
export const ASSURANCE_STATUSES = ['RUNNING','PASS','WARN','FAIL'] as const;
export const ASSURANCE_RESULTS = ['PASS','WARN','FAIL','NOT_RUN'] as const;
export const RECOVERY_SOURCE_KINDS = ['RUN','HANDOFF','CODEX','PARALLEL','CAPABILITY','GIT'] as const;

export type AssuranceKind = typeof ASSURANCE_KINDS[number];
export type AssuranceStatus = typeof ASSURANCE_STATUSES[number];
export type AssuranceResult = typeof ASSURANCE_RESULTS[number];
export type RecoverySourceKind = typeof RECOVERY_SOURCE_KINDS[number];
export type RecoveryIncidentStatus = 'OPEN' | 'BLOCKED' | 'RESOLVED';

export interface AssuranceRun {
  id: string;
  projectId: string;
  kind: AssuranceKind;
  status: AssuranceStatus;
  baseHead: string | null;
  baseBranch: string | null;
  summary: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
}

export interface AssuranceCheck {
  id: string;
  runId: string;
  checkKey: string;
  category: AssuranceKind;
  severity: 'INFO' | 'WARN' | 'ERROR';
  result: AssuranceResult;
  detail: string;
  evidence: Record<string, unknown>;
  checkedAt: string;
}

export interface RecoveryIncident {
  id: string;
  projectId: string;
  sourceKind: RecoverySourceKind;
  sourceId: string;
  status: RecoveryIncidentStatus;
  action: string;
  evidence: Record<string, unknown>;
  detectedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface AssuranceRunDetail {
  run: AssuranceRun;
  checks: AssuranceCheck[];
}

export interface AssuranceState {
  projectId: string;
  latestSecurity: AssuranceRunDetail | null;
  latestRecovery: AssuranceRunDetail | null;
  latestQa: AssuranceRunDetail | null;
  incidents: RecoveryIncident[];
}
