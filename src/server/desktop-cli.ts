import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimDataDirectory, dataDirectory, runtimeRequest, startDesktop, validateDataLocation } from './desktop.js';
import { verifyPackage } from './package-integrity.js';
import { redactSensitive } from '../core/redaction.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const action = process.argv[2];
try {
  if (action === 'verify') {
    const manifest = verifyPackage(root);
    console.log(JSON.stringify({ sourceSha: manifest.sourceSha, dirty: manifest.dirty }));
  } else if (action === 'prepare') {
    validateDataLocation(dataDirectory(), root);
    const lease = claimDataDirectory(dataDirectory());
    lease.close();
    console.log(JSON.stringify({ dataRoot: lease.root }));
  } else if (action === 'status' || action === 'stop') {
    console.log(JSON.stringify(await runtimeRequest(dataDirectory(), action, action === 'status' ? root : undefined)));
  } else if (action === 'serve') {
    verifyPackage(root);
    const runtime = await startDesktop({ dataRoot: dataDirectory(), webRoot: resolve(root, 'dist/web'), packageRoot: root });
    process.once('SIGINT', () => { void runtime.close(); });
    process.once('SIGTERM', () => { void runtime.close(); });
    console.log(`AI Company ready: ${runtime.url}`);
  } else throw new Error('Expected verify, prepare, serve, status or stop');
} catch (error) {
  if (action !== 'status') console.error(redactSensitive(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
