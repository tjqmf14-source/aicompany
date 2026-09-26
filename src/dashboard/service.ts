import { existsSync } from 'node:fs';
import { CoreEngine } from '../core/engine.js';
import type { Approval, Event, Project, Run, Task } from '../core/domain.js';
import { HandoffStore, type CheckResult, type HandoffSession } from '../handoff/store.js';
import { CodexExecutionStore, type CodexExecution } from '../codex/store.js';
import { resolveCodexJsPath } from '../codex/provider.js';
import { OrganizationService } from '../organization/service.js';
import { CapabilityManagerService } from '../capabilities/service.js';
import { ParallelStore } from '../parallel/store.js';
import { SecurityService } from '../security/service.js';
import type { OrganizationAssignment, OrganizationState } from '../organization/types.js';
import type {
  DashboardAction, DashboardActivity, DashboardCapability, DashboardCodex, DashboardCommandCenter,
  DashboardControls, DashboardProjectState, DashboardProjectSummary, DashboardProvider,
  DashboardRealtimeState, DashboardSettings, DashboardTask, DashboardValidation,
} from './types.js';

const newest = <T>(items: T[], date: (item: T) => string): T | null =>
  [...items].sort((a, b) => date(b).localeCompare(date(a)))[0] ?? null;

const action = (state: DashboardAction['state'], reason: string | null = null): DashboardAction => ({
  state,
  enabled: state === 'AVAILABLE',
  reason,
});

function acceptanceCriteria(description: string): string[] {
  const marker = 'Acceptance criteria:';
  const index = description.indexOf(marker);
  if (index < 0) return [];
  return description.slice(index + marker.length).split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(Boolean);
}

function category(event: Event): DashboardActivity['category'] {
  const type = event.type.toLowerCase();
  if (type.includes('handoff')) return 'handoff';
  if (type.includes('codex')) return 'codex';
  if (type.includes('approval')) return 'approval';
  if (type.includes('patch')) return 'patch';
  if (type.includes('command')) return 'command';
  if (type.includes('build')) return 'build';
  if (type.includes('test') || type.includes('validation')) return 'test';
  if (type.includes('git') || type.includes('checkpoint')) return 'git';
  if (type.includes('security')) return 'security';
  if (type.includes('parallel') || type.includes('organization') || type.includes('run') || type.includes('task') || type.includes('project')) return 'workflow';
  return 'system';
}

function providerFor(
  task: Task,
  assignment: OrganizationAssignment | null,
  handoffs: HandoffSession[],
  codex: CodexExecution[],
): DashboardProvider {
  if (task.status === 'waiting_user') return 'WAITING USER';
  const latestCodex = newest(codex.filter(item => item.taskId === task.id), item => item.updatedAt);
  const latestHandoff = newest(handoffs.filter(item => item.taskId === task.id), item => item.updatedAt);
  if (latestCodex && (!latestHandoff || latestCodex.updatedAt >= latestHandoff.updatedAt)) return 'CODEX';
  if (latestHandoff) return 'GPT HIGH';
  if (assignment?.provider === 'GPT_HIGH') return 'GPT HIGH';
  if (assignment?.provider === 'CODEX') return 'CODEX';
  return 'SYSTEM';
}

function runTimes(runs: Run[]): { startedAt: string | null; completedAt: string | null } {
  if (!runs.length) return { startedAt: null, completedAt: null };
  const startedAt = runs.map(run => run.startedAt).sort()[0] ?? null;
  const completed = runs.filter(run => run.finishedAt).map(run => run.finishedAt as string).sort();
  return { startedAt, completedAt: completed.at(-1) ?? null };
}

