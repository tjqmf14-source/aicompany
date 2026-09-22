import { resolve } from 'node:path';
import { CoreEngine } from '../core/engine.js';
import { CodexAppServerProvider } from './provider.js';
import { CodexExecutionService } from './service.js';
import type { CodexEffort } from './types.js';

const args = process.argv.slice(2);
const engine = new CoreEngine(resolve(process.cwd(), '.ai-company', 'state.sqlite'));
const provider = new CodexAppServerProvider();
const service = new CodexExecutionService(engine, provider);
const required = (index: number, name: string): string => {
  const value = args[index];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const effort = (value: string | undefined): CodexEffort | undefined => {
  if (value === undefined) return undefined;
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') return value;
  throw new Error('effort must be low, medium, high, xhigh or max');
};
const summary = (value: ReturnType<typeof service.store.get>) => ({
  id: value.id, projectId: value.projectId, taskId: value.taskId, runId: value.runId,
  status: value.status, provider: value.provider, threadId: value.threadId, turnId: value.turnId,
  model: value.model, effort: value.effort, checkpointId: value.checkpointId, handoffId: value.handoffId,
  rateLimit: value.rateLimit, error: value.error, updatedAt: value.updatedAt,
});

try {
  let output: unknown;
  switch (args[0]) {
    case 'check':
      output = await provider.checkAvailability(process.cwd());
      break;
    case 'run':
      output = summary(await service.dispatch(required(1, 'taskId'), args[2], { model: args[3], effort: effort(args[4]) }));
      break;
    case 'resume':
      output = summary(await service.resume(required(1, 'executionId'), { model: args[2], effort: effort(args[3]) }));
      break;
    case 'recover':
      output = summary(service.recover(required(1, 'executionId')));
      break;
    case 'status':
      output = summary(service.store.get(required(1, 'executionId')));
      break;
    case 'list':
      output = service.store.list(required(1, 'projectId')).map(summary);
      break;
    default:
      throw new Error('Usage: codex check | run <taskId> [objective] [model] [effort] | resume <executionId> [model] [effort] | recover <executionId> | status <executionId> | list <projectId>');
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  engine.close();
}
