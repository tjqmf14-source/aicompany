import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CoreEngine } from '../core/engine.js';
import { GitManager, isWithin } from '../core/git-manager.js';
import { testEvidenceFailure } from '../core/qa-evidence.js';
import { redactSensitive } from '../core/redaction.js';
import { assertNoLinkedComponents } from '../core/path-safety.js';
import { SecurityStore } from './store.js';
import type {
  QaCheck, RecoveryState, SecurityAudit, SecurityCheck, SecurityState,
} from './types.js';

const MAX_SCAN_FILES = 3000;
const MAX_SCAN_BYTES = 1024 * 1024;

function command(root: string, executable: string, args: string[], timeout = 120_000) {
  const result = spawnSync(executable, args, {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout,
    maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout,
    stderr,
    output: redactSensitive(`${stdout}\n${stderr}${result.error ? `\n${result.error.message}` : ''}`, Number.MAX_SAFE_INTEGER).slice(-20_000),
  };
}

function git(root: string, args: string[], timeout = 20_000) {
  return command(root, 'git', ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args], timeout);
}

function trackedFiles(root: string): { files: string[]; error: string | null } {
  const listed = git(root, ['ls-files', '-z']);
  if (!listed.ok) return { files: [], error: listed.output };
  return { files: listed.stdout.split('\0').filter(Boolean), error: null };
}

function trackedPathSafety(root: string, files: string[]): SecurityCheck {
  const unsafe: string[] = [];
  for (const relativePath of files) {
    if (unsafe.length >= 20) break;
    const full = resolve(root, relativePath);
    try {
      assertNoLinkedComponents(root, full);
      if (!isWithin(root, full)) {
        unsafe.push(`${relativePath} (escapes repository)`);
        continue;
      }
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        unsafe.push(`${relativePath} (symlink or junction)`);
        continue;
      }
      const canonical = realpathSync(full);
      if (!isWithin(root, canonical)) unsafe.push(`${relativePath} (canonical path escapes repository)`);
      else if (!stat.isFile()) unsafe.push(`${relativePath} (not a regular file)`);
    } catch {
      unsafe.push(`${relativePath} (missing or unreadable)`);
    }
  }
  return unsafe.length
    ? { key: 'tracked_path_safety', status: 'FAIL', summary: 'Unsafe tracked filesystem paths detected', evidence: unsafe.join(', ').slice(0, 4000) }
    : { key: 'tracked_path_safety', status: 'PASS', summary: 'Tracked paths are regular files contained by the repository', evidence: `validated ${files.length} tracked paths` };
}

function secretScan(root: string, files: string[]): SecurityCheck {
  if (files.length > MAX_SCAN_FILES) {
    return {
      key: 'tracked_secret_scan', status: 'WARN',
      summary: 'Tracked secret scan did not cover every file',
      evidence: `${files.length} tracked files exceeds the ${MAX_SCAN_FILES} file limit`,
    };
  }
  const sensitiveNames = files.filter(path => {
    const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
    return name === '.env' || (name.startsWith('.env.') && name !== '.env.example' && name !== '.env.sample');
  });
  if (sensitiveNames.length) {
    return {
      key: 'tracked_secret_scan', status: 'FAIL',
      summary: 'Tracked environment files require review',
      evidence: sensitiveNames.join(', ').slice(0, 4000),
    };
  }

  const findings: string[] = [];
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /OPENAI_API_KEY\s*[:=]\s*['"]?sk-[A-Za-z0-9_-]{12,}/i,
    /ANTHROPIC_API_KEY\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}/i,
    /github_pat_[A-Za-z0-9_]{20,}/i,
    /ghp_[A-Za-z0-9]{20,}/,
  ];
  const skipped: string[] = [];
  for (const relativePath of files) {
    if (findings.length >= 20) break;
    const full = resolve(root, relativePath);
    try {
      assertNoLinkedComponents(root, full);
      const stat = lstatSync(full);
      const canonical = realpathSync(full);
      if (stat.isSymbolicLink() || !stat.isFile() || !isWithin(root, canonical)) continue;
      if (stat.size > MAX_SCAN_BYTES) {
        if (skipped.length < 20) skipped.push(relativePath);
        continue;
      }
      const buffer = readFileSync(canonical);
      if (buffer.includes(0)) continue;
      const text = buffer.toString('utf8');
      if (patterns.some(pattern => pattern.test(text))) findings.push(relativePath);
    } catch {
      if (skipped.length < 20) skipped.push(relativePath);
    }
  }
  if (findings.length) return { key: 'tracked_secret_scan', status: 'FAIL', summary: 'Potential secret material found in tracked files', evidence: findings.join(', ') };
  if (skipped.length) return {
    key: 'tracked_secret_scan', status: 'WARN', summary: 'Tracked secret scan was incomplete',
    evidence: `unreadable or over ${MAX_SCAN_BYTES} bytes: ${skipped.join(', ')}`.slice(0, 4000),
  };
  return { key: 'tracked_secret_scan', status: 'PASS', summary: 'No known high-risk secret pattern found in scanned tracked files', evidence: `scanned ${files.length} tracked files` };
}