function validationRows(handoffs: HandoffSession[]): DashboardValidation[] {
  const verified = newest(
    handoffs.filter(item => item.verification?.results.length),
    item => item.updatedAt,
  );
  const results = verified?.verification?.results ?? [];
  const result = (command: string): CheckResult | null => results.find(item => item.command === command) ?? null;
  const row = (
    key: DashboardValidation['key'],
    label: string,
    command: string | null,
    source: string,
  ): DashboardValidation => {
    const found = command ? result(command) : null;
    return {
      key, label,
      status: found?.status ?? 'NOT RUN',
      command: found?.command ?? command,
      output: found?.output ?? null,
      checkedAt: found ? verified?.updatedAt ?? null : null,
      source,
    };
  };
  return [
    row('typecheck', 'Typecheck', 'typecheck', 'Handoff verification'),
    row('lint', 'Lint', 'lint', 'Handoff verification'),
    row('unit_test', 'Unit test', 'test', 'npm test combined suite'),
    row('integration_test', 'Integration test', null, 'No separate integration-test runner recorded'),
    row('build', 'Build', 'build', 'Handoff verification'),
    row('npm_audit', 'npm audit', null, 'Not persisted by Core'),
    row('git_diff_check', 'git diff --check', null, 'Not persisted by Core'),
  ];
}

function codexStatus(execution: CodexExecution | null, installed: boolean): DashboardCodex {
  const status: DashboardCodex['status'] = !installed ? 'UNAVAILABLE'
    : execution?.status === 'running' ? 'RUNNING'
      : execution?.status === 'high_ready' ? 'PAUSED_CODEX'
        : execution?.status === 'recovery_required' ? 'WAITING_CODEX'
          : execution?.status === 'checking' ? 'WAITING_CODEX'
            : 'READY';
  return {
    installed,
    authenticated: null,
    availability: installed ? 'NOT_CHECKED' : 'UNAVAILABLE',
    provider: execution?.provider ?? 'codex-app-server',
    status,
    threadId: execution?.threadId ?? null,
    turnId: execution?.turnId ?? null,
    currentStatus: execution?.status ?? null,
    lastError: execution?.error ?? null,
    pausedReason: execution?.status === 'high_ready' || execution?.status === 'recovery_required' ? execution.error : null,
    resumeAvailable: execution?.status === 'high_ready' || execution?.status === 'recovery_required',
    latestExecution: execution,
  };
}

export class DashboardService {
  readonly handoffs: HandoffStore;
  readonly codex: CodexExecutionStore;
  readonly organization: OrganizationService;
  readonly capabilityManager: CapabilityManagerService;
  readonly parallel: ParallelStore;
  readonly securityService: SecurityService;

  constructor(readonly engine: CoreEngine) {
    this.handoffs = new HandoffStore(engine.database);
    this.codex = new CodexExecutionStore(engine.database);
    this.organization = new OrganizationService(engine);
    this.capabilityManager = new CapabilityManagerService(engine);
    this.parallel = new ParallelStore(engine.database);
    this.securityService = new SecurityService(engine);
  }

  private taskViews(
    projectId: string,
    handoffs: HandoffSession[],
    codex: CodexExecution[],
    organization: OrganizationState,
  ): DashboardTask[] {
    const organizationMap = new Map(organization.tasks.map(item => [item.task.id, item]));
    return this.engine.repository.listTasks(projectId).map(task => {
      const runs = this.engine.repository.listRuns(task.id);
      const times = runTimes(runs);
      const organizationTask = organizationMap.get(task.id) ?? null;
      return {
        ...task,
        role: organizationTask?.assignment.role ?? null,
        provider: providerFor(task, organizationTask?.assignment ?? null, handoffs, codex),
        priority: organizationTask?.assignment.priority ?? null,
        dependencies: organizationTask?.dependencies.map(item => item.dependsOnTaskId) ?? [],
        retryCount: Math.max(0, runs.length - 1),
        acceptanceCriteria: acceptanceCriteria(task.description),
        startedAt: times.startedAt,
        completedAt: times.completedAt,
        runs,
      };
    });
  }

  private currentTask(tasks: DashboardTask[]): DashboardTask | null {
    const rank = ['running', 'waiting_user', 'waiting_provider', 'reviewing', 'ready', 'queued', 'failed'];
    for (const status of rank) {
      const found = [...tasks].reverse().find(task => task.status === status);
      if (found) return found;
    }
    return tasks.at(-1) ?? null;
  }

