import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CoreError, type GitChange, type GitSnapshot } from './domain.js';

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args], {
      cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CoreError('NOT_GIT_REPOSITORY', `Git command failed: ${detail}`);
  }
}

export function isWithin(root: string, target: string): boolean {
  const part = relative(root, target);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

export class GitManager {
  readonly rootPath: string;

  constructor(path: string) {
    let requested: string;
    try { requested = realpathSync(resolve(path)); }
    catch { throw new CoreError('INVALID_INPUT', 'Repository path does not exist'); }
    const root = git(requested, ['rev-parse', '--show-toplevel']).trim();
    this.rootPath = realpathSync(root);
    if (!isWithin(this.rootPath, requested)) throw new CoreError('NOT_GIT_REPOSITORY', 'Path is outside repository');
  }

  resolveExistingPath(relativePath: string): string {
    if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\0')) {
      throw new CoreError('INVALID_INPUT', 'Expected a relative repository path');
    }
    const candidate = resolve(this.rootPath, relativePath);
    if (!isWithin(this.rootPath, candidate) || !existsSync(candidate)) {
      throw new CoreError('INVALID_INPUT', 'Path does not exist inside repository');
    }
    const canonical = realpathSync(candidate);
    if (!isWithin(this.rootPath, canonical)) throw new CoreError('INVALID_INPUT', 'Path escapes repository');
    if (!statSync(canonical).isFile()) throw new CoreError('INVALID_INPUT', 'Artifact path must be a file');
    return canonical;
  }

  head(): string | null {
    try { return git(this.rootPath, ['rev-parse', '--verify', 'HEAD']).trim(); }
    catch { return null; }
  }

  branch(): string | null {
    try { return git(this.rootPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim() || null; }
    catch { return null; }
  }

  status(): GitChange[] {
    const parts = git(this.rootPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
    const changes: GitChange[] = [];
    for (let i = 0; i < parts.length; i++) {
      const item = parts[i];
      if (!item) continue;
      const code = item.slice(0, 2);
      const path = item.slice(3);
      let originalPath: string | null = null;
      if (code.includes('R') || code.includes('C')) originalPath = parts[++i] || null;
      changes.push({ code, path, originalPath });
    }
    return changes;
  }

  diff(): string {
    if (this.head()) return git(this.rootPath, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']);
    return git(this.rootPath, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--cached', '--'])
      + git(this.rootPath, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--']);
  }

  snapshot(): GitSnapshot {
    const changes = this.status();
    return {
      rootPath: this.rootPath, branch: this.branch(), head: this.head(),
      dirty: changes.length > 0, changes, diff: this.diff(), capturedAt: new Date().toISOString(),
    };
  }

  requireClean(): void {
    if (this.status().length) throw new CoreError('DIRTY_WORKTREE', 'Repository has uncommitted changes');
  }
}
