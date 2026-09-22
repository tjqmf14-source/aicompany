import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CoreError } from '../core/domain.js';
import { isWithin } from '../core/git-manager.js';

const forbidden = new Set(['.git', '.ai-company', 'node_modules', 'dist', '.npmrc', '.gitmodules']);

export function validateRelativePath(rootPath: string, input: string, mustExist: boolean): { path: string; fullPath: string; exists: boolean } {
  if (!input || input.length > 500 || input.includes('\\') || input.includes(':') || [...input].some(char => char.charCodeAt(0) < 32) || isAbsolute(input)) {
    throw new CoreError('INVALID_INPUT', 'Invalid workspace path');
  }
  const parts = input.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)
    || forbidden.has(part.toLowerCase()) || part.toLowerCase().startsWith('.env'))) {
    throw new CoreError('INVALID_INPUT', 'Path escapes or targets protected workspace content');
  }
  const root = realpathSync(resolve(rootPath));
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isSymbolicLink()) throw new CoreError('INVALID_INPUT', 'Symbolic links are not valid patch targets');
      if (index < parts.length - 1 && !stat.isDirectory()) throw new CoreError('INVALID_INPUT', 'Parent is not a directory');
      if (index === parts.length - 1 && !stat.isFile()) throw new CoreError('INVALID_INPUT', 'Target is not a regular file');
      const canonical = realpathSync(current);
      if (!isWithin(root, canonical)) throw new CoreError('INVALID_INPUT', 'Path escapes workspace');
    }
  }
  const fullPath = resolve(root, ...parts);
  if (!isWithin(root, fullPath)) throw new CoreError('INVALID_INPUT', 'Path escapes workspace');
  const present = !!lstatSync(fullPath, { throwIfNoEntry: false });
  if (mustExist && !present) throw new CoreError('INVALID_INPUT', 'Patch target does not exist');
  if (!mustExist && present) throw new CoreError('CONFLICT', 'New file already exists');
  return { path: parts.join('/'), fullPath, exists: present };
}

export function validateResponseFile(rootPath: string, filePath: string): string {
  const root = realpathSync(resolve(rootPath));
  const full = realpathSync(resolve(filePath));
  if (!isWithin(root, full) || !lstatSync(full).isFile()) throw new CoreError('INVALID_INPUT', 'Response file must be inside project workspace');
  const rel = relative(root, full);
  if (!rel) throw new CoreError('INVALID_INPUT', 'Invalid response file');
  return full;
}
