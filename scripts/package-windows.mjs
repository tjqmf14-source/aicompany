import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { packageFiles, verifyPackage } from '../dist/server/server/package-integrity.js';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Package on Windows x64 only');
if (!/^24\.(?:1[5-9]|[2-9]\d)\./.test(process.versions.node)) throw new Error('Node 24.15+ within major 24 is required');
const root = process.cwd();
const run = (exe, args, cwd = root) => execFileSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
const sha = run('git', ['rev-parse', 'HEAD']).trim();
const dirty = Boolean(run('git', ['status', '--porcelain']).trim());
if (dirty && !process.argv.includes('--allow-dirty')) throw new Error('Release packaging requires a clean committed tree');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const label = `ai-company-bridge-${pkg.version}-${sha.slice(0, 12)}${dirty ? '-dirty' : ''}-win-x64-${Date.now()}`;
const output = resolve('dist/releases', label);
if (existsSync(output)) throw new Error('Refusing to overwrite a package');
mkdirSync(output, { recursive: true });
const copy = (from, to) => cpSync(from, to, { recursive: true, dereference: false, filter: path => {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Linked packaging input: ${path}`);
  return !path.endsWith('.map');
} });
// Compile into the new staging tree so stale/ignored dist files cannot leak in.
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json', '--outDir', join(output, 'dist/server')]);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', join(output, 'dist/web')]);
for (const name of ['package.json', 'package-lock.json']) copyFileSync(name, join(output, name));
run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund'], output);
copy('packaging', output);
const runtime = join(output, 'runtime');
mkdirSync(runtime);
copyFileSync(process.execPath, join(runtime, 'node.exe'));
const nodeRoot = dirname(process.execPath);
for (const name of ['npm.cmd', 'npx.cmd']) copyFileSync(join(nodeRoot, name), join(runtime, name));
copy(join(nodeRoot, 'node_modules/npm'), join(runtime, 'node_modules/npm'));
const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`;
const license = await fetch(licenseUrl, { signal: AbortSignal.timeout(30_000) });
if (!license.ok) throw new Error('Cannot obtain the matching official Node license');
writeFileSync(join(runtime, 'NODE-LICENSE.txt'), await license.text());
for (const name of Object.keys(packageFiles(output))) {
  // Only generated regular files inventoried under this new package directory.
  if (name.endsWith('.map')) { unlinkSync(join(output, name)); continue; }
  if (/(?:^|\/)(?:\.git|\.ai-company)(?:\/|$)|(?:^|\/)\.env(?:\.|\/|$)|\.sqlite(?:-|$)/.test(name)) throw new Error(`Forbidden package content: ${name}`);
}
const files = packageFiles(output);
const manifest = { format: 1, version: pkg.version, sourceSha: sha, dirty, nodeVersion: process.versions.node, platform: 'win32', arch: 'x64', files };
writeFileSync(join(output, 'package-manifest.json'), JSON.stringify(manifest, null, 2));
verifyPackage(output);
const zip = output + '.zip';
// Paths are environment values, never interpolated into executable PowerShell text.
execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Compress-Archive -LiteralPath $env:AIC_PACKAGE_SOURCE -DestinationPath $env:AIC_PACKAGE_ZIP -CompressionLevel Optimal'], {
  windowsHide: true, timeout: 180_000, env: { ...process.env, AIC_PACKAGE_SOURCE: output, AIC_PACKAGE_ZIP: zip },
});
const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');
writeFileSync(zip + '.sha256', `${digest}  ${label}.zip\n`);
writeFileSync(resolve('dist/releases/latest.json'), JSON.stringify({ directory: output, zip, sha256: digest, sourceSha: sha, dirty }, null, 2));
console.log(JSON.stringify({ directory: output, zip, sha256: digest, sourceSha: sha, dirty }));
