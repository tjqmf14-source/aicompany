import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CoreError } from '../core/domain.js';
import { CoreEngine } from '../core/engine.js';
import { OrganizationStore } from '../organization/store.js';
import { ParallelGit } from './git.js';
import { ParallelStore } from './store.js';
import type {
  ParallelLane, ParallelState, ParallelValidation, ParallelValidationName,
} from './types.js';
import { sanitizedProcessEnv } from '../security/environment.js';
import { redactSensitive } from '../security/redaction.js';

const validationNames: ParallelValidationName[] = ['typecheck', 'lint', 'test', 'build'];
const now = (): string => new Date().toISOString();
const redact = (value: string): string => redactSensitive(value);

function scopePath(value: string): string {
  const trimmed = value.trim().replaceAll('\\', '/');
  if (!trimmed || trimmed.includes('\0') || isAbsolute(trimmed)) throw new CoreError('INVALID_INPUT', 'Scope path must be repository-relative');
  const normalized = posix.normalize(trimmed).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new CoreError('INVALID_INPUT', 'Scope path escapes the repository');
  }
  return normalized;
}

function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function readScripts(root: string): Record<string, string> {
  const path = `${root}/package.json`;
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) return {};
    return Object.fromEntries(Object.entries(parsed.scripts as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function validate(root: string): ParallelValidation[] {
  const scripts = readScripts(root);
  const windows = process.platform === 'win32';
  return validationNames.map(name => {
    if (!scripts[name]) return { name, status: 'FAIL' as const, exitCode: null, output: `package.json script "${name}" is missing` };
    const executable = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
    const args = windows ? ['/d', '/s', '/c', `npm.cmd run ${name}`] : ['run', name];
    const result = spawnSync(executable, args, {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024, env: sanitizedProcessEnv({ CI: '1', NO_COLOR: '1' }),
    });
    return {
      name,
      status: result.status === 0 && !result.error ? 'PASS' as const : 'FAIL' as const,
      exitCode: result.status,
      output: redact(`${result.stdout ?? ''}\n${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`),
    };
  });
}

export class ParallelService {
  readonly store: ParallelStore;
  readonly organization: OrganizationStore;

  constructor(readonly engine: CoreEngine) {
    this.store = new ParallelStore(engine.database);
    this.organization = new OrganizationStore(engine.database);
  }

  recoverStartupStates(): number { return this.store.recoverStartupStates(); }

  state(projectId: string): ParallelState {
    this.engine.repository.getProject(projectId);
    return this.store.state(projectId);
  }

  create(taskId: string, rawScopes: string[] = []): ParallelLane {
    const task = this.engine.repository.getTask(taskId);
    if (task.status !== 'ready' && task.status !== 'waiting_provider') {
      throw new CoreError('INVALID_TRANSITION', 'Task must be ready or waiting_provider before creating a parallel lane');
    }
    const project = this.engine.repository.getProject(task.projectId);
    const primary = this.engine.git(project.id);
    primary.requireClean();
    const snapshot = primary.snapshot();
    if (!snapshot.head || !snapshot.branch) throw new CoreError('CONFLICT', 'Parallel lanes require a committed named branch');

    const scopePaths = [...new Set(rawScopes.map(scopePath))].sort();
    const active = this.store.active(project.id);
    if (active.some(lane => lane.taskId === task.id)) throw new CoreError('CONFLICT', 'Task already has an active parallel lane');
    if (active.length >= 8) throw new CoreError('CONFLICT', 'A project can have at most 8 active parallel lanes');
    for (const lane of active) for (const left of scopePaths) for (const right of lane.scopePaths) {
      if (scopesOverlap(left, right)) throw new CoreError('CONFLICT', `Parallel scope overlaps lane ${lane.id}: ${left} / ${right}`);
    }

    const assignment = this.organization.assignment(task.id);
    const laneId = randomUUID();
    const git = new ParallelGit(project.rootPath);
    const branchName = `ai-company/parallel/${task.id.slice(0, 8)}-${laneId.slice(0, 8)}`;
    const timestamp = now();
    let lane = this.store.create({
      id: laneId,
      projectId: project.id,
      taskId: task.id,
      planId: assignment?.planId ?? null,
      role: assignment?.role ?? null,
      provider: assignment?.provider ?? null,
      status: 'PREPARING',
      branchName,
      worktreePath: git.pathFor(laneId),
      baseHead: snapshot.head,
      baseBranch: snapshot.branch,
      runId: null,
      resultHead: null,
      changedFiles: [],
      scopePaths,
      targetHead: null,
      integrationCommit: null,
      approvalId: null,
      validation: [],
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    try {
      git.create(lane.branchName, lane.worktreePath, lane.baseHead);
      lane = this.store.update(lane.id, { status: 'READY', error: null });
      return lane;
    } catch (error) {
      this.store.update(lane.id, { status: 'FAILED', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  start(laneId: string): ParallelLane {
    const lane = this.store.get(laneId);
    if (lane.status !== 'READY') throw new CoreError('INVALID_TRANSITION', 'Parallel lane must be READY');
    const git = new ParallelGit(this.engine.repository.getProject(lane.projectId).rootPath);
    const snapshot = git.snapshot(lane.worktreePath);
    if (snapshot.dirty || snapshot.head !== lane.baseHead || snapshot.branch !== lane.branchName) {
      throw new CoreError('CONFLICT', 'Parallel worktree changed before worker start');
    }
    const run = this.engine.startRun(lane.taskId);
    return this.store.update(lane.id, { status: 'WORKING', runId: run.id, error: null });
  }

  submit(laneId: string): ParallelLane {
    const lane = this.store.get(laneId);
    if (lane.status !== 'WORKING') throw new CoreError('INVALID_TRANSITION', 'Parallel lane must be WORKING');
    const git = new ParallelGit(this.engine.repository.getProject(lane.projectId).rootPath);
    const snapshot = git.snapshot(lane.worktreePath);
    if (snapshot.dirty) throw new CoreError('DIRTY_WORKTREE', 'Parallel result must be committed before submission');
    if (!snapshot.head || snapshot.branch !== lane.branchName) throw new CoreError('CONFLICT', 'Parallel worktree branch changed');
    if (snapshot.head === lane.baseHead) throw new CoreError('CONFLICT', 'Parallel lane has no committed result');
    if (!git.isAncestor(lane.baseHead, snapshot.head)) throw new CoreError('CONFLICT', 'Parallel result no longer descends from its approved base');
    const changedFiles = git.changedFiles(lane.baseHead, snapshot.head);
    if (!changedFiles.length) throw new CoreError('CONFLICT', 'Parallel result contains no net file changes');
    if (lane.scopePaths.length && changedFiles.some(path => !lane.scopePaths.some(scope => path === scope || path.startsWith(`${scope}/`)))) {
      throw new CoreError('CONFLICT', 'Parallel result changed files outside its declared scope');
    }

    if (!lane.runId) throw new CoreError('CONFLICT', 'Parallel lane has no Core Run');
    const run = this.engine.repository.getRun(lane.runId);
    if (run.status !== 'running') throw new CoreError('CONFLICT', 'Parallel Core Run is not running');
    this.engine.repository.finishRun(run.id, 'completed');
    return this.store.update(lane.id, {
      status: 'REVIEW', resultHead: snapshot.head, changedFiles, error: null,
      approvalId: null, targetHead: null, validation: [],
    });
  }

  fail(laneId: string, reason: string): ParallelLane {
    const lane = this.store.get(laneId);
    if (!['WORKING','RECOVERY_REQUIRED'].includes(lane.status)) throw new CoreError('INVALID_TRANSITION', 'Parallel lane is not active');
    if (lane.runId) {
      const run = this.engine.repository.getRun(lane.runId);
      if (run.status === 'running') this.engine.repository.finishRun(run.id, 'failed', reason);
    }
    return this.store.update(lane.id, { status: 'FAILED', error: reason.slice(0, 4000) });
  }

  requestIntegration(laneId: string): ParallelLane {
    const lane = this.store.get(laneId);
    if (lane.status !== 'REVIEW' || !lane.resultHead) throw new CoreError('INVALID_TRANSITION', 'Parallel lane must have a reviewed committed result');
    const project = this.engine.repository.getProject(lane.projectId);
    const git = new ParallelGit(project.rootPath);
    git.primary.requireClean();
    const target = git.primary.snapshot();
    if (!target.head || target.branch !== lane.baseBranch) throw new CoreError('CONFLICT', 'Primary repository is not on the lane base branch');
    if (!git.isAncestor(lane.baseHead, target.head)) throw new CoreError('CONFLICT', 'Primary history no longer descends from the lane base');

    const worktree = git.snapshot(lane.worktreePath);
    if (worktree.dirty || worktree.head !== lane.resultHead || worktree.branch !== lane.branchName) {
      throw new CoreError('CONFLICT', 'Parallel result changed after submission');
    }
    const changedFiles = git.changedFiles(lane.baseHead, lane.resultHead);
    const targetChanged = git.changedFiles(lane.baseHead, target.head);
    const targetSet = new Set(targetChanged);
    const overlap = changedFiles.filter(path => targetSet.has(path));
    if (overlap.length) throw new CoreError('CONFLICT', `Primary branch changed the same files: ${overlap.join(', ')}`);

    this.engine.checkpoint(lane.projectId, `Before parallel integration ${lane.id}`, lane.taskId);
    const approval = this.engine.repository.requestApproval(
      lane.projectId, `parallel.integrate:${lane.id}:${lane.resultHead}`, lane.taskId,
    );
    return this.store.update(lane.id, {
      status: 'APPROVAL_PENDING', targetHead: target.head, approvalId: approval.id,
      changedFiles, validation: [], error: null,
    });
  }

  integrate(laneId: string): ParallelLane {
    let lane = this.store.get(laneId);
    if (lane.status !== 'APPROVAL_PENDING' || !lane.resultHead || !lane.targetHead || !lane.approvalId) {
      throw new CoreError('INVALID_TRANSITION', 'Parallel lane is not awaiting approved integration');
    }
    const approval = this.engine.repository.listApprovals(lane.projectId).find(item => item.id === lane.approvalId);
    if (!approval) throw new CoreError('NOT_FOUND', 'Parallel integration approval not found');
    if (approval.status === 'rejected') {
      return this.store.update(lane.id, {
        status: 'REVIEW', approvalId: null, targetHead: null, error: 'Parallel integration was rejected',
      });
    }
    if (approval.status !== 'approved') throw new CoreError('CONFLICT', 'Parallel integration approval is still pending');

    const project = this.engine.repository.getProject(lane.projectId);
    const git = new ParallelGit(project.rootPath);
    git.primary.requireClean();
    if (git.primary.branch() !== lane.baseBranch || git.primary.head() !== lane.targetHead) {
      return this.store.update(lane.id, {
        status: 'REVIEW', approvalId: null, targetHead: null,
        error: 'Primary HEAD or branch changed after integration approval; request a fresh integration preview',
      });
    }
    const worker = git.snapshot(lane.worktreePath);
    if (worker.dirty || worker.head !== lane.resultHead || worker.branch !== lane.branchName) {
      throw new CoreError('CONFLICT', 'Parallel result changed after integration approval');
    }

    lane = this.store.update(lane.id, { status: 'INTEGRATING', validation: [], error: null });
    const merged = git.mergeNoCommit(lane.branchName);
    if (!merged.ok) {
      if (git.mergeHead()) git.abortMerge();
      return this.store.update(lane.id, {
        status: 'REVIEW', approvalId: null, targetHead: null, error: `Merge conflict: ${merged.detail}`,
      });
    }

    const staged = git.cachedDiff();
    const validation = validate(project.rootPath);
    const validationChangedFiles = !git.unstagedClean() || git.cachedDiff() !== staged;
    const passed = validation.every(item => item.status === 'PASS') && !validationChangedFiles;
    if (!passed) {
      git.abortMerge();
      return this.store.update(lane.id, {
        status: 'REVIEW',
        approvalId: null,
        targetHead: null,
        validation,
        error: validationChangedFiles
          ? 'Validation modified tracked merge content; integration was aborted'
          : 'Integration validation failed; merge was aborted before commit',
      });
    }

    try {
      const integrationCommit = git.commit(`parallel: integrate task ${lane.taskId.slice(0, 8)}`);
      const task = this.engine.repository.getTask(lane.taskId);
      if (task.status === 'reviewing') this.engine.repository.setTaskStatus(task.id, 'passed');
      return this.store.update(lane.id, {
        status: 'COMPLETED', integrationCommit, validation, error: null,
      });
    } catch (error) {
      if (git.mergeHead()) git.abortMerge();
      return this.store.update(lane.id, {
        status: 'RECOVERY_REQUIRED', validation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  recover(laneId: string): ParallelLane {
    const lane = this.store.get(laneId);
    if (lane.status !== 'RECOVERY_REQUIRED') throw new CoreError('INVALID_TRANSITION', 'Parallel lane does not require recovery');
    const project = this.engine.repository.getProject(lane.projectId);
    const git = new ParallelGit(project.rootPath);
    const mergeHead = git.mergeHead();

    if (mergeHead) {
      if (lane.resultHead === mergeHead && lane.targetHead === git.primary.head()) {
        git.abortMerge();
        return this.store.update(lane.id, {
          status: 'REVIEW', approvalId: null, targetHead: null,
          error: 'Interrupted parallel integration was safely aborted',
        });
      }
      throw new CoreError('CONFLICT', 'Unknown merge state requires manual review');
    }

    const currentHead = git.primary.head();
    if (currentHead && lane.targetHead && lane.resultHead
      && git.parent(currentHead, 1) === lane.targetHead && git.parent(currentHead, 2) === lane.resultHead) {
      const task = this.engine.repository.getTask(lane.taskId);
      if (task.status === 'reviewing') this.engine.repository.setTaskStatus(task.id, 'passed');
      return this.store.update(lane.id, {
        status: 'COMPLETED', integrationCommit: currentHead, error: null,
      });
    }

    if (!git.exists(lane.worktreePath)) throw new CoreError('CONFLICT', 'Managed worktree is missing');
    const worker = git.snapshot(lane.worktreePath);
    if (worker.branch !== lane.branchName) throw new CoreError('CONFLICT', 'Managed worktree branch changed');

    const task = this.engine.repository.getTask(lane.taskId);
    if (task.status === 'reviewing' && !worker.dirty && worker.head && worker.head !== lane.baseHead) {
      return this.store.update(lane.id, {
        status: 'REVIEW', resultHead: worker.head,
        changedFiles: git.changedFiles(lane.baseHead, worker.head), error: null,
      });
    }
    if (task.status === 'ready' || task.status === 'waiting_provider') {
      const run = this.engine.startRun(task.id);
      return this.store.update(lane.id, { status: 'WORKING', runId: run.id, error: null });
    }
    throw new CoreError('CONFLICT', 'Parallel lane cannot be recovered automatically in the current task state');
  }

  release(laneId: string): ParallelLane {
    const lane = this.store.get(laneId);
    if (lane.status !== 'COMPLETED' || !lane.resultHead) throw new CoreError('INVALID_TRANSITION', 'Only completed lanes can be released');
    const project = this.engine.repository.getProject(lane.projectId);
    const git = new ParallelGit(project.rootPath);
    git.primary.requireClean();
    const primaryHead = git.primary.head();
    if (!primaryHead || !git.isAncestor(lane.resultHead, primaryHead)) {
      throw new CoreError('CONFLICT', 'Parallel result is not integrated into the primary branch');
    }
    git.remove(lane.worktreePath, lane.branchName);
    return this.store.update(lane.id, { status: 'RELEASED', error: null });
  }
}