function stateConsistency(engine: CoreEngine, projectId: string, root: string): SecurityCheck {
  const problems: string[] = [];
  const db = engine.database.db;
  const record = (value: string) => { if (problems.length < 30) problems.push(value); };

  try {
    if (realpathSync(root) !== engine.git(projectId).rootPath) record('Project root no longer matches the canonical Git root');
  } catch {
    record('Project root or Git repository is unreadable');
  }

  const checkpoints = db.prepare('SELECT id, snapshot_json FROM checkpoints WHERE project_id = ?').all(projectId) as { id: string; snapshot_json: string }[];
  for (const row of checkpoints) {
    try {
      const snapshot = JSON.parse(row.snapshot_json) as { rootPath?: unknown; head?: unknown };
      if (snapshot.rootPath !== root) record(`Checkpoint ${row.id} references a different repository root`);
      if (typeof snapshot.head === 'string' && snapshot.head && !git(root, ['cat-file', '-e', `${snapshot.head}^{commit}`]).ok) {
        record(`Checkpoint ${row.id} references an unreadable Git commit`);
      }
    } catch {
      record(`Checkpoint ${row.id} contains invalid evidence`);
    }
  }

  const lanes = db.prepare(`SELECT id, task_id, status, branch_name, worktree_path, base_head, result_head,
    approval_id FROM parallel_lanes WHERE project_id = ? AND status NOT IN ('FAILED','RELEASED')`).all(projectId) as {
      id: string; task_id: string; status: string; branch_name: string; worktree_path: string;
      base_head: string; result_head: string | null; approval_id: string | null;
    }[];
  const desiredWorktreeRoot = resolve(dirname(root), '.ai-company-worktrees', basename(root));
  for (const lane of lanes) {
    if (!git(root, ['cat-file', '-e', `${lane.base_head}^{commit}`]).ok) record(`Parallel lane ${lane.id} base commit is unreadable`);
    if (lane.result_head && !git(root, ['cat-file', '-e', `${lane.result_head}^{commit}`]).ok) record(`Parallel lane ${lane.id} result commit is unreadable`);
    if (lane.status !== 'RECOVERY_REQUIRED') {
      try {
        const stat = lstatSync(lane.worktree_path);
        const canonicalRoot = realpathSync(desiredWorktreeRoot);
        const canonicalLane = realpathSync(lane.worktree_path);
        if (stat.isSymbolicLink() || !stat.isDirectory() || !isWithin(canonicalRoot, canonicalLane)) {
          record(`Parallel lane ${lane.id} worktree path is unsafe`);
        } else {
          const worktree = new GitManager(canonicalLane).snapshot();
          if (worktree.branch !== lane.branch_name) record(`Parallel lane ${lane.id} branch does not match durable state`);
          if (['READY'].includes(lane.status) && worktree.head !== lane.base_head) record(`Parallel lane ${lane.id} HEAD does not match its base`);
          if (['REVIEW','APPROVAL_PENDING','INTEGRATING','COMPLETED'].includes(lane.status) && worktree.head !== lane.result_head) {
            record(`Parallel lane ${lane.id} HEAD does not match its submitted result`);
          }
        }
      } catch {
        record(`Parallel lane ${lane.id} worktree is missing or unreadable`);
      }
    }
    if (lane.status === 'APPROVAL_PENDING') {
      const approval = lane.approval_id
        ? db.prepare('SELECT project_id, task_id, action FROM approvals WHERE id = ?').get(lane.approval_id) as { project_id: string; task_id: string | null; action: string } | undefined
        : undefined;
      const expected = `parallel.integrate:${lane.id}:${lane.result_head ?? ''}`;
      if (!approval || approval.project_id !== projectId || approval.task_id !== lane.task_id || approval.action !== expected) {
        record(`Parallel lane ${lane.id} approval is stale or bound to different state`);
      }
    }
  }

  return problems.length
    ? { key: 'state_consistency', status: 'FAIL', summary: 'Database, filesystem and Git state are inconsistent', evidence: problems.join('; ').slice(0, 4000) }
    : { key: 'state_consistency', status: 'PASS', summary: 'Database, filesystem and Git evidence are consistent', evidence: `${checkpoints.length} checkpoint(s), ${lanes.length} unreleased lane(s) checked` };
}

export class SecurityService {
  readonly store: SecurityStore;

  constructor(readonly engine: CoreEngine) {
    this.store = new SecurityStore(engine.database);
  }

