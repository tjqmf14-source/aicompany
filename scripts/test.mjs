import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { parseNodeTestEvidence, testEvidenceFailure } from '../dist/test/src/core/qa-evidence.js';

const files = readdirSync('dist/test/tests').filter(file => file.endsWith('.test.js')).sort();
if (!files.length) throw new Error('No compiled test files found');
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
  ...files.map(file => 'dist/test/tests/' + file)], {
  encoding: 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
const failure = testEvidenceFailure(result.stdout ?? '');
const evidence = parseNodeTestEvidence(result.stdout ?? '');
if (result.error || result.signal || result.status !== 0 || failure || !evidence || evidence.tests < 144) {
  process.stderr.write(`\nQA gate rejected: ${result.error?.message ?? failure ?? 'process failure or regression test count below 144'}\n`);
  process.exitCode = 1;
}
