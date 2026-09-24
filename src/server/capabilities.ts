import type { FastifyInstance } from 'fastify';
import { CoreError } from '../core/domain.js';
import { CoreEngine } from '../core/engine.js';
import { CapabilityManagerService } from '../capabilities/service.js';
import { capabilityOverallStatus } from '../capabilities/types.js';

type ProjectParams = { id: string };
type CapabilityParams = { id: string; capabilityId: string };
type OperationParams = { id: string; operationId: string };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', 'Expected JSON object');
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new CoreError('INVALID_INPUT', `${label} must be a non-empty string`);
  return value;
}

export function registerCapabilityRoutes(app: FastifyInstance, engine: CoreEngine): void {
  const manager = new CapabilityManagerService(engine);

  app.get<{ Params: ProjectParams }>('/api/capability-manager/projects/:id', async request =>
    manager.snapshot(request.params.id));

  app.post<{ Params: ProjectParams }>('/api/capability-manager/projects/:id/discover', async request =>
    manager.discover(request.params.id));

  app.get<{ Params: CapabilityParams }>('/api/capability-manager/projects/:id/capabilities/:capabilityId', async request => {
    const capability = manager.store.get(request.params.capabilityId);
    if (capability.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Capability not in project');
    return {
      ...capability,
      overallStatus: capabilityOverallStatus(capability),
      source: manager.store.latestSource(capability.id),
      dependencies: manager.store.listDependencies(capability.id),
      checks: manager.store.listChecks(capability.id),
    };
  });

  app.post<{ Params: ProjectParams }>('/api/capability-manager/projects/:id/skills/install-request', async request => {
    const body = object(request.body);
    return manager.requestSkillInstall(request.params.id, requiredString(body.sourcePath, 'sourcePath'));
  });

  app.post<{ Params: OperationParams }>('/api/capability-manager/projects/:id/operations/:operationId/install', async request => {
    const operation = manager.store.getOperation(request.params.operationId);
    if (operation.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Operation not in project');
    return manager.executeInstall(operation.id);
  });

  app.post<{ Params: OperationParams }>('/api/capability-manager/projects/:id/operations/:operationId/rollback', async request => {
    const operation = manager.store.getOperation(request.params.operationId);
    if (operation.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Operation not in project');
    return manager.rollbackInstall(operation.id);
  });

  app.post<{ Params: CapabilityParams }>('/api/capability-manager/projects/:id/capabilities/:capabilityId/mcp-verify-request', async request =>
    manager.requestMcpVerification(request.params.id, request.params.capabilityId));

  app.post<{ Params: OperationParams }>('/api/capability-manager/projects/:id/operations/:operationId/verify-mcp', async request => {
    const operation = manager.store.getOperation(request.params.operationId);
    if (operation.projectId !== request.params.id) throw new CoreError('NOT_FOUND', 'Operation not in project');
    return manager.executeMcpVerification(operation.id);
  });

  app.post<{ Params: CapabilityParams }>('/api/capability-manager/projects/:id/capabilities/:capabilityId/enable', async request =>
    manager.setEnabled(request.params.id, request.params.capabilityId, true));

  app.post<{ Params: CapabilityParams }>('/api/capability-manager/projects/:id/capabilities/:capabilityId/disable', async request =>
    manager.setEnabled(request.params.id, request.params.capabilityId, false));
}
