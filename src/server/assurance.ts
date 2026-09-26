import type { FastifyInstance } from 'fastify';
import { CoreError } from '../core/domain.js';
import { CoreEngine } from '../core/engine.js';
import { AssuranceService } from '../assurance/service.js';

type ProjectParams = { id: string };

export function registerAssuranceRoutes(app: FastifyInstance, engine: CoreEngine): void {
  const assurance = new AssuranceService(engine);

  const project = (id: string): void => {
    try { engine.repository.getProject(id); }
    catch { throw new CoreError('NOT_FOUND', 'Project not found'); }
  };

  app.get<{ Params: ProjectParams }>('/api/assurance/projects/:id', async request => {
    project(request.params.id);
    return assurance.state(request.params.id);
  });

  app.post<{ Params: ProjectParams }>('/api/assurance/projects/:id/security', async request => {
    project(request.params.id);
    return assurance.securityAudit(request.params.id);
  });

  app.post<{ Params: ProjectParams }>('/api/assurance/projects/:id/recovery', async request => {
    project(request.params.id);
    return assurance.recoveryAudit(request.params.id);
  });

  app.post<{ Params: ProjectParams }>('/api/assurance/projects/:id/qa', async request => {
    project(request.params.id);
    return assurance.qa(request.params.id);
  });
}