  private controls(
    project: Project,
    currentTask: DashboardTask | null,
    approvals: Approval[],
    handoffs: HandoffSession[],
    codexRows: CodexExecution[],
    dirty: boolean,
  ): DashboardControls {
    const activeRun = currentTask?.runs.find(run => run.status === 'running') ?? null;
    const pendingApproval = newest(approvals.filter(item => item.status === 'pending'), item => item.requestedAt);
    const handoff = newest(handoffs, item => item.updatedAt);
    const execution = newest(codexRows, item => item.updatedAt);
    const cancellable = !!currentTask && !['passed', 'cancelled'].includes(currentTask.status);
    const resumableTask = currentTask?.status === 'waiting_user' || currentTask?.status === 'waiting_provider';

    return {
      pause: activeRun ? action('BLOCKED', '실행 중 Run을 중단하는 안전한 Pause primitive가 없습니다.')
        : project.status === 'active' ? action('AVAILABLE') : action('BLOCKED', '프로젝트가 active 상태가 아닙니다.'),
      resume: ['paused', 'blocked', 'review'].includes(project.status) || resumableTask
        ? action('AVAILABLE') : action('BLOCKED', '재개할 프로젝트 또는 Task가 없습니다.'),
      cancel: cancellable ? action('AVAILABLE') : action('BLOCKED', '취소 가능한 Task가 없습니다.'),
      approve: pendingApproval ? action('AVAILABLE') : action('BLOCKED', '대기 중 승인이 없습니다.'),
      reject: pendingApproval ? action('AVAILABLE') : action('BLOCKED', '대기 중 승인이 없습니다.'),
      createCheckpoint: action('AVAILABLE'),
      continueHigh: currentTask ? action('AVAILABLE') : action('BLOCKED', '선택할 Task가 없습니다.'),
      importHigh: handoff?.status === 'awaiting_response' ? action('AVAILABLE') : action('BLOCKED', '응답 대기 중 Handoff가 없습니다.'),
      sendCodex: currentTask && ['ready', 'waiting_provider'].includes(currentTask.status)
        ? dirty ? action('BLOCKED', 'Codex 시작 전 작업 트리가 깨끗해야 합니다.')
          : existsSync(resolveCodexJsPath()) ? action('AVAILABLE') : action('UNAVAILABLE', 'Codex App Server 설치를 찾지 못했습니다.')
        : action('BLOCKED', 'Task가 ready 또는 waiting_provider 상태가 아닙니다.'),
      resumeCodex: execution && (execution.status === 'high_ready' || execution.status === 'recovery_required')
        ? action('AVAILABLE') : action('BLOCKED', '재개 가능한 Codex execution이 없습니다.'),
      viewDiff: action('AVAILABLE'),
      patchPreview: handoff?.preview ? action('AVAILABLE') : action('BLOCKED', '검토할 Patch preview가 없습니다.'),
      patchApply: handoff?.status === 'ready_to_apply' ? action('AVAILABLE') : action('BLOCKED', '적용 가능한 reviewed patch가 없습니다.'),
      rollback: handoff && (handoff.status === 'applying' || handoff.status === 'recovery_required') && handoff.checkpoint
        ? action('AVAILABLE') : action('BLOCKED', '안전 rollback 가능한 Handoff checkpoint가 없습니다.'),
    };
  }

