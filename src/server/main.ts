import { resolve } from 'node:path';
import { CoreEngine } from '../core/engine.js';
import { createApp } from './app.js';

const engine = new CoreEngine(resolve(process.cwd(), '.ai-company', 'state.sqlite'));
const app = createApp(engine);
const port = Number(process.env.PORT ?? 3187);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

async function shutdown(): Promise<void> {
  await app.close();
  engine.close();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
await app.listen({ host: '127.0.0.1', port });
