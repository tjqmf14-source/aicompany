import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, readFileSync, realpathSync, statSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { CoreEngine } from '../core/engine.js';
import { isWithin } from '../core/git-manager.js';
import { sanitizedProcessEnv } from '../security/environment.js';
import { detectSecretKinds, redactSensitive } from '../security/redaction.js';
import { AssuranceStore } from './store.js';
import type {
  AssuranceCheck, AssuranceRunDetail, AssuranceState, RecoverySourceKind,
} from './types.js';

interface CommandResult {
  status: number | null;
  output: string;
  error: string | null;
}

interface RecoveryActive {
  sourceKind: RecoverySourceKind;
  sourceId: string;
  blocked: boolean;
  action: string;
  evidence: Record<string, unknown>;
}

const MAX_SCAN_FILE = 2 * 1024 * 1024;
const now = (): string => new Date().toISOString();

function command(
  executable: string,
  args: string[],
  cwd: string,
  timeout = 120_000,
): CommandResult {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout,
    maxBuffer: 5 * 1024 * 1024,
    env: sanitizedProcessEnv({ CI: '1', NO_COLOR: '1' }),
  });
  const output = redactSensitive(`${result.stdout ?? ''}\n${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`);
  return {
    status: result.status,
    output,
    error: result.error ? redactSensitive(result.error.message, 4000) : null,
  };
}

function npm(root: string, args: string[]): CommandResult {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    const quoted = args.map(item => /^[A-Za-z0-9:_-]+$/.test(item) ? item : `"${item.replaceAll('"', '')}"`);
    return command(comspec, ['/d', '/s', '/c', `npm.cmd ${quoted.join(' ')}`], root);
  }
  return command('npm', args, root);
}

function git(root: string, args: string[], timeout = 30_000): CommandResult {
  return command('git', ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args], root, timeout);
}

function scriptMap(root: string): Record<string, string> | null {
  const path = resolve(root, 'package.json');
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size > 1024 * 1024) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) return {};
    return Object.fromEntries(Object.entries(parsed.scripts as Record<string, unknown>)
      .filter((item): item is [string, string] => typeof item[1] === 'string'));
  } catch {
    return null;
  }
}

function statusFromChecks(checks: AssuranceCheck[]): 'PASS' | 'WARN' | 'FAIL' {
  if (checks.some(item => item.result === 'FAIL' || item.result === 'NOT_RUN')) return 'FAIL';
  if (checks.some(item => item.result === 'WARN')) return 'WARN';
  return 'PASS';
}

function sameGitState(
  left: { head: string | null; branch: string | null; diff: string; changes: unknown[] },
  right: { head: string | null; branch: string | null; diff: string; changes: unknown[] },
): boolean {
  return left.head === right.head
    && left.branch === right.branch
    && left.diff === right.diff
    && JSON.stringify(left.changes) === JSON.stringify(right.changes);
}

