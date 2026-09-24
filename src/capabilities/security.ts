import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CoreError } from '../core/domain.js';

export function sha256Buffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(path: string): string {
  return sha256Buffer(readFileSync(path));
}

export function assertRegularNoSymlink(path: string, label: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new CoreError('INVALID_INPUT', `${label} must not be a symlink or junction`);
  if (!stat.isFile()) throw new CoreError('INVALID_INPUT', `${label} must be a regular file`);
  return realpathSync(path);
}

export function assertDirectoryNoSymlink(path: string, label: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new CoreError('INVALID_INPUT', `${label} must not be a symlink or junction`);
  if (!stat.isDirectory()) throw new CoreError('INVALID_INPUT', `${label} must be a directory`);
  return realpathSync(path);
}

export function assertContained(root: string, candidate: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const part = relative(resolvedRoot, resolvedCandidate);
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new CoreError('INVALID_INPUT', `${label} escapes the allowed root`);
  }
  return resolvedCandidate;
}

export function safeSkillName(value: string): string {
  const name = value.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(name)) {
    throw new CoreError('INVALID_INPUT', 'Skill name must use lowercase letters, digits and hyphens');
  }
  return name;
}

export function redact(text: string, max = 4000): string {
  return text.slice(0, max)
    .replace(/(?:sk|pk|rk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{12,}/gi, '[REDACTED]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[REDACTED]');
}

export function hasSensitiveArgument(args: string[]): boolean {
  return args.some((arg, index) => {
    const lower = arg.toLowerCase();
    if (/token|secret|password|api[-_]?key|credential/.test(lower)) return true;
    const previous = args[index - 1]?.toLowerCase() ?? '';
    return /token|secret|password|api[-_]?key|credential/.test(previous);
  });
}

export function safeExecutable(command: string): string | null {
  if (command === 'node' || command === process.execPath) return process.execPath;
  if (!isAbsolute(command)) return null;
  try {
    const real = assertRegularNoSymlink(command, 'MCP executable');
    const stat = statSync(real);
    return stat.size >= 0 ? real : null;
  } catch {
    return null;
  }
}

export function sanitizedChildEnv(): NodeJS.ProcessEnv {
  const allowed = ['PATH','Path','SYSTEMROOT','SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
