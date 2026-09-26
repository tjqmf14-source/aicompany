export type SecurityCheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'BLOCKED';
export type SecurityAuditStatus = 'PASS' | 'WARN' | 'FAIL';
export type QaRunStatus = 'RUNNING' | 'PASS' | 'FAIL' | 'INTERRUPTED';

export interface SecurityCheck {
  key: string;
  status: SecurityCheckStatus;
  summary: string;
  evidence: string;
}

export interface SecurityAudit {
  id: string;
  projectId: string;
  status: SecurityAuditStatus;
  checks: SecurityCheck[];
  createdAt: string;
}

export interface QaCheck {
  name: 'git_diff_check' | 'typecheck' | 'lint' | 'test' | 'build' | 'npm_audit';
  status: 'PASS' | 'FAIL';
  exitCode: number | null;
  output: string;
}

export interface QaRun {
  id: string;
  projectId: string;
  status: QaRunStatus;
  baseHead: string | null;
  baseBranch: string | null;
  checks: QaCheck[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RecoveryState {
  projectId: string;
  blockers: string[];
  interruptedRuns: number;
  recoveryHandoffs: number;
  recoveryCodex: number;
  recoveryParallel: number;
  runningQa: number;
}

export interface SecurityState {
  latestAudit: SecurityAudit | null;
  latestQa: QaRun | null;
  recovery: RecoveryState;
  releaseReady: boolean;
}
