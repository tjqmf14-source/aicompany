import { execFileSync } from 'node:child_process';
import { CoreError } from '../core/domain.js';
import { validateRelativePath } from './paths.js';
import type { HighResponse } from './schema.js';

export interface PatchTarget { path: string; kind: 'modify' | 'create' }

function newFilePreview(path: string, content: string): string {
  const normalized = content.replaceAll('\r\n', '\n');
  const endsWithNewline = normalized.endsWith('\n');
  const lines = normalized ? normalized.split('\n') : [];
  if (endsWithNewline) lines.pop();
  const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
  if (!lines.length) return header;
  const body = lines.map((line, index) => `+${line}\n${!endsWithNewline && index === lines.length - 1 ? '\\ No newline at end of file\n' : ''}`).join('');
  return `${header}@@ -0,0 +1,${lines.length} @@\n${body}`;
}

function gitApply(root: string, args: string[], patch: string): string {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', 'apply', ...args, '-'], {
      cwd: root, input: patch, encoding: 'utf8', windowsHide: true,
      timeout: 10_000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    throw new CoreError('INVALID_INPUT', `Patch rejected by git apply: ${String(stderr ?? error).slice(0, 4000)}`);
  }
}

export function parsePatchTargets(patch: string, root: string): PatchTarget[] {
  if (!patch.trim() || patch.length > 3_000_000 || patch.includes('\0')) throw new CoreError('INVALID_INPUT', 'Patch is empty or too large');
  const normalized = patch.replaceAll('\r\n', '\n');
  const starts = [...normalized.matchAll(/^diff --git /gm)].map(match => match.index);
  if (!starts.length || normalized.slice(0, starts[0]).trim()) throw new CoreError('INVALID_INPUT', 'Expected git-format unified diff');
  const targets: PatchTarget[] = [];
  for (let i = 0; i < starts.length; i++) {
    const section = normalized.slice(starts[i], starts[i + 1] ?? normalized.length);
    const lines = section.split('\n');
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] ?? '');
    if (!header || header[1] !== header[2]) throw new CoreError('INVALID_INPUT', 'Renames and malformed diff headers are unsupported');
    const path = header[1]!;
    const firstHunk = lines.findIndex(line => line.startsWith('@@ '));
    if (firstHunk < 0) throw new CoreError('INVALID_INPUT', 'Patch has no hunks');
    const metadata = lines.slice(0, firstHunk);
    const oldHeaders = metadata.filter(line => line.startsWith('--- '));
    const newHeaders = metadata.filter(line => line.startsWith('+++ '));
    if (oldHeaders.length !== 1 || newHeaders.length !== 1 || newHeaders[0] !== `+++ b/${path}`) throw new CoreError('INVALID_INPUT', 'Invalid unified diff file headers');
    const create = oldHeaders[0] === '--- /dev/null';
    if (!create && oldHeaders[0] !== `--- a/${path}`) throw new CoreError('INVALID_INPUT', 'Invalid unified diff source path');
    if (metadata.some(line => /^(?:rename |copy |old mode |new mode |deleted file mode |GIT binary patch|Binary files |Submodule )/.test(line)
      || /^index 160000\b/.test(line) || (line.startsWith('new file mode ') && line !== 'new file mode 100644'))) {
      throw new CoreError('INVALID_INPUT', 'Rename, deletion, mode, binary and submodule patches are unsupported');
    }
    if (create && !metadata.includes('new file mode 100644')) throw new CoreError('INVALID_INPUT', 'New file patch must declare regular file mode');
    if (!create && metadata.some(line => line.startsWith('new file mode '))) throw new CoreError('INVALID_INPUT', 'Unexpected new file mode');
    validateRelativePath(root, path, !create);
    targets.push({ path, kind: create ? 'create' : 'modify' });
  }
  const gitPaths = gitApply(root, ['--numstat', '-z'], normalized).split('\0').filter(Boolean).map(row => {
    const match = /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/.exec(row);
    if (!match) throw new CoreError('INVALID_INPUT', 'Unexpected git patch pathname encoding');
    return match[1]!;
  });
  if (gitPaths.length !== targets.length || gitPaths.some((path, index) => path !== targets[index]?.path)) {
    throw new CoreError('INVALID_INPUT', 'Git patch paths differ from validated paths');
  }
  return targets;
}

export function validatePatchSet(root: string, response: HighResponse, performDryRun = true): { targets: PatchTarget[]; combinedPatch: string; preview: string } {
  const combinedPatch = response.patches.map(value => value.replaceAll('\r\n', '\n').trimEnd() + '\n').join('');
  const targets = combinedPatch ? parsePatchTargets(combinedPatch, root) : [];
  const seen = new Set<string>();
  for (const target of targets) {
    const key = target.path.toLowerCase();
    if (seen.has(key)) throw new CoreError('INVALID_INPUT', 'Duplicate patch target');
    seen.add(key);
  }
  for (const file of response.newFiles) {
    validateRelativePath(root, file.path, false);
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new CoreError('INVALID_INPUT', 'New file conflicts with patch target');
    seen.add(key);
    targets.push({ path: file.path, kind: 'create' });
  }
  if (combinedPatch && performDryRun) gitApply(root, ['--check', '--whitespace=error'], combinedPatch);
  const filePreview = response.newFiles.map(file => newFilePreview(file.path, file.content)).join('');
  return { targets, combinedPatch, preview: combinedPatch + filePreview };
}

export function applyPatch(root: string, patch: string): void {
  if (patch) gitApply(root, ['--whitespace=error'], patch);
}
