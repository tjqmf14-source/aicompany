import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function fixture(): { path: string; git: (...args: string[]) => string; clean: () => void; commit: () => void } {
  const root = resolve('tests', '.tmp');
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(join(root, 'ai-company-core-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8', windowsHide: true });
  git('init', '-b', 'main');
  writeFileSync(join(path, '.git', 'info', 'exclude'), '*.sqlite*\n.ai-company/\n');
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=Core Test', '-c', 'user.email=core@example.invalid', 'commit', '-m', 'fixture');
  };
  return { path, git, commit, clean: () => {
    const part = relative(root, resolve(path));
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Unsafe fixture cleanup path');
    rmSync(path, { recursive: true, force: true });
  } };
}

export function committedFixture() {
  const test = fixture();
  writeFileSync(join(test.path, 'README.md'), 'original\n');
  test.commit();
  return test;
}
