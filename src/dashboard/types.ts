import type {
  Approval, Artifact, Checkpoint, Decision, Event, GitSnapshot, Project, Run, Task,
} from '../core/domain.js';
import type { HandoffSession } from '../handoff/store.js';
import type { CodexExecution } from '../codex/store.js';
import type { OrganizationState } from '../organization/types.js';

export type DashboardActionState = 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_IMPLEMENTED' | 'AUTH_REQUIRED' | 'BLOCKED';
export type DashboardCapabilityStatus =
  | 'AVAILABLE' | 'UNAVAILABLE' | 'UNVERIFIED' | 'DISABLED' | 'AUTH_REQUIRED' | 'MISSING_DEPENDENCY'
  | 'BLOCKED_BY_COST' | 'UNSUPPORTED' | 'ERROR';
export type DashboardValidationStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'NOT RUN';
export type DashboardProvider = 'GPT HIGH' | 'CODEX' | 'SYSTEM' | 'WAITING USER';
export type DashboardCodexStatus = 'READY' | 'RUNNING' | 'PAUSED_CODEX' | 'WAITING_CODEX' | 'RESUMING' | 'UNAVAILABLE';

export interface DashboardAction {
  state: DashboardActionState;
  enabled: boolean;
  reason: string | null;
}

export interface DashboardTask extends Task {
  role: string | null;
  provider: DashboardProvider;
  priority: number | null;
  dependencies: string[];
  retryCount: number;
  acceptanceCriteria: string[];
  startedAt: string | null;
  completedAt: string | null;
  runs: Run[];
}

export interface DashboardActivity extends Event {
  category: 'system' | 'workflow' | 'handoff' | 'codex' | 'git' | 'patch' | 'command' | 'build' | 'test' | 'approval' | 'security';
}

export interface DashboardValidation {
  key: 'typecheck' | 'lint' | 'unit_test' | 'integration_test' | 'build' | 'npm_audit' | 'git_diff_check';
  label: string;
  status: DashboardValidationStatus;
  command: string | null;
  output: string | null;
  checkedAt: string | null;
  source: string;
}

export interface DashboardCodex {
  installed: boolean;
  authenticated: boolean | null;
  availability: 'AVAILABLE' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'NOT_CHECKED';
  provider: string;
  status: DashboardCodexStatus;
  threadId: string | null;
  turnId: string | null;
  currentStatus: string | null;
  lastError: string | null;
  pausedReason: string | null;
  resumeAvailable: boolean;
  latestExecution: CodexExecution | null;
}

export interface DashboardCapability {
  name: 'Codex' | 'Git' | 'Node' | 'npm' | 'Skills' | 'MCP' | 'Build Runner' | 'Test Runner' | string;
  type: string;
  status: DashboardCapabilityStatus;
  discovery: string;
  installation: string;
  authentication: string;
  cost: string;
  verification: string;
  runtime: string;
  approval: string;
  version: string | null;
  source: string;
  lastChecked: string | null;
  details: string;
}

export interface DashboardSettings {
  workspace: string | null;
  approvalPolicy: 'manual';
  logRetention: string;
  realtime: 'SSE';
  providerPreference: 'codex_then_high';
  zeroCostPolicy: true;
}

export interface DashboardCommandCenter {
  project: Project;
  objective: string | null;
  phase: string | null;
  taskCounts: Record<string, number>;
  currentTask: DashboardTask | null;
  provider: DashboardProvider;
  runStatus: string | null;
  codexStatus: DashboardCodexStatus;
  blockedReason: string | null;
  approvalRequired: boolean;
  latestCheckpoint: Checkpoint | null;
  latestValidation: DashboardValidation[];
  currentRole: string | null;
  activeRoles: string[];
  pendingReview: boolean;
  qaStatus: 'PASS' | 'FAIL' | 'NOT RUN';
  pdAcceptance: 'PASS' | 'FAIL' | 'NOT RUN';
}

export interface DashboardControls {
  pause: DashboardAction;
  resume: DashboardAction;
  cancel: DashboardAction;
  approve: DashboardAction;
  reject: DashboardAction;
  createCheckpoint: DashboardAction;
  continueHigh: DashboardAction;
  importHigh: DashboardAction;
  sendCodex: DashboardAction;
  resumeCodex: DashboardAction;
  viewDiff: DashboardAction;
  patchPreview: DashboardAction;
  patchApply: DashboardAction;
  rollback: DashboardAction;
}

export interface DashboardRealtimeState {
  project: Project;
  commandCenter: DashboardCommandCenter;
  tasks: DashboardTask[];
  git: GitSnapshot;
  activity: DashboardActivity[];
  validation: DashboardValidation[];
  codex: DashboardCodex;
  checkpoints: Checkpoint[];
  approvals: Approval[];
  handoffs: HandoffSession[];
  organization: OrganizationState;
  controls: DashboardControls;
}

export interface DashboardProjectState extends DashboardRealtimeState {
  artifacts: Artifact[];
  decisions: Decision[];
  capabilities: DashboardCapability[];
  settings: DashboardSettings;
}

export interface DashboardProjectSummary {
  project: Project;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  currentObjective: string | null;
  latestCheckpoint: Checkpoint | null;
  latestValidation: DashboardValidation[];
}