  realtime(projectId: string): DashboardRealtimeState {
    const project = this.engine.repository.getProject(projectId);
    const git = this.engine.git(projectId).snapshot();
    const handoffs = this.handoffs.list(projectId);
    const codexRows = this.codex.list(projectId);
    const organization = this.organization.state(projectId);
    const parallelLanes = this.parallel.list(projectId);
    const security = this.securityService.state(projectId);
    const tasks = this.taskViews(projectId, handoffs, codexRows, organization);
    const currentTask = this.currentTask(tasks);
    const checkpoints = this.engine.repository.listCheckpoints(projectId);
    const approvals = this.engine.repository.listApprovals(projectId);
    const validation = validationRows(handoffs);
    const latestExecution = newest(codexRows, item => item.updatedAt);
    const codexPath = resolveCodexJsPath();
    const codex = codexStatus(latestExecution, !!codexPath && existsSync(codexPath));
    const activity = this.engine.repository.listEvents(projectId).map(event => ({ ...event, category: category(event) })).reverse();
    const latestHandoff = newest(handoffs, item => item.updatedAt);
    const taskObjective = currentTask?.description.trim() || currentTask?.title || null;
    const objective = organization.plan?.objective ?? latestExecution?.objective ?? latestHandoff?.objective ?? taskObjective;
    const activeRun = currentTask?.runs.find(run => run.status === 'running') ?? null;
    const provider = currentTask?.provider ?? 'SYSTEM';
    const blockedReason = organization.plan?.status === 'blocked' ? 'Executive PD plan is blocked'
      : project.status === 'blocked' ? 'Project status is blocked'
        : currentTask?.status === 'waiting_user' ? '사용자 입력 또는 승인을 기다리는 중'
        : currentTask?.status === 'waiting_provider' ? latestExecution?.error ?? latestHandoff?.error ?? 'Provider를 기다리는 중'
          : latestExecution?.status === 'recovery_required' ? latestExecution.error ?? 'Codex recovery required'
            : null;
    const taskCounts = Object.fromEntries(
      ['queued','ready','running','waiting_user','waiting_provider','reviewing','passed','failed','cancelled']
        .map(status => [status, tasks.filter(task => task.status === status).length]),
    );
    const commandCenter: DashboardCommandCenter = {
      project,
      objective,
      phase: organization.plan?.stage ?? null,
      taskCounts,
      currentTask,
      provider,
      runStatus: activeRun?.status ?? null,
      codexStatus: codex.status,
      blockedReason,
      approvalRequired: approvals.some(item => item.status === 'pending'),
      latestCheckpoint: checkpoints.at(-1) ?? null,
      latestValidation: validation,
      currentRole: organization.currentRole,
      activeRoles: organization.activeRoles,
      pendingReview: organization.pendingReview,
      qaStatus: organization.qaStatus,
      pdAcceptance: organization.pdAcceptance,
    };
    return {
      project,
      commandCenter,
      tasks,
      git,
      activity,
      validation,
      codex,
      checkpoints: [...checkpoints].reverse(),
      approvals: [...approvals].reverse(),
      handoffs: [...handoffs].reverse(),
      organization,
      parallelLanes,
      security,
      controls: this.controls(project, currentTask, approvals, handoffs, codexRows, git.dirty),
    };
  }

  projectState(projectId: string): DashboardProjectState {
    const realtime = this.realtime(projectId);
    return {
      ...realtime,
      artifacts: [...this.engine.repository.listArtifacts(projectId)].reverse(),
      decisions: [...this.engine.repository.listDecisions(projectId)].reverse(),
      capabilities: this.capabilities(projectId),
      capabilityOperations: [...this.capabilityManager.store.listOperations(projectId)].reverse(),
      settings: this.settings(projectId),
    };
  }

  listProjects(): DashboardProjectSummary[] {
    return this.engine.repository.listProjects().map(project => {
      const state = this.realtime(project.id);
      return {
        project,
        branch: state.git.branch,
        head: state.git.head,
        dirty: state.git.dirty,
        currentObjective: state.commandCenter.objective,
        latestCheckpoint: state.commandCenter.latestCheckpoint,
        latestValidation: state.validation,
      };
    });
  }

  settings(projectId?: string): DashboardSettings {
    return {
      workspace: projectId ? this.engine.repository.getProject(projectId).rootPath : null,
      approvalPolicy: 'manual',
      logRetention: 'SQLite에 영구 보관, 자동 삭제 없음',
      realtime: 'SSE',
      providerPreference: 'codex_then_high',
      zeroCostPolicy: true,
    };
  }

  capabilities(projectId?: string): DashboardCapability[] {
    if (!projectId) return [];
    return this.capabilityManager.dashboard(projectId).map(item => ({
      id: item.id,
      name: item.name,
      type: item.type,
      status: item.overallStatus,
      discovery: item.discoveryState,
      installation: item.installationState,
      authentication: item.authState,
      cost: item.costState,
      verification: item.verificationState,
      runtime: item.runtimeState,
      approval: item.approvalState,
      version: item.version,
      source: item.source?.location ?? item.sourceRef ?? '기록 없음',
      sourceTrust: item.source?.trustState ?? 'UNKNOWN',
      installMethod: item.source?.installMethod ?? 'NONE',
      lastChecked: item.lastCheckedAt,
      details: JSON.stringify(item.details),
    }));
  }

  fingerprint(projectId: string): string {
    const state = this.realtime(projectId);
    return JSON.stringify({
      ...state,
      git: { ...state.git, capturedAt: '' },
    });
  }
}
