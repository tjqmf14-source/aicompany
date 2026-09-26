import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { lstatSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { CoreError, nonEmpty } from '../core/domain.js';
import { CoreEngine } from '../core/engine.js';
import { createBundle } from './bundle.js';
import { applyPatch, validatePatchSet, type PatchTarget } from './patch.js';
import { validateRelativePath, validateResponseFile } from './paths.js';
import { ManualHandoffProvider, type HandoffProvider } from './provider.js';
import { classifyCommand, validateHighResponse } from './schema.js';
import { HandoffStore, type CheckResult, type FileBackup, type HandoffCheckpoint, type HandoffSession, type Preview } from './store.js';
import { sanitizedProcessEnv } from '../security/environment.js';
import { redactSensitive } from '../security/redaction.js';

const scripts = ['typecheck', 'lint', 'test', 'build'] as const;
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const redact = (value: string): string => redactSensitive(value);

function gitCheck(root: string, args: string[]): number {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, windowsHide: true, timeout: 10_000, encoding: 'utf8' });
  if (result.error || result.status === null || result.status > 1) throw new CoreError('INVALID_INPUT', `Git inspection failed: ${String(result.stderr || result.error).slice(0, 1000)}`);
  return result.status;
}
function readScripts(root: string): Record<string, string> {
  validateRelativePath(root, 'package.json', true);
  if (statSync(join(root, 'package.json')).size > 1_000_000) throw new CoreError('INVALID_INPUT', 'package.json exceeds 1 MB');
  if (gitCheck(root, ['ls-files', '--error-unmatch', '--', 'package.json']) !== 0) {
    throw new CoreError('INVALID_INPUT', 'package.json must be tracked by Git');
  }
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as unknown; }
  catch { throw new CoreError('INVALID_INPUT', 'package.json is invalid'); }
  const obj = value as { scripts?: unknown };
  if (!obj || typeof obj !== 'object' || !obj.scripts || typeof obj.scripts !== 'object' || Array.isArray(obj.scripts)) {
    throw new CoreError('INVALID_INPUT', 'package.json scripts are missing');
  }
  const entries = Object.entries(obj.scripts as Record<string, unknown>);
  if (entries.some(([, value]) => typeof value !== 'string')) throw new CoreError('INVALID_INPUT', 'package.json scripts must be strings');
  const result = Object.fromEntries(entries) as Record<string, string>;
  if (scripts.some(name => !result[name])) throw new CoreError('INVALID_INPUT', 'typecheck, lint, test and build scripts are required');
  return result;
}
function currentHash(root: string, path: string): string | null {
  const full = resolve(root, ...path.split('/'));
  const stat = lstatSync(full, { throwIfNoEntry: false });
  validateRelativePath(root, path, !!stat);
  if (!stat) return null;
  if (stat.size > 24 * 1024 * 1024) throw new CoreError('CONFLICT', 'Patched file exceeds recovery size limit');
  return sha(readFileSync(full));
}
function runValidation(root: string, name: typeof scripts[number]): CheckResult {
  const windows = process.platform === 'win32';
  const executable = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const args = windows ? ['/d', '/s', '/c', `npm.cmd run ${name}`] : ['run', name];
  const result = spawnSync(executable, args, {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000,
    maxBuffer: 5 * 1024 * 1024, env: sanitizedProcessEnv({ CI: '1', NO_COLOR: '1' }),
  });
  return {
    command: name, status: result.status === 0 && !result.error ? 'PASS' : 'FAIL', exitCode: result.status,
    output: redact(`${result.stdout ?? ''}\n${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`),
  };
}

export class HandoffCore {
  readonly store: HandoffStore;
  readonly provider: HandoffProvider;
  readonly recoveredHandoffs: number;

  constructor(readonly engine: CoreEngine, provider?: HandoffProvider) {
    if (engine.database.path === ':memory:') throw new CoreError('INVALID_INPUT', 'Handoff requires file-backed SQLite');
    this.store = new HandoffStore(engine.database);
    this.provider = provider ?? new ManualHandoffProvider(dirname(engine.database.path));
    this.recoveredHandoffs = this.store.recoverApplying();
  }

  create(projectId: string, objective: string, taskId: string | null = null): HandoffSession {
    const project = this.engine.repository.getProject(projectId);
    if (taskId && this.engine.repository.getTask(taskId).projectId !== projectId) throw new CoreError('INVALID_INPUT', 'Task belongs to another project');
    const text = nonEmpty(objective, 'objective', 20_000);
    const snapshot = this.engine.git(projectId).snapshot();
    const id = randomUUID();
    const files = createBundle(this.engine, projectId, text, taskId, snapshot, this.store.list(projectId));
    const bundlePath = this.provider.publish(id, files);
    return this.store.create({ id, projectId: project.id, taskId, provider: this.provider.id, objective: text, bundlePath, baseHead: snapshot.head, baseBranch: snapshot.branch });
  }

