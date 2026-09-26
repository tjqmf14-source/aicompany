import Fastify, { type FastifyInstance } from 'fastify';
import { CoreEngine } from '../core/engine.js';
import { CoreError } from '../core/domain.js';
import { schemaVersion } from '../core/migrations.js';
import { registerDashboardRoutes } from './dashboard.js';
import { registerOrganizationRoutes } from './organization.js';
import { registerCapabilityRoutes } from './capabilities.js';
import { registerParallelRoutes } from './parallel.js';
import { registerSecurityRoutes } from './security.js';

type Params = { id: string };
type TaskParams = { id: string; taskId: string };
type RunParams = { id: string; taskId: string; runId: string };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', 'Expected JSON object');
  return value as Record<string, unknown>;
};
const string = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new CoreError('INVALID_INPUT', `${field} must be a string`);
  return value;
};
const optionalVersion = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new CoreError('INVALID_INPUT', 'version must be a positive integer');
  return Number(value);
};

export function createApp(engine: CoreEngine): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.split(':')[0]?.replace(/^\[|\]$/g, '').toLowerCase() ?? '';
    if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      return reply.code(403).send({ error: 'LOCAL_ONLY', message: 'AI Company API accepts loopback hosts only' });
    }
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CoreError) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' || error.code === 'DIRTY_WORKTREE' || error.code === 'INVALID_TRANSITION' ? 409 : 400;
      void reply.code(status).send({ error: error.code, message: error.message });
      return;
    }
    if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      void reply.code(409).send({ error: 'CONFLICT', message: 'Record already exists' });
      return;
    }
    void reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  app.get('/health', async () => ({ status: 'ok', schemaVersion: schemaVersion(engine.database.db), recoveredRuns: engine.recoveredRuns }));
  app.get('/api/projects', async () => engine.repository.listProjects());
  app.post('/api/projects', async (request, reply) => {
    const body = object(request.body);
    return reply.code(201).send(engine.createProject(string(body.name, 'name'), string(body.rootPath, 'rootPath')));
  });
  app.get<{ Params: Params }>('/api/projects/:id', async request => engine.repository.getProject(request.params.id));
  app.patch<{ Params: Params }>('/api/projects/:id/status', async request => {
    const body = object(request.body);
    return engine.repository.setProjectStatus(request.params.id, string(body.status, 'status'), optionalVersion(body.version));
  });
  app.get<{ Params: Params }>('/api/projects/:id/tasks', async request => engine.repository.listTasks(request.params.id));
  app.post<{ Params: Params }>('/api/projects/:id/tasks', async (request, reply) => {
    const body = object(request.body);
    return reply.code(201).send(engine.repository.createTask(request.params.id, string(body.title, 'title'), body.description === undefined ? '' : string(body.description, 'description')));
  });
  app.patch<{ Params: TaskParams }>('/api/projects/:id/tasks/:taskId/status', async request => {
    const task = engine.repository.getTask(request.params.taskId);
    if (task.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Task not in project');
    const body = object(request.body);
    return engine.repository.setTaskStatus(task.id, string(body.status, 'status'), optionalVersion(body.version));
  });
  app.post<{ Params: TaskParams }>('/api/projects/:id/tasks/:taskId/runs', async (request, reply) => {
    const task = engine.repository.getTask(request.params.taskId);
    if (task.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Task not in project');
    return reply.code(201).send(engine.startRun(task.id));
  });
  app.get<{ Params: TaskParams }>('/api/projects/:id/tasks/:taskId/runs', async request => {
    const task = engine.repository.getTask(request.params.taskId);
    if (task.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Task not in project');
    return engine.repository.listRuns(task.id);
  });
  app.post<{ Params: RunParams }>('/api/projects/:id/tasks/:taskId/runs/:runId/finish', async request => {
    const run = engine.repository.getRun(request.params.runId);
    if (run.projectId !== request.params.id || run.taskId !== request.params.taskId) throw new CoreError('NOT_FOUND', 'Run not in task');
    const body = object(request.body);
    const result = string(body.result, 'result');
    if (result !== 'completed' && result !== 'failed' && result !== 'cancelled') throw new CoreError('INVALID_INPUT', 'Invalid run result');
    return engine.repository.finishRun(run.id, result, body.error === undefined ? null : string(body.error, 'error'));
  });
  app.get<{ Params: Params }>('/api/projects/:id/git', async request => engine.git(request.params.id).snapshot());
  app.post<{ Params: Params }>('/api/projects/:id/checkpoints', async (request, reply) => {
    const body = object(request.body);
    return reply.code(201).send(engine.checkpoint(request.params.id, body.note === undefined ? '' : string(body.note, 'note')));
  });
  app.get<{ Params: Params }>('/api/projects/:id/checkpoints', async request => engine.repository.listCheckpoints(request.params.id));
  app.get<{ Params: Params }>('/api/projects/:id/events', async request => engine.repository.listEvents(request.params.id));
  app.get<{ Params: Params }>('/api/projects/:id/artifacts', async request => engine.repository.listArtifacts(request.params.id));
  app.get<{ Params: Params }>('/api/projects/:id/decisions', async request => engine.repository.listDecisions(request.params.id));
  app.get<{ Params: Params }>('/api/projects/:id/approvals', async request => engine.repository.listApprovals(request.params.id));
  app.get('/api/capabilities', async () => engine.repository.listCapabilities());
  registerOrganizationRoutes(app, engine);
  registerCapabilityRoutes(app, engine);
  registerParallelRoutes(app, engine);
  registerSecurityRoutes(app, engine);
  registerDashboardRoutes(app, engine);
  return app;
}
