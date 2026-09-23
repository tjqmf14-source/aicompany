import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { CoreError } from '../core/domain.js';
import { assertDirectoryNoSymlink, assertRegularNoSymlink, sha256File, safeSkillName } from './security.js';
import type { SkillFileEvidence, SkillInspection } from './types.js';

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_MD = 1024 * 1024;

function frontmatter(content: string): { name: string; description: string } {
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    throw new CoreError('INVALID_INPUT', 'SKILL.md must start with YAML frontmatter');
  }
  const lines = normalized.split(/\r?\n/);
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing < 2) throw new CoreError('INVALID_INPUT', 'SKILL.md frontmatter is not closed');
  let name = '';
  let description = '';
  for (const line of lines.slice(1, closing)) {
    const index = line.indexOf(':');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (key === 'name') name = value;
    if (key === 'description') description = value;
  }
  safeSkillName(name);
  if (!description || description.length > 2000) throw new CoreError('INVALID_INPUT', 'Skill description is missing or too long');
  return { name, description };
}

function collect(root: string, current: string, files: SkillFileEvidence[], total: { bytes: number }): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new CoreError('INVALID_INPUT', `Skill contains symlink/junction: ${relative(root, full)}`);
    if (entry.isDirectory()) {
      collect(root, full, files, total);
      continue;
    }
    if (!entry.isFile()) throw new CoreError('INVALID_INPUT', `Skill contains unsupported filesystem entry: ${relative(root, full)}`);
    if (files.length >= MAX_FILES) throw new CoreError('INVALID_INPUT', `Skill contains more than ${MAX_FILES} files`);
    total.bytes += stat.size;
    if (total.bytes > MAX_TOTAL_BYTES) throw new CoreError('INVALID_INPUT', 'Skill exceeds 10 MiB');
    files.push({ relativePath: relative(root, full).replaceAll('\\', '/'), sha256: sha256File(full), size: stat.size });
  }
}

export function inspectSkill(path: string): SkillInspection {
  const rootPath = assertDirectoryNoSymlink(resolve(path), 'Skill directory');
  const skillMd = join(rootPath, 'SKILL.md');
  const realSkillMd = assertRegularNoSymlink(skillMd, 'SKILL.md');
  if (statSync(realSkillMd).size > MAX_SKILL_MD) throw new CoreError('INVALID_INPUT', 'SKILL.md exceeds 1 MiB');
  const meta = frontmatter(readFileSync(realSkillMd, 'utf8'));
  const files: SkillFileEvidence[] = [];
  const total = { bytes: 0 };
  collect(rootPath, rootPath, files, total);
  if (!files.some(file => file.relativePath === 'SKILL.md')) throw new CoreError('INVALID_INPUT', 'SKILL.md was not included in scan');
  return { ...meta, rootPath, files, totalBytes: total.bytes };
}

export function discoverSkills(root: string): { inspections: SkillInspection[]; errors: { name: string; error: string }[] } {
  const inspections: SkillInspection[] = [];
  const errors: { name: string; error: string }[] = [];
  let realRoot: string;
  try { realRoot = assertDirectoryNoSymlink(resolve(root), 'Skills root'); }
  catch { return { inspections, errors }; }
  for (const entry of readdirSync(realRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try { inspections.push(inspectSkill(join(realRoot, entry.name))); }
    catch (error) { errors.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { inspections, errors };
}
