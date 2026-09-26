import type { FastifyInstance } from 'fastify';
import { CoreError } from '../core/domain.js';
import { CoreEngine } from '../core/engine.js';
import { ParallelService } from '../parallel/service.js';

type ProjectParams = { id: string };
type TaskParams = { id: string; taskId: string };
type LaneParams = { id: string; laneId: string };

function object(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', 'Expected JSON object');
  return value as Record<string, unknown>;
}

function scopes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new CoreError('INVALID_INPUT', 'scopePaths must contain strings');
  if (value.length > 100) throw new CoreError('INVALID_INPUT', 'scopePaths may contain at most 100 paths');
  return value as string[];
}

function reason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new CoreError('INVALID_INPUT', 'reason must be a non-empty string');
  return value.trim();
}

export function registerParallelRoutes(app: FastifyInstance, engine: CoreEngine): void {
  const parallel = new ParallelService(engine);
  parallel.recoverStartupStates();

  const laneForProject = (projectId: string, laneId: string) => {
    const lane = parallel.store.get(laneId);
    if (lane.projectId !== projectId) throw new CoreError('NOT_FOUND', 'Parallel lane not in project');
    return lane;
  };

  app.get<{ Params: ProjectParams }>('/api/parallel/projects/:id', async request =>
    parallel.state(request.params.id));

  app.post<{ Params: TaskParams }>('/api/parallel/projects/:id/tasks/:taskId/lanes', async (request, reply) => {
    const task = engine.repository.getTask(request.params.taskId);
    if (task.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Task not in project');
    const body = object(request.body);
    return reply.code(201).send(parallel.create(task.id, scopes(body.scopePaths)));
  });

  app.post<{ Params: LaneParams }>('/api/parallel/projects/:id/lanes/:laneId/start', async request => {
    laneForProject(request.params.id, request.params.laneId);
    return parallel.start(request.params.laneId);
  });

  app.post<{ Params: LaneParams }>('/api/parallel/projects/:id/lanes/:laneId/submit', async request => {
    laneForProject(request.params.id, request.params.laneId);
    return parallel.submit(request.params.laneId);
  });

  app.post<{ Params: LaneParams }>('/api/parallel/projects/:id/lanes/:laneId/fail', async request => {
    laneForProject(request.params.id, request.params.laneId);
    return parallel.fail(request.params.laneId, reason(object(request.body).reason));
  });

  app.post<{ Params: LaneParams }>('/api/parallel/projects/:id/lanes/:laneId/integration-request', async request => {
    laneForProject(request.params.id, request.params.laneId);
    return parallel.requestIntegration(request.params.laneId);
  });

  app.post<{ Params: LaneParams }>('/api/parallel/projects/:id/lanes/:laneId/integrate', async request => {
    laneForProject(request.params.id, request.params.laneId);
    return parallel.integrate(request.params.laneId);
  });

  app.post<{ Params: LaneParams }>('/api/parallel/projects/:id/lanes/:laneId/recover', async request => {
    laneForProject(request.params.id, request.params.laneId);
    return parallel.recover(request.params.laneId);
  });

  app.post<{ Params: LaneParams }>('/api/parallel/projects/:id/lanes/:laneId/release', async request => {
    laneForProject(request.params.id, request.params.laneId);
    return parallel.release(request.params.laneId);
  });
}