  importFile(handoffId: string, filePath: string): HandoffSession {
    const session = this.store.get(handoffId);
    const root = this.engine.repository.getProject(session.projectId).rootPath;
    let validated: string;
    try { validated = validateResponseFile(root, filePath); }
    catch { validated = validateResponseFile(dirname(session.bundlePath), filePath); }
    return this.importResponse(handoffId, this.provider.readResponse(validated));
  }

  private baseline(session: HandoffSession): string {
    const git = this.engine.git(session.projectId);
    if (git.head() !== session.baseHead || git.branch() !== session.baseBranch) throw new CoreError('CONFLICT', 'Git HEAD or branch changed since bundle creation');
    git.requireClean();
    return git.rootPath;
  }

  private validateTargets(root: string, targets: PatchTarget[]): void {
    for (const target of targets) {
      if (target.kind === 'modify' && gitCheck(root, ['ls-files', '--error-unmatch', '--', target.path]) !== 0) {
        throw new CoreError('INVALID_INPUT', 'Patch can modify only tracked files');
      }
      if (target.kind === 'create' && gitCheck(root, ['check-ignore', '-q', '--', target.path]) === 0) {
        throw new CoreError('INVALID_INPUT', 'New file is ignored by Git');
      }
    }
  }

  importResponse(handoffId: string, input: unknown): HandoffSession {
    const session = this.store.get(handoffId);
    if (session.status !== 'awaiting_response') throw new CoreError('CONFLICT', 'Handoff has already received a response');
    const response = validateHighResponse(input);
    const root = this.baseline(session);
    const patch = validatePatchSet(root, response, false);
    this.validateTargets(root, patch.targets);
    const preflightCheckpoint = this.engine.checkpoint(session.projectId, `Handoff ${session.id} preflight`, session.taskId);
    validatePatchSet(root, response);
    const preview: Preview = {
      baseHead: session.baseHead, baseBranch: session.baseBranch, preflightCheckpointId: preflightCheckpoint.id, targets: patch.targets,
      diff: patch.preview, commands: response.commands.map(classifyCommand), dryRun: 'PASS',
    };
    const previewPath = join(dirname(session.bundlePath), 'preview.diff');
    let created = false;
    try {
      writeFileSync(previewPath, preview.diff, { encoding: 'utf8', flag: 'wx' });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (readFileSync(previewPath, 'utf8') !== preview.diff) {
        throw new CoreError('CONFLICT', 'Preview file already exists with different content');
      }
    }
    try { return this.store.importValidated(handoffId, response, preview); }
    catch (error) { if (created) unlinkSync(previewPath); throw error; }
  }

  private backup(root: string, targets: PatchTarget[], scriptsBefore: Record<string, string>, session: HandoffSession): HandoffCheckpoint {
    const files: FileBackup[] = [];
    let total = 0;
    for (const target of targets) {
      const validated = validateRelativePath(root, target.path, target.kind === 'modify');
      if (validated.exists && statSync(validated.fullPath).size + total > 20 * 1024 * 1024) {
        throw new CoreError('INVALID_INPUT', 'Checkpoint exceeds 20 MiB');
      }
      const content = validated.exists ? readFileSync(validated.fullPath) : null;
      if (content) total += content.length;
      if (total > 20 * 1024 * 1024) throw new CoreError('INVALID_INPUT', 'Checkpoint exceeds 20 MiB');
      files.push({ path: target.path, existed: !!content, sha256: content ? sha(content) : null, contentBase64: content ? content.toString('base64') : null, appliedSha256: null });
    }
    const checkpoint = this.engine.checkpoint(session.projectId, `Before handoff ${session.id}`, session.taskId);
    return { gitCheckpointId: checkpoint.id, head: checkpoint.snapshot.head, branch: checkpoint.snapshot.branch, scripts: scriptsBefore, files, createdAt: new Date().toISOString() };
  }

  private recordApplied(handoffId: string, checkpoint: HandoffCheckpoint): void {
    this.store.update(handoffId, 'applying', 'applying', { checkpoint });
  }

  private validateNoOtherChanges(session: HandoffSession): void {
    const allowed = new Set(session.checkpoint?.files.map(file => file.path.toLowerCase()) ?? []);
    const git = this.engine.git(session.projectId);
    const changed = git.status();
    if (changed.some(item => !allowed.has(item.path.toLowerCase()))) {
      throw new CoreError('CONFLICT', 'Verification changed files outside the patch; manual recovery required');
    }
    for (const file of session.checkpoint?.files ?? []) {
      if (currentHash(git.rootPath, file.path) !== file.appliedSha256) {
        throw new CoreError('CONFLICT', `File changed during verification: ${file.path}`);
      }
      if (!file.existed && gitCheck(git.rootPath, ['check-ignore', '-q', '--', file.path]) === 0) {
        throw new CoreError('CONFLICT', `New file became ignored by Git: ${file.path}`);
      }
    }
  }