  recoverStartupQa(): number { return this.store.recoverRunningQa(); }

  recovery(projectId: string): RecoveryState {
    this.engine.repository.getProject(projectId);
    const db = this.engine.database.db;
    const interruptedRuns = Number((db.prepare("SELECT count(*) AS count FROM runs WHERE project_id = ? AND status = 'interrupted'").get(projectId) as { count: number }).count);
    const recoveryHandoffs = Number((db.prepare("SELECT count(*) AS count FROM handoffs WHERE project_id = ? AND status = 'recovery_required'").get(projectId) as { count: number }).count);
    const recoveryCodex = Number((db.prepare("SELECT count(*) AS count FROM codex_executions WHERE project_id = ? AND status = 'recovery_required'").get(projectId) as { count: number }).count);
    const recoveryParallel = Number((db.prepare("SELECT count(*) AS count FROM parallel_lanes WHERE project_id = ? AND status = 'RECOVERY_REQUIRED'").get(projectId) as { count: number }).count);
    const runningQa = Number((db.prepare("SELECT count(*) AS count FROM qa_runs WHERE project_id = ? AND status = 'RUNNING'").get(projectId) as { count: number }).count);
    const blockers: string[] = [];
    if (recoveryHandoffs) blockers.push(`${recoveryHandoffs} handoff(s) require recovery`);
    if (recoveryCodex) blockers.push(`${recoveryCodex} Codex execution(s) require recovery`);
    if (recoveryParallel) blockers.push(`${recoveryParallel} parallel lane(s) require recovery`);
    if (runningQa) blockers.push(`${runningQa} QA run(s) are still running`);
    return { projectId, blockers, interruptedRuns, recoveryHandoffs, recoveryCodex, recoveryParallel, runningQa };
  }

  audit(projectId: string): SecurityAudit {
    const project = this.engine.repository.getProject(projectId);
    const checks: SecurityCheck[] = [];
    const db = this.engine.database.db;

    const quick = db.prepare('PRAGMA quick_check').all() as Record<string, unknown>[];
    const quickValues = quick.flatMap(row => Object.values(row).map(String));
    checks.push(quickValues.length === 1 && quickValues[0] === 'ok'
      ? { key: 'sqlite_quick_check', status: 'PASS', summary: 'SQLite quick_check passed', evidence: 'ok' }
      : { key: 'sqlite_quick_check', status: 'FAIL', summary: 'SQLite quick_check reported problems', evidence: quickValues.join('; ').slice(0, 4000) });

    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    checks.push(foreignKeys.length === 0
      ? { key: 'sqlite_foreign_keys', status: 'PASS', summary: 'No SQLite foreign-key violations', evidence: '0 violations' }
      : { key: 'sqlite_foreign_keys', status: 'FAIL', summary: 'SQLite foreign-key violations detected', evidence: JSON.stringify(foreignKeys).slice(0, 4000) });

    const repository = git(project.rootPath, ['rev-parse', '--verify', 'HEAD']);
    checks.push(repository.ok
      ? { key: 'git_head', status: 'PASS', summary: 'Git HEAD is readable', evidence: repository.stdout.trim().slice(0, 200) }
      : { key: 'git_head', status: 'FAIL', summary: 'Git HEAD cannot be verified', evidence: repository.output });

    const unresolvedMarkers: string[] = ([
      ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'],
    ] as const).flatMap(([marker, label]) =>
      git(project.rootPath, ['rev-parse', '-q', '--verify', marker]).ok ? [label] : []);
    const gitDir = git(project.rootPath, ['rev-parse', '--git-dir']);
    if (gitDir.ok) {
      const base = resolve(project.rootPath, gitDir.stdout.trim());
      if (existsSync(join(base, 'rebase-merge')) || existsSync(join(base, 'rebase-apply'))) unresolvedMarkers.push('rebase');
    }
    checks.push(unresolvedMarkers.length
      ? { key: 'git_operation_state', status: 'FAIL', summary: 'Unfinished Git operation detected', evidence: unresolvedMarkers.join(', ') }
      : { key: 'git_operation_state', status: 'PASS', summary: 'No unfinished merge/rebase/cherry-pick/revert state', evidence: 'clean operation state' });

    const snapshot = this.engine.git(projectId).snapshot();
    checks.push(snapshot.dirty
      ? { key: 'working_tree', status: 'WARN', summary: 'Working tree contains uncommitted changes', evidence: snapshot.changes.map(item => `${item.code} ${item.path}`).join('\n').slice(0, 4000) }
      : { key: 'working_tree', status: 'PASS', summary: 'Working tree is clean', evidence: `${snapshot.branch ?? 'detached'} @ ${snapshot.head ?? 'no HEAD'}` });

    const tracked = trackedFiles(project.rootPath);
    if (tracked.error) {
      checks.push({ key: 'tracked_path_safety', status: 'FAIL', summary: 'Tracked file list could not be read', evidence: tracked.error });
      checks.push({ key: 'tracked_secret_scan', status: 'FAIL', summary: 'Tracked secret scan could not start', evidence: tracked.error });
    } else {
      checks.push(trackedPathSafety(project.rootPath, tracked.files));
      checks.push(secretScan(project.rootPath, tracked.files));
    }

    checks.push(stateConsistency(this.engine, projectId, project.rootPath));

    const recovery = this.recovery(projectId);
    checks.push(recovery.blockers.length
      ? { key: 'recovery_blockers', status: 'BLOCKED', summary: 'Recovery-required state blocks release readiness', evidence: recovery.blockers.join('; ') }
      : { key: 'recovery_blockers', status: 'PASS', summary: 'No unresolved recovery-required state', evidence: `interrupted historical runs: ${recovery.interruptedRuns}` });

    const status = checks.some(item => item.status === 'FAIL' || item.status === 'BLOCKED')
      ? 'FAIL'
      : checks.some(item => item.status === 'WARN') ? 'WARN' : 'PASS';
    return this.store.addAudit(projectId, status, checks);
  }

