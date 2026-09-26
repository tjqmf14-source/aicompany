import type { FastifyInstance } from 'fastify';
import { CoreEngine } from '../core/engine.js';
import { SecurityService } from '../security/service.js';

type ProjectParams = { id: string };

export function registerSecurityRoutes(app: FastifyInstance, engine: CoreEngine): void {
  const security = new SecurityService(engine);

  app.get<{ Params: ProjectParams }>('/api/security/projects/:id', async request =>
    security.state(request.params.id));

  app.post<{ Params: ProjectParams }>('/api/security/projects/:id/audit', async request =>
    security.audit(request.params.id));

  app.post<{ Params: ProjectParams }>('/api/security/projects/:id/qa', async request =>
    security.runQa(request.params.id));

  app.get<{ Params: ProjectParams }>('/api/security/projects/:id/audits', async request => {
    engine.repository.getProject(request.params.id);
    return security.store.listAudits(request.params.id);
  });

  app.get<{ Params: ProjectParams }>('/api/security/projects/:id/qa-runs', async request => {
    engine.repository.getProject(request.params.id);
    return security.store.listQa(request.params.id);
  });
}
