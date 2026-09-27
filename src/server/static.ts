import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { assertNoLinkedComponents } from '../core/path-safety.js';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export function registerBuiltDashboard(app: FastifyInstance, webRoot: string): void {
  const root = resolve(webRoot);
  assertNoLinkedComponents(root, resolve(root, 'index.html'));
  if (!statSync(resolve(root, 'index.html')).isFile()) throw new Error('Built dashboard is missing');
  app.get('/*', async (request, reply) => {
    let path: string;
    try { path = decodeURIComponent(request.url.split('?')[0]!); } catch { return reply.code(400).send({ error: 'INVALID_PATH' }); }
    // Only the build's index and hashed assets are public, never app/runtime/data files.
    if (path !== '/' && !/^\/assets\/[A-Za-z0-9_-]+\.(?:js|css|svg|png|ico)$/.test(path)) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    try {
      const file = assertNoLinkedComponents(root, resolve(root, path === '/' ? 'index.html' : path.slice(1)));
      if (!statSync(file).isFile()) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.type(mime[extname(file)]!).send(readFileSync(file));
    } catch { return reply.code(404).send({ error: 'NOT_FOUND' }); }
  });
}
