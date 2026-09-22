import type { FastifyInstance } from 'fastify';
import { CoreError } from '../core/domain.js';
import { CoreEngine } from '../core/engine.js';
import { HandoffCore } from '../handoff/service.js';
import { CodexAppServerProvider } from '../codex/provider.js';
import { CodexExecutionService } from '../codex/service.js';
import { DashboardService } from '../dashboard/service.js';

type ProjectParams = { id: string };
type ApprovalParams = { id: string; approvalId: string };
type HandoffParams = { id: string; handoffId: string };
type CodexParams = { id: string; executionId: string };

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', 'Expected JSON object');
  return value as Record<string, unknown>;
};
const optionalString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new CoreError('INVALID_INPUT', `${name} must be a non-empty string`);
  return value;
};

export function registerDashboardRoutes(app: FastifyInstance, engine: CoreEngine): void {
  const dashboard = new DashboardService(engine);
  const handoff = new HandoffCore(engine);
  const codex = new CodexExecutionService(engine, new CodexAppServerProvider());

  app.get('/api/dashboard/projects', async () => dashboard.listProjects());
  app.get<{ Params: ProjectParams }>('/api/dashboard/projects/:id', async request => dashboard.projectState(request.params.id));
  app.get<{ Params: ProjectParams }>('/api/dashboard/projects/:id/capabilities', async request => dashboard.capabilities(request.params.id));
  app.get<{ Params: ProjectParams }>('/api/dashboard/projects/:id/settings', async request => dashboard.settings(request.params.id));

  app.get<{ Params: ProjectParams }>('/api/dashboard/projects/:id/stream', async (request, reply) => {
    engine.repository.getProject(request.params.id);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    let last = '';
    const send = (): void => {
      if (closed) return;
      try {
        const fingerprint = dashboard.fingerprint(request.params.id);
        if (fingerprint !== last) {
          last = fingerprint;
          reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(dashboard.realtime(request.params.id))}\n\n`);
        }
      } catch (error) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`);
      }
    };
    const heartbeat = (): void => { if (!closed) reply.raw.write(': heartbeat\n\n'); };
    send();
    const stateTimer = setInterval(send, 1000);
    const heartbeatTimer = setInterval(heartbeat, 15000);
    request.raw.on('close', () => {
      closed = true;
      clearInterval(stateTimer);
      clearInterval(heartbeatTimer);
    });
  });

  app.post<{ Params: ProjectParams }>('/api/dashboard/projects/:id/actions/pause', async request => {
    const project = engine.repository.getProject(request.params.id);
    const running = engine.repository.listTasks(project.id).some(task => engine.repository.listRuns(task.id).some(run => run.status === 'running'));
    if (running) throw new CoreError('CONFLICT', 'Active Run cannot be paused by the dashboard');
    return engine.repository.setProjectStatus(project.id, 'paused', project.version);
  });

  app.post<{ Params: ProjectParams }>('/api/dashboard/projects/:id/actions/resume', async request => {
    const project = engine.repository.getProject(request.params.id);
    if (project.status === 'paused' || project.status === 'blocked' || project.status === 'review') {
      return engine.repository.setProjectStatus(project.id, 'active', project.version);
    }
    const task = [...engine.repository.listTasks(project.id)].reverse().find(item => item.status === 'waiting_user' || item.status === 'waiting_provider');
    if (!task) throw new CoreError('INVALID_TRANSITION', 'Nothing is resumable');
    return engine.repository.setTaskStatus(task.id, 'ready', task.version);
  });

  app.post<{ Params: ProjectParams }>('/api/dashboard/projects/:id/actions/cancel', async request => {
    const tasks = [...engine.repository.listTasks(request.params.id)].reverse();
    const task = tasks.find(item => ['running','waiting_user','waiting_provider','reviewing','ready','queued','failed'].includes(item.status));
    if (!task) throw new CoreError('INVALID_TRANSITION', 'No cancellable task');
    const run = engine.repository.listRuns(task.id).find(item => item.status === 'running');
    return run ? engine.repository.finishRun(run.id, 'cancelled') : engine.repository.setTaskStatus(task.id, 'cancelled', task.version);
  });

  app.post<{ Params: ProjectParams }>('/api/dashboard/projects/:id/actions/checkpoint', async (request, reply) => {
    const body = request.body === undefined ? {} : object(request.body);
    const taskId = optionalString(body.taskId) ?? null;
    const note = optionalString(body.note) ?? 'Dashboard checkpoint';
    return reply.code(201).send(engine.checkpoint(request.params.id, note, taskId));
  });

  app.post<{ Params: ApprovalParams }>('/api/dashboard/projects/:id/approvals/:approvalId/resolve', async request => {
    const body = object(request.body);
    const status = requiredString(body.status, 'status');
    const approval = engine.repository.listApprovals(request.params.id).find(item => item.id === request.params.approvalId);
    if (!approval) throw new CoreError('NOT_FOUND', 'Approval not in project');
    return engine.repository.resolveApproval(approval.id, status);
  });

  app.post<{ Params: ProjectParams }>('/api/dashboard/projects/:id/handoffs', async (request, reply) => {
    const body = object(request.body);
    const taskId = optionalString(body.taskId) ?? null;
    const objective = requiredString(body.objective, 'objective');
    return reply.code(201).send(handoff.create(request.params.id, objective, taskId));
  });

  app.post<{ Params: HandoffParams }>('/api/dashboard/projects/:id/handoffs/:handoffId/import', async request => {
    const session = handoff.store.get(request.params.handoffId);
    if (session.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Handoff not in project');
    const body = object(request.body);
    return handoff.importResponse(session.id, body.response);
  });

  app.post<{ Params: HandoffParams }>('/api/dashboard/projects/:id/handoffs/:handoffId/apply', async request => {
    const session = handoff.store.get(request.params.handoffId);
    if (session.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Handoff not in project');
    return handoff.apply(session.id);
  });

  app.post<{ Params: HandoffParams }>('/api/dashboard/projects/:id/handoffs/:handoffId/rollback', async request => {
    const session = handoff.store.get(request.params.handoffId);
    if (session.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Handoff not in project');
    return handoff.rollback(session.id);
  });

  app.get<{ Params: ProjectParams }>('/api/dashboard/projects/:id/codex/check', async request => {
    const project = engine.repository.getProject(request.params.id);
    const availability = await codex.provider.checkAvailability(project.rootPath);
    return {
      ...availability,
      authenticated: availability.state === 'available' || availability.state === 'rate_limited' ? true : null,
    };
  });

  app.post<{ Params: ProjectParams }>('/api/dashboard/projects/:id/codex/dispatch', async request => {
    const body = object(request.body);
    const taskId = requiredString(body.taskId, 'taskId');
    const task = engine.repository.getTask(taskId);
    if (task.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Task not in project');
    return codex.dispatch(task.id, optionalString(body.objective));
  });

  app.post<{ Params: CodexParams }>('/api/dashboard/projects/:id/codex/:executionId/resume', async request => {
    const execution = codex.store.get(request.params.executionId);
    if (execution.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Codex execution not in project');
    return codex.resume(execution.id);
  });
}
