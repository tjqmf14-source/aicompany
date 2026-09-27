import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertNoLinkedComponents } from '../core/path-safety.js';

export interface PackageManifest {
  format: 1; version: string; sourceSha: string; dirty: boolean; nodeVersion: string;
  platform: 'win32'; arch: 'x64'; files: Record<string, string>;
}
export function packageFiles(root: string, prefix = ''): Record<string, string> {
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const key = prefix ? `${prefix}/${name}` : name;
    if (!prefix && name === 'package-manifest.json') continue;
    const path = assertNoLinkedComponents(root, join(root, key));
    const stat = lstatSync(path);
    if (stat.isDirectory()) Object.assign(files, packageFiles(root, key));
    else if (stat.isFile()) files[key] = createHash('sha256').update(readFileSync(path)).digest('hex');
    else throw new Error(`Unsupported package entry: ${key}`);
  }
  return files;
}
export function verifyPackage(directory: string): PackageManifest {
  const root = resolve(directory);
  const path = assertNoLinkedComponents(root, join(root, 'package-manifest.json'));
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
  if (manifest.format !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64'
    || !/^[a-f0-9]{40}$/.test(manifest.sourceSha) || typeof manifest.dirty !== 'boolean'
    || !manifest.files || typeof manifest.files !== 'object') throw new Error('Invalid package manifest');
  const actual = packageFiles(root);
  const expected = Object.keys(manifest.files).sort();
  if (expected.length === 0 || JSON.stringify(expected) !== JSON.stringify(Object.keys(actual).sort())) throw new Error('Package file inventory mismatch');
  for (const name of expected) if (manifest.files[name] !== actual[name]) throw new Error(`Package hash mismatch: ${name}`);
  for (const required of ['runtime/node.exe', 'runtime/npm.cmd', 'runtime/NODE-LICENSE.txt', 'dist/server/server/desktop-cli.js', 'dist/web/index.html', 'Start.cmd', 'Stop.cmd']) {
    if (!actual[required]) throw new Error(`Missing package requirement: ${required}`);
  }
  return manifest;
}
