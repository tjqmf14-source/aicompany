import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../core/domain.js';
import { CoreEngine } from '../core/engine.js';
import { SecurityStore } from './store.js';
import type {
  QaCheck, RecoveryState, SecurityAudit, SecurityCheck, SecurityState,
} from './types.js';

const MAX_SCAN_FILES = 3000;
const MAX_SCAN_BYTES = 1024 * 1024;
const redact = (value: string): string => value
  .replace(/(?:sk|pk|rk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}/gi, '[REDACTED]')
  .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
  .slice(0, 20_000);

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
    output: redact(`${stdout}\n${stderr}${result.error ? `\n${result.error.message}` : ''}`),
  };
}

function git(root: string, args: string[], timeout = 20_000) {
  return command(root, 'git', ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args], timeout);
}

function secretScan(root: string): SecurityCheck {
  const listed = git(root, ['ls-files', '-z']);
  if (!listed.ok) return { key: 'tracked_secret_scan', status: 'FAIL', summary: 'Tracked file list could not be read', evidence: listed.output };
  const files = listed.stdout.split('\0').filter(Boolean).slice(0, MAX_SCAN_FILES);
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
  for (const relativePath of files) {
    if (findings.length >= 20) break;
    const full = join(root, relativePath);
    try {
      const stat = statSync(full);
      if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) continue;
      const buffer = readFileSync(full);
      if (buffer.includes(0)) continue;
      const text = buffer.toString('utf8');
      if (patterns.some(pattern => pattern.test(text))) findings.push(relativePath);
    } catch { /* unreadable files are covered by Git/state checks */ }
  }
  return findings.length
    ? { key: 'tracked_secret_scan', status: 'FAIL', summary: 'Potential secret material found in tracked files', evidence: findings.join(', ') }
    : { key: 'tracked_secret_scan', status: 'PASS', summary: 'No known high-risk secret pattern found in scanned tracked files', evidence: `scanned ${files.length} tracked files` };
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
      const base = gitDir.stdout.trim();
      if (existsSync(join(project.rootPath, base, 'rebase-merge')) || existsSync(join(project.rootPath, base, 'rebase-apply'))) unresolvedMarkers.push('rebase');
    }
    checks.push(unresolvedMarkers.length
      ? { key: 'git_operation_state', status: 'FAIL', summary: 'Unfinished Git operation detected', evidence: unresolvedMarkers.join(', ') }
      : { key: 'git_operation_state', status: 'PASS', summary: 'No unfinished merge/rebase/cherry-pick/revert state', evidence: 'clean operation state' });

    const snapshot = this.engine.git(projectId).snapshot();
    checks.push(snapshot.dirty
      ? { key: 'working_tree', status: 'WARN', summary: 'Working tree contains uncommitted changes', evidence: snapshot.changes.map(item => `${item.code} ${item.path}`).join('\n').slice(0, 4000) }
      : { key: 'working_tree', status: 'PASS', summary: 'Working tree is clean', evidence: `${snapshot.branch ?? 'detached'} @ ${snapshot.head ?? 'no HEAD'}` });

    checks.push(secretScan(project.rootPath));

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
        checks.push({
          name: spec.name,
          status: result.ok ? 'PASS' : 'FAIL',
          exitCode: result.status,
          output: result.output,
        });
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
      return this.store.finishQa(qa.id, 'FAIL', checks, error instanceof Error ? error.message : String(error));
    }
  }

  state(projectId: string): SecurityState {
    this.engine.repository.getProject(projectId);
    const latestAudit = this.store.latestAudit(projectId);
    const latestQa = this.store.latestQa(projectId);
    const recovery = this.recovery(projectId);
    const releaseReady = latestAudit?.status === 'PASS'
      && latestQa?.status === 'PASS'
      && recovery.blockers.length === 0
      && latestAudit.createdAt >= latestQa.finishedAt!;
    return { latestAudit, latestQa, recovery, releaseReady };
  }
}
