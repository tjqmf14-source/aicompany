import type { GitSnapshot } from '../core/domain.js';

export type CodexEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type CodexAvailabilityState = 'available' | 'rate_limited' | 'unavailable';
export type CodexOutcomeStatus = 'completed' | 'interrupted' | 'rate_limited' | 'failed';

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  primaryUsedPercent: number | null;
  secondaryUsedPercent: number | null;
  rateLimitReachedType: string | null;
  checkedAt: string;
}

export interface CodexAvailability {
  state: CodexAvailabilityState;
  reason: string | null;
  rateLimit: CodexRateLimitSnapshot | null;
}

export interface CodexRunRequest {
  cwd: string;
  objective: string;
  threadId: string | null;
  model?: string;
  effort?: CodexEffort;
  allowNewThreadOnResumeFailure: boolean;
}

export interface CodexRunOutcome {
  status: CodexOutcomeStatus;
  threadId: string | null;
  turnId: string | null;
  model: string | null;
  effort: CodexEffort | null;
  reusedThread: boolean;
  rateLimit: CodexRateLimitSnapshot | null;
  lastEvent: Record<string, unknown> | null;
  error: string | null;
}

export interface CodexExecutionProvider {
  readonly id: string;
  checkAvailability(cwd: string): Promise<CodexAvailability>;
  run(request: CodexRunRequest): Promise<CodexRunOutcome>;
}

export interface ExecutionCheckpointMatch {
  checkpointId: string | null;
  matches: boolean;
  snapshot: GitSnapshot;
}
