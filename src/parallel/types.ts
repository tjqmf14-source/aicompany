import type { OrganizationProvider, OrganizationRole } from '../organization/types.js';

export const PARALLEL_LANE_STATUSES = [
  'PREPARING', 'READY', 'WORKING', 'REVIEW', 'APPROVAL_PENDING',
  'INTEGRATING', 'COMPLETED', 'FAILED', 'RECOVERY_REQUIRED', 'RELEASED',
] as const;

export type ParallelLaneStatus = typeof PARALLEL_LANE_STATUSES[number];
export type ParallelValidationName = 'typecheck' | 'lint' | 'test' | 'build';

export interface ParallelValidation {
  name: ParallelValidationName;
  status: 'PASS' | 'FAIL';
  exitCode: number | null;
  output: string;
}

export interface ParallelLane {
  id: string;
  projectId: string;
  taskId: string;
  planId: string | null;
  role: OrganizationRole | null;
  provider: OrganizationProvider | null;
  status: ParallelLaneStatus;
  branchName: string;
  worktreePath: string;
  baseHead: string;
  baseBranch: string;
  runId: string | null;
  resultHead: string | null;
  changedFiles: string[];
  scopePaths: string[];
  targetHead: string | null;
  integrationCommit: string | null;
  approvalId: string | null;
  validation: ParallelValidation[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParallelState {
  projectId: string;
  lanes: ParallelLane[];
  active: number;
  awaitingIntegration: number;
  completed: number;
}
