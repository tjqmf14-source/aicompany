import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { CoreError } from '../core/domain.js';
import { GitManager } from '../core/git-manager.js';

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(cwd: string, args: string[], timeout = 20_000): GitResult {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new CoreError('CONFLICT', `Git command failed: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

function checked(cwd: string, args: string[], timeout = 20_000): string {
  const result = run(cwd, args, timeout);
  if (result.status !== 0) throw new CoreError('CONFLICT', `Git command failed: ${result.stderr.trim() || args.join(' ')}`);
  return result.stdout;
}

function within(root: string, candidate: string): boolean {
  const part = relative(root, candidate);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

export class ParallelGit {
  readonly primary: GitManager;
  readonly worktreeRoot: string;

  constructor(primaryPath: string) {
    this.primary = new GitManager(primaryPath);
    const desired = resolve(dirname(this.primary.rootPath), '.ai-company-worktrees', basename(this.primary.rootPath));
    if (existsSync(desired) && lstatSync(desired).isSymbolicLink()) throw new CoreError('INVALID_INPUT', 'Parallel worktree root must not be a symlink');
    mkdirSync(desired, { recursive: true });
    this.worktreeRoot = realpathSync(desired);
  }

  pathFor(laneId: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(laneId)) throw new CoreError('INVALID_INPUT', 'Invalid lane id');
    const target = resolve(this.worktreeRoot, laneId);
    if (!within(this.worktreeRoot, target)) throw new CoreError('INVALID_INPUT', 'Worktree path escapes managed root');
    return target;
  }

  create(branchName: string, worktreePath: string, baseHead: string): void {
    if (!/^ai-company\/parallel\/[a-f0-9-]+$/i.test(branchName)) throw new CoreError('INVALID_INPUT', 'Invalid managed branch');
    const target = resolve(worktreePath);
    if (!within(this.worktreeRoot, target) || existsSync(target)) throw new CoreError('CONFLICT', 'Managed worktree destination is unavailable');
    checked(this.primary.rootPath, ['rev-parse', '--verify', `${baseHead}^{commit}`]);
    checked(this.primary.rootPath, ['worktree', 'add', '-b', branchName, target, baseHead], 60_000);
  }

  snapshot(worktreePath: string) {
    const target = realpathSync(resolve(worktreePath));
    if (!within(this.worktreeRoot, target)) throw new CoreError('INVALID_INPUT', 'Worktree is outside managed root');
    return new GitManager(target).snapshot();
  }

  exists(worktreePath: string): boolean {
    return existsSync(resolve(worktreePath));
  }

  isAncestor(base: string, head: string): boolean {
    const result = run(this.primary.rootPath, ['merge-base', '--is-ancestor', base, head]);
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new CoreError('CONFLICT', `Cannot compare Git ancestry: ${result.stderr.trim()}`);
  }

  changedFiles(base: string, head: string): string[] {
    const output = checked(this.primary.rootPath, ['diff', '--name-only', '-z', `${base}..${head}`, '--']);
    return output.split('\0').filter(Boolean).sort();
  }

  mergeNoCommit(branchName: string): { ok: boolean; detail: string } {
    const result = run(this.primary.rootPath, [
      '-c', 'user.name=AI Company Bridge',
      '-c', 'user.email=ai-company@local.invalid',
      'merge', '--no-ff', '--no-commit', branchName,
    ], 60_000);
    return { ok: result.status === 0, detail: (result.stderr || result.stdout).trim().slice(0, 4000) };
  }

  abortMerge(): void {
    const result = run(this.primary.rootPath, ['merge', '--abort']);
    if (result.status !== 0) throw new CoreError('CONFLICT', `Unable to abort merge: ${result.stderr.trim()}`);
  }

  mergeHead(): string | null {
    const result = run(this.primary.rootPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    return result.status === 0 ? result.stdout.trim() : null;
  }

  parent(head: string, number: 1 | 2): string | null {
    const result = run(this.primary.rootPath, ['rev-parse', '-q', '--verify', `${head}^${number}`]);
    return result.status === 0 ? result.stdout.trim() : null;
  }

  cachedDiff(): string {
    return checked(this.primary.rootPath, ['diff', '--cached', '--binary', '--']);
  }

  unstagedClean(): boolean {
    const result = run(this.primary.rootPath, ['diff', '--quiet', '--']);
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new CoreError('CONFLICT', `Cannot inspect unstaged changes: ${result.stderr.trim()}`);
  }

  commit(message: string): string {
    checked(this.primary.rootPath, [
      '-c', 'user.name=AI Company Bridge',
      '-c', 'user.email=ai-company@local.invalid',
      'commit', '-m', message,
    ], 60_000);
    return this.primary.head() ?? (() => { throw new CoreError('CONFLICT', 'Integration commit was not created'); })();
  }

  remove(worktreePath: string, branchName: string): void {
    const target = realpathSync(resolve(worktreePath));
    if (!within(this.worktreeRoot, target)) throw new CoreError('INVALID_INPUT', 'Worktree is outside managed root');
    new GitManager(target).requireClean();
    checked(this.primary.rootPath, ['worktree', 'remove', target], 60_000);
    checked(this.primary.rootPath, ['branch', '-d', branchName], 30_000);
  }
}
