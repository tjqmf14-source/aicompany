import { resolve } from 'node:path';
import { CoreEngine } from '../core/engine.js';
import { HandoffCore } from './service.js';
import type { HandoffSession } from './store.js';

const args = process.argv.slice(2);
const engine = new CoreEngine(resolve(process.cwd(), '.ai-company', 'state.sqlite'));
const core = new HandoffCore(engine);
const required = (index: number, name: string): string => {
  const value = args[index];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const summary = (session: HandoffSession) => ({
  id: session.id, status: session.status, provider: session.provider, projectId: session.projectId,
  bundlePath: session.bundlePath, previewPath: session.preview ? resolve(session.bundlePath, '..', 'preview.diff') : null,
  targets: session.preview?.targets ?? [], commands: session.preview?.commands ?? [],
  verification: session.verification, error: session.error,
});

try {
  let output: unknown;
  switch (args[0]) {
    case 'bundle': output = summary(core.create(required(1, 'projectId'), required(2, 'objective'), args[3] ?? null)); break;
    case 'import': output = summary(core.importFile(required(1, 'handoffId'), required(2, 'response JSON path'))); break;
    case 'preview': {
      const session = core.store.get(required(1, 'handoffId'));
      if (!session.preview) throw new Error('No validated preview');
      output = { ...summary(session), diff: session.preview.diff };
      break;
    }
    case 'apply': output = summary(core.apply(required(1, 'handoffId'))); break;
    case 'rollback': output = summary(core.rollback(required(1, 'handoffId'))); break;
    case 'status': output = summary(core.store.get(required(1, 'handoffId'))); break;
    case 'list': output = core.store.list(required(1, 'projectId')).map(summary); break;
    default: throw new Error('Usage: handoff bundle <projectId> <objective> [taskId] | import <handoffId> <response.json> | preview <handoffId> | apply <handoffId> | rollback <handoffId> | status <handoffId> | list <projectId>');
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  if (args[0] === 'apply' && (output as { status: string }).status !== 'verified') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  engine.close();
}
