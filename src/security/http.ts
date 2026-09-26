import type { FastifyInstance } from 'fastify';
import { CoreError } from '../core/domain.js';

const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

function isLoopbackAddress(value: string): boolean {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function assertOrigin(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new CoreError('FORBIDDEN', 'Invalid request origin'); }
  if (!['http:', 'https:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new CoreError('FORBIDDEN', 'Only loopback browser origins are allowed');
  }
}

export function registerHttpSecurity(app: FastifyInstance): void {
  app.addHook('onRequest', async request => {
    const remote = request.raw.socket.remoteAddress;
    if (remote && !isLoopbackAddress(remote)) throw new CoreError('FORBIDDEN', 'Only loopback clients are allowed');

    const host = request.headers.host;
    if (host && !LOOPBACK_HOST.test(host)) throw new CoreError('FORBIDDEN', 'Only loopback Host headers are allowed');

    if (request.headers.forwarded
      || request.headers['x-forwarded-host']
      || request.headers['x-forwarded-for']) {
      throw new CoreError('FORBIDDEN', 'Forwarded requests are not supported');
    }

    const origin = request.headers.origin;
    if (origin) assertOrigin(origin);

    if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw new CoreError('FORBIDDEN', 'Cross-site browser requests are blocked');
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });
}