  runQa(projectId: string) {
    const project = this.engine.repository.getProject(projectId);
    const snapshot = this.engine.git(projectId).snapshot();
    const qa = this.store.startQa(projectId, snapshot.head, snapshot.branch);
    const checks: QaCheck[] = [];
    const windows = process.platform === 'win32';
    const npm = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
    const npmArgs = (args: string[]) => windows ? ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`] : args;

    const specs: { name: QaCheck['name']; executable: string; args: string[]; timeout?: number }[] = [
      { name: 'git_diff_check', executable: 'git', args: ['diff', '--check', 'HEAD', '--'], timeout: 30_000 },
      { name: 'typecheck', executable: npm, args: npmArgs(['run', 'typecheck']) },
      { name: 'lint', executable: npm, args: npmArgs(['run', 'lint']) },
      { name: 'test', executable: npm, args: npmArgs(['test']), timeout: 180_000 },
      { name: 'build', executable: npm, args: npmArgs(['run', 'build']), timeout: 180_000 },
      { name: 'npm_audit', executable: npm, args: npmArgs(['audit', '--audit-level=high']), timeout: 120_000 },
    ];
    try {
      for (const spec of specs) {
        const result = command(project.rootPath, spec.executable, spec.args, spec.timeout);
        const evidenceFailure = spec.name === 'test' && result.ok
          ? testEvidenceFailure(`${result.stdout}\n${result.stderr}`)
          : null;
        checks.push({
          name: spec.name,
          status: result.ok && !evidenceFailure ? 'PASS' : 'FAIL',
          exitCode: result.status,
          output: evidenceFailure ? `${result.output}\nQA evidence failure: ${evidenceFailure}`.slice(0, 20_000) : result.output,
        });
        this.store.saveProgress(qa.id, checks);
      }
      const gitAfter = this.engine.git(projectId).snapshot();
      const sourceChanged = gitAfter.head !== snapshot.head
        || gitAfter.branch !== snapshot.branch
        || gitAfter.diff !== snapshot.diff
        || JSON.stringify(gitAfter.changes) !== JSON.stringify(snapshot.changes);
      if (sourceChanged) {
        checks.push({ name: 'git_diff_check', status: 'FAIL', exitCode: null, output: 'QA changed repository state from its starting snapshot' });
      }
      const passed = checks.every(item => item.status === 'PASS');
      return this.store.finishQa(qa.id, passed ? 'PASS' : 'FAIL', checks, passed ? null : 'One or more QA checks failed');
    } catch (error) {
      return this.store.finishQa(qa.id, 'FAIL', checks, redactSensitive(error instanceof Error ? error.message : String(error)));
    }
  }

  state(projectId: string): SecurityState {
    this.engine.repository.getProject(projectId);
    const latestAudit = this.store.latestAudit(projectId);
    const latestQa = this.store.latestQa(projectId);
    const recovery = this.recovery(projectId);
    let currentMatches = false;
    try {
      const current = this.engine.git(projectId).snapshot();
      currentMatches = !current.dirty && !!current.head && current.head === latestQa?.baseHead
        && current.branch === latestQa?.baseBranch
        && latestAudit?.checks.find(check => check.key === 'git_head')?.evidence === current.head;
    } catch { /* Missing repository state cannot be release ready. */ }
    const releaseReady = currentMatches && latestAudit?.status === 'PASS'
      && latestQa?.status === 'PASS'
      && recovery.blockers.length === 0
      && latestAudit.createdAt >= latestQa.finishedAt!;
    return { latestAudit, latestQa, recovery, releaseReady };
  }
}
