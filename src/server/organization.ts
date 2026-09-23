import type { FastifyInstance } from 'fastify';
import { CoreError } from '../core/domain.js';
import { CoreEngine } from '../core/engine.js';
import { HandoffCore } from '../handoff/service.js';
import { CodexAppServerProvider } from '../codex/provider.js';
import { CodexExecutionService } from '../codex/service.js';
import { GATE_KINDS, GATE_RESULTS, type GateKind, type GateResult } from '../organization/types.js';
import { OrganizationService } from '../organization/service.js';

type ProjectParams = { id: string };
type PlanParams = { id: string; planId: string };
type TaskParams = { id: string; taskId: string };

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', 'Expected JSON object');
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new CoreError('INVALID_INPUT', `${label} must be a non-empty string`);
  return value;
};
const optionalText = (value: unknown): string => value === undefined ? '' : text(value, 'evidence');
const gateKind = (value: unknown): GateKind => {
  if (typeof value !== 'string' || !GATE_KINDS.includes(value as GateKind)) throw new CoreError('INVALID_INPUT', 'Invalid gate kind');
  return value as GateKind;
};
const gateResult = (value: unknown): GateResult => {
  if (typeof value !== 'string' || !GATE_RESULTS.includes(value as GateResult)) throw new CoreError('INVALID_INPUT', 'Invalid gate result');
  return value as GateResult;
};

export function registerOrganizationRoutes(app: FastifyInstance, engine: CoreEngine): void {
  const organization = new OrganizationService(engine);
  const handoff = new HandoffCore(engine);
  const codex = new CodexExecutionService(engine, new CodexAppServerProvider());

  app.get<{ Params: ProjectParams }>('/api/organization/projects/:id', async request =>
    organization.state(request.params.id));

  app.post<{ Params: ProjectParams }>('/api/organization/projects/:id/plans', async (request, reply) =>
    reply.code(201).send(organization.createPlan(request.params.id, request.body)));

  app.post<{ Params: PlanParams }>('/api/organization/projects/:id/plans/:planId/start', async request => {
    const plan = organization.store.get(request.params.planId);
    if (plan.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Organization plan not in project');
    return organization.start(plan.id);
  });

  app.post<{ Params: PlanParams }>('/api/organization/projects/:id/plans/:planId/refresh', async request => {
    const plan = organization.store.get(request.params.planId);
    if (plan.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Organization plan not in project');
    return organization.refresh(plan.id);
  });

  app.post<{ Params: PlanParams }>('/api/organization/projects/:id/plans/:planId/advance', async request => {
    const plan = organization.store.get(request.params.planId);
    if (plan.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Organization plan not in project');
    return organization.advance(plan.id);
  });

  app.post<{ Params: PlanParams }>('/api/organization/projects/:id/plans/:planId/gates', async request => {
    const plan = organization.store.get(request.params.planId);
    if (plan.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Organization plan not in project');
    const body = object(request.body);
    return organization.recordGate(
      plan.id,
      gateKind(body.kind),
      gateResult(body.result),
      text(body.summary, 'summary'),
      optionalText(body.evidence),
    );
  });

  app.post<{ Params: PlanParams }>('/api/organization/projects/:id/plans/:planId/rework', async request => {
    const plan = organization.store.get(request.params.planId);
    if (plan.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Organization plan not in project');
    return organization.rework(plan.id);
  });

  app.get<{ Params: TaskParams }>('/api/organization/projects/:id/tasks/:taskId/route', async request => {
    const task = engine.repository.getTask(request.params.taskId);
    if (task.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Task not in project');
    return organization.route(task.id);
  });

  app.post<{ Params: TaskParams }>('/api/organization/projects/:id/tasks/:taskId/dispatch', async request => {
    const task = engine.repository.getTask(request.params.taskId);
    if (task.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Task not in project');
    const route = organization.route(task.id);
    const plan = organization.store.get(route.planId);
    if (route.provider === 'GPT_HIGH') {
      return { provider: route.provider, handoff: handoff.create(plan.projectId, task.description.trim() || task.title, task.id) };
    }
    if (route.provider === 'CODEX') {
      return { provider: route.provider, execution: await codex.dispatch(task.id, task.description.trim() || task.title) };
    }
    return {
      provider: route.provider,
      status: 'READY_FOR_DETERMINISTIC_SYSTEM_ACTION',
      taskId: task.id,
      message: 'SYSTEM tasks require a specific deterministic primitive; generic auto-completion is not allowed.',
    };
  });
}