  apply(handoffId: string): HandoffSession {
    const session = this.store.get(handoffId);
    if (session.status !== 'ready_to_apply' || !session.response || !session.preview) throw new CoreError('CONFLICT', 'Handoff has no reviewed preview');
    const root = this.baseline(session);
    const patch = validatePatchSet(root, session.response, false);
    this.validateTargets(root, patch.targets);
    if (patch.preview !== session.preview.diff || session.preview.baseHead !== session.baseHead || session.preview.baseBranch !== session.baseBranch) {
      throw new CoreError('CONFLICT', 'Patch differs from reviewed preview');
    }
    const scriptsBefore = readScripts(root);
    const checkpoint = this.backup(root, patch.targets, scriptsBefore, session);
    this.store.update(handoffId, 'ready_to_apply', 'applying', { checkpoint, verification: { results: [], rollback: 'NOT_NEEDED', codexTaskIds: [] } });
    try {
      validatePatchSet(root, session.response);
      applyPatch(root, patch.combinedPatch);
      for (const file of checkpoint.files) if (patch.targets.some(target => target.path === file.path && !session.response!.newFiles.some(newFile => newFile.path === target.path))) {
        file.appliedSha256 = currentHash(root, file.path);
      }
      this.recordApplied(handoffId, checkpoint);
      for (const file of session.response.newFiles) {
        const validated = validateRelativePath(root, file.path, false);
        mkdirSync(dirname(validated.fullPath), { recursive: true });
        validateRelativePath(root, file.path, false);
        writeFileSync(validated.fullPath, file.content, { encoding: 'utf8', flag: 'wx' });
        checkpoint.files.find(item => item.path === file.path)!.appliedSha256 = currentHash(root, file.path);
        this.recordApplied(handoffId, checkpoint);
      }
      if (JSON.stringify(readScripts(root)) !== JSON.stringify(scriptsBefore)) throw new CoreError('CONFLICT', 'Package scripts changed during patch');
      const results: CheckResult[] = [];
      for (const name of scripts) {
        const result = runValidation(root, name);
        results.push(result);
        this.store.update(handoffId, 'applying', 'applying', { verification: { results, rollback: 'NOT_NEEDED', codexTaskIds: [] } });
        if (result.status === 'FAIL') throw new CoreError('CONFLICT', `${name} verification failed`);
      }
      this.validateNoOtherChanges(this.store.get(handoffId));
      return this.store.finalizeVerified(handoffId, results);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { return this.rollback(handoffId, message); }
      catch (rollbackError) {
        const current = this.store.get(handoffId);
        if (current.status === 'applying') return this.store.update(handoffId, 'applying', 'recovery_required', { error: `${message}; rollback blocked: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}` });
        return current;
      }
    }
  }

  rollback(handoffId: string, reason = 'User requested rollback'): HandoffSession {
    const session = this.store.get(handoffId);
    if ((session.status !== 'applying' && session.status !== 'recovery_required') || !session.checkpoint) throw new CoreError('CONFLICT', 'No recoverable checkpoint');
    const root = this.engine.git(session.projectId).rootPath;
    const git = this.engine.git(session.projectId);
    if (git.head() !== session.checkpoint.head || git.branch() !== session.checkpoint.branch) {
      throw new CoreError('CONFLICT', 'Git HEAD or branch changed; rollback requires manual review');
    }
    const allowed = new Set(session.checkpoint.files.map(item => item.path.toLowerCase()));
    if (git.status().some(item => !allowed.has(item.path.toLowerCase()))) throw new CoreError('CONFLICT', 'Other workspace changes detected; rollback requires manual review');
    for (const file of session.checkpoint.files) {
      const current = currentHash(root, file.path);
      if (current !== file.sha256 && (file.appliedSha256 === null || current !== file.appliedSha256)) {
        throw new CoreError('CONFLICT', `File changed after apply: ${file.path}`);
      }
    }
    for (const file of session.checkpoint.files) {
      const current = currentHash(root, file.path);
      if (current === file.sha256) continue;
      const validated = validateRelativePath(root, file.path, true);
      if (file.existed) writeFileSync(validated.fullPath, Buffer.from(file.contentBase64!, 'base64'));
      else unlinkSync(validated.fullPath);
    }
    const verification = session.verification ?? { results: [], rollback: 'NOT_NEEDED', codexTaskIds: [] };
    if (git.status().length) throw new CoreError('CONFLICT', 'Rollback finished but repository is not clean');
    return this.store.update(handoffId, session.status, 'failed', { error: reason, verification: { ...verification, rollback: 'PASS' } });
  }
}