function textFile(buffer: Buffer): boolean {
  return !buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

export class AssuranceService {
  readonly store: AssuranceStore;

  constructor(readonly engine: CoreEngine) {
    this.store = new AssuranceStore(engine.database);
  }

  state(projectId: string): AssuranceState {
    this.engine.repository.getProject(projectId);
    return this.store.state(projectId);
  }

  private base(projectId: string): { head: string | null; branch: string | null; root: string } {
    const project = this.engine.repository.getProject(projectId);
    try {
      const snapshot = this.engine.git(projectId).snapshot();
      return { head: snapshot.head, branch: snapshot.branch, root: snapshot.rootPath };
    } catch {
      return { head: null, branch: null, root: project.rootPath };
    }
  }

  securityAudit(projectId: string): AssuranceRunDetail {
    const base = this.base(projectId);
    const run = this.store.createRun(projectId, 'SECURITY', base.head, base.branch);
    const add = (input: Omit<Parameters<AssuranceStore['addCheck']>[1], 'category'>) =>
      this.store.addCheck(run.id, { ...input, category: 'SECURITY' });

    try {
      const quick = this.engine.database.db.prepare('PRAGMA quick_check').all() as Record<string, unknown>[];
      const values = quick.flatMap(row => Object.values(row).map(String));
      add({
        checkKey: 'sqlite_quick_check', severity: 'ERROR',
        result: values.length > 0 && values.every(value => value.toLowerCase() === 'ok') ? 'PASS' : 'FAIL',
        detail: values.length > 0 && values.every(value => value.toLowerCase() === 'ok')
          ? 'SQLite quick_check returned ok'
          : 'SQLite quick_check reported a database integrity problem',
        evidence: { rowCount: quick.length },
      });
    } catch (error) {
      add({
        checkKey: 'sqlite_quick_check', severity: 'ERROR', result: 'FAIL',
        detail: 'SQLite quick_check could not run',
        evidence: { error: redactSensitive(error instanceof Error ? error.message : String(error), 1000) },
      });
    }

    try {
      const foreign = this.engine.database.db.prepare('PRAGMA foreign_key_check').all() as Record<string, unknown>[];
      add({
        checkKey: 'sqlite_foreign_keys', severity: 'ERROR',
        result: foreign.length === 0 ? 'PASS' : 'FAIL',
        detail: foreign.length === 0 ? 'No SQLite foreign-key violations' : 'SQLite foreign-key violations were found',
        evidence: { violationCount: foreign.length },
      });
    } catch (error) {
      add({
        checkKey: 'sqlite_foreign_keys', severity: 'ERROR', result: 'FAIL',
        detail: 'SQLite foreign_key_check could not run',
        evidence: { error: redactSensitive(error instanceof Error ? error.message : String(error), 1000) },
      });
    }

    try {
      const project = this.engine.repository.getProject(projectId);
      const gitManager = this.engine.git(projectId);
      const canonical = realpathSync(project.rootPath);
      const ok = canonical === gitManager.rootPath && Boolean(gitManager.head()) && Boolean(gitManager.branch());
      add({
        checkKey: 'repository_identity', severity: 'ERROR', result: ok ? 'PASS' : 'FAIL',
        detail: ok ? 'Project root, Git root, branch and HEAD are consistent' : 'Project root or Git identity is inconsistent',
        evidence: {
          rootMatches: canonical === gitManager.rootPath,
          hasHead: Boolean(gitManager.head()),
          hasBranch: Boolean(gitManager.branch()),
        },
      });
    } catch (error) {
      add({
        checkKey: 'repository_identity', severity: 'ERROR', result: 'FAIL',
        detail: 'Repository identity could not be verified',
        evidence: { error: redactSensitive(error instanceof Error ? error.message : String(error), 1000) },
      });
    }

    const tracked = git(base.root, ['ls-files', '-z']);
    const trackedFiles = tracked.status === 0 ? tracked.output.split('\0').filter(Boolean) : [];
    if (tracked.status !== 0) {
      add({
        checkKey: 'tracked_files', severity: 'ERROR', result: 'FAIL',
        detail: 'Tracked file list could not be read',
        evidence: { error: tracked.output.slice(0, 1000) },
      });
    } else {
      add({
        checkKey: 'tracked_files', severity: 'INFO', result: 'PASS',
        detail: 'Tracked file inventory captured without shell execution',
        evidence: { trackedCount: trackedFiles.length },
      });
    }

    const externalLinks: { path: string; reason: string }[] = [];
    const fileSecrets: { path: string; kinds: string[] }[] = [];
    for (const relativePath of trackedFiles) {
      const full = resolve(base.root, relativePath);
      if (!isWithin(base.root, full)) {
        externalLinks.push({ path: relativePath, reason: 'path_escape' });
        continue;
      }
      try {
        const linkStat = lstatSync(full);
        if (linkStat.isSymbolicLink()) {
          try {
            const target = realpathSync(full);
            if (!isWithin(base.root, target)) externalLinks.push({ path: relativePath, reason: 'external_symlink' });
          } catch {
            externalLinks.push({ path: relativePath, reason: 'broken_symlink' });
          }
          continue;
        }
        if (!linkStat.isFile() || linkStat.size > MAX_SCAN_FILE) continue;
        const buffer = readFileSync(full);
        if (!textFile(buffer)) continue;
        const kinds = detectSecretKinds(buffer.toString('utf8'));
        if (kinds.length) fileSecrets.push({ path: relativePath, kinds });
      } catch {
        externalLinks.push({ path: relativePath, reason: 'unreadable_tracked_path' });
      }
    }
    add({
      checkKey: 'tracked_symlink_boundary', severity: 'ERROR',
      result: externalLinks.length ? 'FAIL' : 'PASS',
      detail: externalLinks.length ? 'Tracked path escapes or unreadable symlinks were found' : 'No tracked path escapes the repository boundary',
      evidence: { findings: externalLinks.slice(0, 100), count: externalLinks.length },
    });
    add({
      checkKey: 'tracked_secret_scan', severity: 'ERROR',
      result: fileSecrets.length ? 'FAIL' : 'PASS',
      detail: fileSecrets.length ? 'Secret-like material was found in tracked text files' : 'No supported secret pattern was found in scanned tracked files',
      evidence: { findings: fileSecrets.slice(0, 100), count: fileSecrets.length, maxFileBytes: MAX_SCAN_FILE },
    });

    const dbSources: { table: string; query: string }[] = [
      { table: 'tasks', query: "SELECT id, description AS value FROM tasks WHERE project_id = ?" },
      { table: 'decisions', query: "SELECT id, summary || char(10) || rationale AS value FROM decisions WHERE project_id = ?" },
      { table: 'events', query: "SELECT id, payload_json AS value FROM events WHERE project_id = ?" },
      { table: 'handoffs', query: "SELECT id, COALESCE(response_json,'') || char(10) || COALESCE(error,'') AS value FROM handoffs WHERE project_id = ?" },
      { table: 'codex_executions', query: "SELECT id, COALESCE(last_event_json,'') || char(10) || COALESCE(error,'') AS value FROM codex_executions WHERE project_id = ?" },
      { table: 'capability_registry_v2', query: "SELECT id, details_json AS value FROM capability_registry_v2 WHERE project_id = ?" },
      { table: 'capability_operations', query: "SELECT id, preview_json || char(10) || snapshot_json || char(10) || COALESCE(error,'') AS value FROM capability_operations WHERE project_id = ?" },
    ];
    const dbSecrets: { table: string; id: string; kinds: string[] }[] = [];
    for (const source of dbSources) {
      const rows = this.engine.database.db.prepare(source.query).all(projectId) as { id: string; value: unknown }[];
      for (const row of rows) {
        const kinds = detectSecretKinds(String(row.value ?? ''));
        if (kinds.length) dbSecrets.push({ table: source.table, id: String(row.id), kinds });
      }
    }
    add({
      checkKey: 'stored_secret_scan', severity: 'ERROR',
      result: dbSecrets.length ? 'FAIL' : 'PASS',
      detail: dbSecrets.length ? 'Secret-like material was found in durable project records' : 'No supported secret pattern was found in scanned durable records',
      evidence: { findings: dbSecrets.slice(0, 100), count: dbSecrets.length },
    });

    const paidMutations = this.engine.database.db.prepare(`
      SELECT o.id, o.kind, c.name, c.cost_state
      FROM capability_operations o
      JOIN capability_registry_v2 c ON c.id = o.capability_id
      WHERE o.project_id = ?
        AND o.status = 'COMPLETED'
        AND o.kind IN ('INSTALL','VERIFY_MCP','ENABLE')
        AND c.cost_state IN ('UNKNOWN_COST','PAID','USAGE_BASED_PAID')
    `).all(projectId) as { id: string; kind: string; name: string; cost_state: string }[];
    const paidRuntime = this.engine.database.db.prepare(`
      SELECT id, name, cost_state
      FROM capability_registry_v2
      WHERE project_id = ?
        AND runtime_state = 'VERIFIED'
        AND cost_state IN ('UNKNOWN_COST','PAID','USAGE_BASED_PAID')
    `).all(projectId) as { id: string; name: string; cost_state: string }[];
    add({
      checkKey: 'zero_cost_enforcement', severity: 'ERROR',
      result: paidMutations.length || paidRuntime.length ? 'FAIL' : 'PASS',
      detail: paidMutations.length || paidRuntime.length
        ? 'A paid or unknown-cost capability has execution evidence'
        : 'No paid or unknown-cost capability execution evidence was found',
      evidence: {
        mutations: paidMutations.map(item => ({ id: item.id, kind: item.kind, name: item.name, cost: item.cost_state })).slice(0, 100),
        runtime: paidRuntime.map(item => ({ id: item.id, name: item.name, cost: item.cost_state })).slice(0, 100),
      },
    });

    const checks = this.store.checks(run.id);
    const status = statusFromChecks(checks);
    return this.store.finish(run.id, status, {
      checkedAt: now(),
      checkCount: checks.length,
      failures: checks.filter(item => item.result === 'FAIL').length,
      warnings: checks.filter(item => item.result === 'WARN').length,
    });
  }

  recoveryAudit(projectId: string): AssuranceRunDetail {
    const base = this.base(projectId);
    const run = this.store.createRun(projectId, 'RECOVERY', base.head, base.branch);
    const active: RecoveryActive[] = [];
    const addActive = (
      sourceKind: RecoverySourceKind,
      sourceId: string,
      blocked: boolean,
      action: string,
      evidence: Record<string, unknown> = {},
    ) => active.push({ sourceKind, sourceId, blocked, action, evidence });

    const interrupted = this.engine.database.db.prepare(`
      SELECT r.id, r.task_id, r.error
      FROM runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.project_id = ? AND r.status = 'interrupted' AND t.status = 'waiting_provider'
    `).all(projectId) as { id: string; task_id: string; error: string | null }[];
    for (const row of interrupted) addActive(
      'RUN', row.id, false,
      'Review the interrupted task, then resume its provider path or cancel the task explicitly.',
      { taskId: row.task_id, error: row.error ? redactSensitive(row.error, 1000) : null },
    );

    const handoffs = this.engine.database.db.prepare(
      "SELECT id, task_id, error FROM handoffs WHERE project_id = ? AND status = 'recovery_required'",
    ).all(projectId) as { id: string; task_id: string | null; error: string | null }[];
    for (const row of handoffs) addActive(
      'HANDOFF', row.id, false,
      'Use the existing Handoff rollback/recovery path after reviewing the recorded checkpoint.',
      { taskId: row.task_id, error: row.error ? redactSensitive(row.error, 1000) : null },
    );

    const codex = this.engine.database.db.prepare(
      "SELECT id, task_id, error FROM codex_executions WHERE project_id = ? AND status = 'recovery_required'",
    ).all(projectId) as { id: string; task_id: string; error: string | null }[];
    for (const row of codex) addActive(
      'CODEX', row.id, false,
      'Use Codex recovery to create/refresh a checkpoint and return the task to HIGH_READY.',
      { taskId: row.task_id, error: row.error ? redactSensitive(row.error, 1000) : null },
    );

    const lanes = this.engine.database.db.prepare(
      "SELECT id, task_id, error FROM parallel_lanes WHERE project_id = ? AND status = 'RECOVERY_REQUIRED'",
    ).all(projectId) as { id: string; task_id: string; error: string | null }[];
    for (const row of lanes) addActive(
      'PARALLEL', row.id, false,
      'Use the Phase 7 lane recovery endpoint; unknown Git states must remain blocked for manual review.',
      { taskId: row.task_id, error: row.error ? redactSensitive(row.error, 1000) : null },
    );

    const operations = this.engine.database.db.prepare(
      "SELECT id, kind, error FROM capability_operations WHERE project_id = ? AND status = 'RUNNING'",
    ).all(projectId) as { id: string; kind: string; error: string | null }[];
    for (const row of operations) addActive(
      'CAPABILITY', row.id, true,
      'A capability mutation was left RUNNING. Inspect filesystem/checkpoint evidence before marking the operation failed or rolling it back.',
      { kind: row.kind, error: row.error ? redactSensitive(row.error, 1000) : null },
    );

    for (const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply']) {
      const pathResult = git(base.root, ['rev-parse', '--git-path', name]);
      if (pathResult.status !== 0) continue;
      const raw = pathResult.output.trim();
      if (!raw) continue;
      const path = isAbsolute(raw) ? raw : resolve(base.root, raw);
      if (existsSync(path)) {
        addActive(
          'GIT', name, true,
          'Primary repository contains an unfinished Git operation. Resolve or safely abort it before automated mutation.',
          { state: name },
        );
      }
    }

    const activeKeys = new Set(active.map(item => `${item.sourceKind}:${item.sourceId}`));
    for (const item of active) {
      this.store.syncIncident({
        projectId,
        sourceKind: item.sourceKind,
        sourceId: item.sourceId,
        active: true,
        blocked: item.blocked,
        action: item.action,
        evidence: item.evidence,
      });
    }
    for (const incident of this.store.incidents(projectId)) {
      const key = `${incident.sourceKind}:${incident.sourceId}`;
      if (!activeKeys.has(key) && incident.status !== 'RESOLVED') {
        this.store.syncIncident({
          projectId,
          sourceKind: incident.sourceKind,
          sourceId: incident.sourceId,
          active: false,
          blocked: false,
          action: incident.action,
          evidence: incident.evidence,
        });
      }
    }

    const current = this.store.incidents(projectId).filter(item => item.status !== 'RESOLVED');
    this.store.addCheck(run.id, {
      checkKey: 'recovery_incidents', category: 'RECOVERY',
      severity: current.some(item => item.status === 'BLOCKED') ? 'ERROR' : current.length ? 'WARN' : 'INFO',
      result: current.some(item => item.status === 'BLOCKED') ? 'FAIL' : current.length ? 'WARN' : 'PASS',
      detail: current.length
        ? 'Recovery manager found unresolved state that requires an explicit recovery path'
        : 'No unresolved recovery state was found',
      evidence: {
        open: current.filter(item => item.status === 'OPEN').length,
        blocked: current.filter(item => item.status === 'BLOCKED').length,
        sources: current.map(item => ({ kind: item.sourceKind, id: item.sourceId, status: item.status })).slice(0, 100),
      },
    });

    const checks = this.store.checks(run.id);
    const status = statusFromChecks(checks);
    return this.store.finish(run.id, status, {
      checkedAt: now(),
      activeIncidents: current.length,
      blockedIncidents: current.filter(item => item.status === 'BLOCKED').length,
    });
  }

  qa(projectId: string): AssuranceRunDetail {
    const snapshot = this.engine.git(projectId).snapshot();
    const root = snapshot.rootPath;
    const run = this.store.createRun(projectId, 'QA', snapshot.head, snapshot.branch);
    const add = (input: Omit<Parameters<AssuranceStore['addCheck']>[1], 'category'>) =>
      this.store.addCheck(run.id, { ...input, category: 'QA' });

    add({
      checkKey: 'clean_worktree', severity: 'ERROR',
      result: snapshot.dirty ? 'FAIL' : 'PASS',
      detail: snapshot.dirty ? 'QA release gate requires a clean primary worktree' : 'Primary worktree is clean',
      evidence: { changedFiles: snapshot.changes.map(item => item.path).slice(0, 100) },
    });

    const scripts = scriptMap(root);
    if (!scripts) {
      add({
        checkKey: 'package_scripts', severity: 'ERROR', result: 'FAIL',
        detail: 'package.json is missing, unreadable or too large for the Node QA profile',
        evidence: {},
      });
    } else {
      add({
        checkKey: 'package_scripts', severity: 'INFO', result: 'PASS',
        detail: 'package.json scripts were parsed without executing project code',
        evidence: { available: Object.keys(scripts).sort() },
      });
    }

    if (snapshot.dirty || !scripts) {
      for (const key of ['git_diff_check','typecheck','lint','test','build','npm_audit','workspace_unchanged']) {
        add({
          checkKey: key, severity: 'ERROR', result: 'NOT_RUN',
          detail: 'QA step not run because the release preflight failed',
          evidence: {},
        });
      }
      const checks = this.store.checks(run.id);
      return this.store.finish(run.id, 'FAIL', {
        checkedAt: now(), checkCount: checks.length,
        failures: checks.filter(item => item.result === 'FAIL' || item.result === 'NOT_RUN').length,
      });
    }

    const diffCheck = git(root, ['diff-tree', '--check', '--root', '-r', 'HEAD']);
    add({
      checkKey: 'git_diff_check', severity: 'ERROR',
      result: diffCheck.status === 0 && !diffCheck.error ? 'PASS' : 'FAIL',
      detail: diffCheck.status === 0 && !diffCheck.error ? 'Git whitespace check passed for HEAD' : 'Git whitespace check failed',
      evidence: { exitCode: diffCheck.status, output: diffCheck.output },
    });

    for (const name of ['typecheck','lint','test','build'] as const) {
      if (!scripts[name]) {
        add({
          checkKey: name, severity: 'ERROR', result: 'FAIL',
          detail: `Required npm script "${name}" is missing`, evidence: {},
        });
        continue;
      }
      const result = npm(root, ['run', name]);
      add({
        checkKey: name, severity: 'ERROR',
        result: result.status === 0 && !result.error ? 'PASS' : 'FAIL',
        detail: result.status === 0 && !result.error ? `npm run ${name} passed` : `npm run ${name} failed`,
        evidence: { exitCode: result.status, output: result.output },
      });
    }

    const audit = npm(root, ['audit', '--audit-level=high']);
    add({
      checkKey: 'npm_audit', severity: 'ERROR',
      result: audit.status === 0 && !audit.error ? 'PASS' : 'FAIL',
      detail: audit.status === 0 && !audit.error ? 'npm audit reported no high-or-higher vulnerability gate failure' : 'npm audit failed the high severity gate',
      evidence: { exitCode: audit.status, output: audit.output },
    });

    const after = this.engine.git(projectId).snapshot();
    add({
      checkKey: 'workspace_unchanged', severity: 'ERROR',
      result: sameGitState(snapshot, after) ? 'PASS' : 'FAIL',
      detail: sameGitState(snapshot, after)
        ? 'QA commands did not mutate tracked/untracked repository state'
        : 'QA commands changed repository state',
      evidence: {
        headBefore: snapshot.head, headAfter: after.head,
        branchBefore: snapshot.branch, branchAfter: after.branch,
        changesBefore: snapshot.changes.map(item => item.path),
        changesAfter: after.changes.map(item => item.path),
      },
    });

    const checks = this.store.checks(run.id);
    const status = statusFromChecks(checks);
    return this.store.finish(run.id, status, {
      checkedAt: now(),
      checkCount: checks.length,
      failures: checks.filter(item => item.result === 'FAIL' || item.result === 'NOT_RUN').length,
      passes: checks.filter(item => item.result === 'PASS').length,
    });
  }
}
