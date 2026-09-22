import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CoreError } from '../core/domain.js';

export const BUNDLE_FILES = [
  'objective.md', 'context.md', 'decisions.md', 'completed.md', 'remaining.md',
  'changed-files.json', 'git.diff', 'tests.json', 'build.json', 'errors.log', 'HANDOFF_PROMPT.md',
] as const;
export type BundleFile = typeof BUNDLE_FILES[number];
export type BundleContent = Record<BundleFile, string>;

export interface HandoffProvider {
  readonly id: string;
  publish(handoffId: string, files: BundleContent): string;
  readResponse(filePath: string): unknown;
}

export class ManualHandoffProvider implements HandoffProvider {
  readonly id = 'manual';
  constructor(private readonly storageRoot: string) {}

  publish(handoffId: string, files: BundleContent): string {
    if (!/^[0-9a-f-]{36}$/.test(handoffId)) throw new CoreError('INVALID_INPUT', 'Invalid handoff ID');
    const bundlePath = resolve(this.storageRoot, 'handoffs', handoffId, 'bundle');
    mkdirSync(bundlePath, { recursive: true });
    for (const name of BUNDLE_FILES) writeFileSync(join(bundlePath, name), files[name], { encoding: 'utf8', flag: 'wx' });
    return bundlePath;
  }

  readResponse(filePath: string): unknown {
    if (statSync(filePath).size > 4_000_000) throw new CoreError('INVALID_INPUT', 'Response JSON exceeds 4 MB');
    try { return JSON.parse(readFileSync(filePath, 'utf8')) as unknown; }
    catch { throw new CoreError('INVALID_INPUT', 'Response file is not valid JSON'); }
  }
}
