import { lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CoreError } from './domain.js';

// Inspect every component, including dangling links and Windows junctions.
export function assertNoLinkedComponents(root: string, candidate: string): string {
  const base = resolve(root);
  const target = resolve(candidate);
  const part = relative(base, target);
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new CoreError('INVALID_INPUT', 'Path escapes its allowed root');
  }
  let current = base;
  for (const component of ['', ...part.split(sep).filter(Boolean)]) {
    if (component) current = join(current, component);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new CoreError('INVALID_INPUT', 'Path contains a symlink or junction');
  }
  return target;
}
