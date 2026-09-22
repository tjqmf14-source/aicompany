import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CoreEngine } from '../src/core/engine.js';
import { CoreError } from '../src/core/domain.js';
import { BUNDLE_FILES } from '../src/handoff/provider.js';
import { classifyCommand, type HighResponse } from '../src/handoff/schema.js';
import { HandoffCore } from '../src/handoff/service.js';
import { validateRelativePath } from '../src/handoff/paths.js';
import { committedFixture } from './helpers.js';

const patch = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-original\n+changed\n';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const response = (overrides: Partial<HighResponse> = {}): HighResponse => ({
  summary: 'Update the local core', decisions: ['Use a local patch'], patches: [patch],
  newFiles: [{ path: 'src/new.txt', content: 'created\n' }],
  commands: ['git status --short', 'npm run build', 'git reset --hard'],
  tests: ['npm test'], codexTasks: [{ title: 'Review change', description: 'Inspect result', acceptanceCriteria: ['Tests pass'] }],
  remainingTasks: ['Review UI'], questions: [], riskNotes: [], ...overrides,
});

function setup(failAt: 'typecheck' | 'lint' | 'test' | 'build' | null = null) {
  const work = committedFixture();
  const packageJson = { name: 'handoff-fixture', version: '1.0.0', private: true, scripts: {
    typecheck: `node -e "process.exit(${failAt === 'typecheck' ? 1 : 0})"`,
    lint: `node -e "process.exit(${failAt === 'lint' ? 1 : 0})"`,
    test: `node -e "process.exit(${failAt === 'test' ? 1 : 0})"`,
    build: `node -e "process.exit(${failAt === 'build' ? 1 : 0})"`,
  } };
  writeFileSync(join(work.path, 'package.json'), JSON.stringify(packageJson) + '\n');
  work.commit();
  const databasePath = join(work.path, '.ai-company', 'state.sqlite');
  const engine = new CoreEngine(databasePath);
  const project = engine.createProject('Handoff fixture', work.path);
  const core = new HandoffCore(engine);
  return { work, engine, core, project, databasePath };
}

test('manual bundle, strict import, preview and verified apply survive restart', () => {
  const { work, engine, core, project, databasePath } = setup();
  let reopened: CoreEngine | null = null;
  let originalClosed = false;
  try {
    const session = core.create(project.id, 'Update README and add a file');
    assert.equal(session.status, 'awaiting_response');
    for (const name of BUNDLE_FILES) assert.equal(existsSync(join(session.bundlePath, name)), true, name);
    assert.equal(JSON.parse(readFileSync(join(session.bundlePath, 'tests.json'), 'utf8')).status, 'NOT_RECORDED');
    const responsePath = join(dirname(session.bundlePath), 'response.json');
    writeFileSync(responsePath, JSON.stringify(response()));
    const imported = core.importFile(session.id, responsePath);
    assert.equal(imported.status, 'ready_to_apply');
    assert.equal(imported.preview?.dryRun, 'PASS');
    assert.deepEqual(imported.preview?.commands.map(item => item.risk), ['SAFE', 'REVIEW', 'DANGEROUS']);
    assert.equal(engine.repository.listApprovals(project.id).filter(item => item.status === 'pending').length, 1);
    assert.match(readFileSync(join(dirname(session.bundlePath), 'preview.diff'), 'utf8'), /\+changed/);
    assert.equal(readFileSync(join(work.path, 'README.md'), 'utf8'), 'original\n');
    const applied = core.apply(session.id);
    assert.equal(applied.status, 'verified');
    assert.deepEqual(applied.verification?.results.map(item => item.status), ['PASS', 'PASS', 'PASS', 'PASS']);
    assert.equal(readFileSync(join(work.path, 'README.md'), 'utf8').replaceAll('\r\n', '\n'), 'changed\n');
    assert.equal(readFileSync(join(work.path, 'src', 'new.txt'), 'utf8'), 'created\n');
    assert.equal(engine.repository.listTasks(project.id).some(task => task.title === 'Review change' && task.status === 'queued'), true);
    assert.equal(engine.repository.listDecisions(project.id).some(item => item.summary === 'Use a local patch'), true);
    assert.equal(engine.repository.listCheckpoints(project.id).at(-1)?.snapshot.dirty, false);
    assert.equal(work.git('branch', '--show-current').trim(), 'main');
    engine.close();
    originalClosed = true;
    reopened = new CoreEngine(databasePath);
    const restored = new HandoffCore(reopened);
    assert.equal(restored.store.get(session.id).status, 'verified');
    assert.equal(restored.recoveredHandoffs, 0);
  } finally { reopened?.close(); if (!originalClosed) engine.close(); work.clean(); }
});

test('failed verification restores modified and created files without Git reset', () => {
  const { work, engine, core, project } = setup('typecheck');
  try {
    const session = core.create(project.id, 'Test rollback');
    core.importResponse(session.id, response());
    const result = core.apply(session.id);
    assert.equal(result.status, 'failed');
    assert.equal(result.verification?.results[0]?.command, 'typecheck');
    assert.equal(result.verification?.results[0]?.status, 'FAIL');
    assert.equal(result.verification?.rollback, 'PASS');
    assert.equal(readFileSync(join(work.path, 'README.md'), 'utf8'), 'original\n');
    assert.equal(existsSync(join(work.path, 'src', 'new.txt')), false);
    assert.equal(core.engine.git(project.id).snapshot().dirty, false);
    assert.equal(engine.repository.listTasks(project.id).length, 0);
  } finally { engine.close(); work.clean(); }
});

test('build failure rolls back after typecheck, lint and test pass', () => {
  const { work, engine, core, project } = setup('build');
  try {
    const session = core.create(project.id, 'Test late failure');
    core.importResponse(session.id, response({ newFiles: [] }));
    const result = core.apply(session.id);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.verification?.results.map(item => `${item.command}:${item.status}`), [
      'typecheck:PASS', 'lint:PASS', 'test:PASS', 'build:FAIL',
    ]);
    assert.equal(result.verification?.rollback, 'PASS');
    assert.equal(readFileSync(join(work.path, 'README.md'), 'utf8'), 'original\n');
    assert.equal(core.engine.git(project.id).snapshot().dirty, false);
  } finally { engine.close(); work.clean(); }
});

test('dirty repository bundle records changed files and tracked diff without applying', () => {
  const { work, engine, core, project } = setup();
  try {
    writeFileSync(join(work.path, 'README.md'), 'manual edit\n');
    writeFileSync(join(work.path, 'extra.txt'), 'untracked\n');
    const session = core.create(project.id, 'Continue manually');
    const changed = JSON.parse(readFileSync(join(session.bundlePath, 'changed-files.json'), 'utf8')) as { path: string }[];
    assert.deepEqual(changed.map(item => item.path).sort(), ['README.md', 'extra.txt']);
    assert.match(readFileSync(join(session.bundlePath, 'git.diff'), 'utf8'), /manual edit/);
    assert.match(readFileSync(join(session.bundlePath, 'context.md'), 'utf8'), /Dirty tree: true/);
  } finally { engine.close(); work.clean(); }
});

test('imported preview is durable across process restart before apply', () => {
  const { work, engine, core, project, databasePath } = setup();
  try {
    const session = core.create(project.id, 'Pause before apply');
    core.importResponse(session.id, response({ commands: [], newFiles: [] }));
    engine.close();
    const reopened = new CoreEngine(databasePath);
    try {
      const restored = new HandoffCore(reopened).store.get(session.id);
      assert.equal(restored.status, 'ready_to_apply');
      assert.equal(restored.preview?.dryRun, 'PASS');
      assert.match(restored.preview?.diff ?? '', /\+changed/);
    } finally { reopened.close(); }
  } finally { work.clean(); }
});

test('patch cannot change validation scripts before running them', () => {
  const { work, engine, core, project } = setup();
  try {
    const original = readFileSync(join(work.path, 'package.json'), 'utf8');
    const modified = original.replace('process.exit(0)', 'process.exit(9)');
    const scriptPatch = `diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-${original.trimEnd()}\n+${modified.trimEnd()}\n`;
    const session = core.create(project.id, 'Reject script mutation');
    core.importResponse(session.id, response({ patches: [scriptPatch], newFiles: [], commands: [] }));
    const result = core.apply(session.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /scripts changed/);
    assert.deepEqual(result.verification?.results, []);
    assert.equal(result.verification?.rollback, 'PASS');
    assert.equal(readFileSync(join(work.path, 'package.json'), 'utf8'), original);
  } finally { engine.close(); work.clean(); }
});

test('manual CLI bundles, imports, previews and applies through separate processes', () => {
  const { work, engine, project } = setup();
  const cliPath = fileURLToPath(new URL('../src/handoff/cli.js', import.meta.url));
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [cliPath, ...args], {
    cwd: work.path, encoding: 'utf8', windowsHide: true, timeout: 60_000,
  })) as Record<string, unknown>;
  try {
    const session = cli('bundle', project.id, 'CLI objective');
    assert.equal(session.status, 'awaiting_response');
    const responsePath = join(dirname(String(session.bundlePath)), 'response.json');
    writeFileSync(responsePath, JSON.stringify(response({ commands: [], newFiles: [], codexTasks: [] })));
    assert.equal(cli('import', String(session.id), responsePath).status, 'ready_to_apply');
    assert.match(String(cli('preview', String(session.id)).diff), /\+changed/);
    assert.equal(cli('apply', String(session.id)).status, 'verified');
    assert.equal(readFileSync(join(work.path, 'README.md'), 'utf8').replaceAll('\r\n', '\n'), 'changed\n');
  } finally { engine.close(); work.clean(); }
});

test('invalid schema, traversal, dirty tree and command risk are rejected before apply', () => {
  const { work, engine, core, project } = setup();
  try {
    const session = core.create(project.id, 'Security checks');
    assert.throws(() => core.importResponse(session.id, { summary: 'missing fields' }), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
    assert.throws(() => core.importResponse(session.id, response({ newFiles: [{ path: '../escape.txt', content: 'bad' }] })), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
    assert.throws(() => core.importResponse(session.id, response({ newFiles: [{ path: 'CON.txt', content: 'bad' }] })), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
    assert.throws(() => core.importResponse(session.id, response({ newFiles: [{ path: '.git/hooks/hook', content: 'bad' }] })), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
    assert.throws(() => core.importResponse(session.id, response({ patches: ['diff --git a/README.md b/README.md\ndeleted file mode 100644\n--- a/README.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-original\n'] })), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
    assert.throws(() => core.importResponse(session.id, response({ patches: [patch.replaceAll('README.md', '../escape.txt')] })), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
    writeFileSync(join(work.path, 'user-change.txt'), 'preserve');
    assert.throws(() => core.importResponse(session.id, response()), (error: unknown) => error instanceof CoreError && error.code === 'DIRTY_WORKTREE');
    assert.equal(readFileSync(join(work.path, 'user-change.txt'), 'utf8'), 'preserve');
    unlinkSync(join(work.path, 'user-change.txt'));
    assert.equal(classifyCommand('git reset --hard').risk, 'DANGEROUS');
    assert.equal(classifyCommand('npm run test').risk, 'REVIEW');
    assert.equal(classifyCommand('git status').risk, 'SAFE');
  } finally { engine.close(); work.clean(); }
});

test('canonical path validation rejects a Windows junction before writing through it', () => {
  const { work, engine } = setup();
  const target = join(work.path, 'safe-directory');
  const link = join(work.path, 'junction-directory');
  try {
    mkdirSync(target);
    symlinkSync(target, link, 'junction');
    assert.throws(() => validateRelativePath(work.path, 'junction-directory/new.txt', false), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
  } finally {
    if (existsSync(link)) unlinkSync(link);
    engine.close(); work.clean();
  }
});

test('restart restores in-flight handoff state and safe rollback refuses user edits', () => {
  const { work, engine, core, project, databasePath } = setup();
  try {
    const session = core.create(project.id, 'Recover after restart');
    core.importResponse(session.id, response({ newFiles: [], codexTasks: [] }));
    const gitCheckpoint = engine.checkpoint(project.id, 'before simulated interruption');
    const checkpoint = {
      gitCheckpointId: gitCheckpoint.id, head: gitCheckpoint.snapshot.head, branch: gitCheckpoint.snapshot.branch,
      scripts: JSON.parse(readFileSync(join(work.path, 'package.json'), 'utf8')).scripts as Record<string, string>,
      files: [{ path: 'README.md', existed: true, sha256: hash('original\n'), contentBase64: Buffer.from('original\n').toString('base64'), appliedSha256: hash('changed\n') }],
      createdAt: new Date().toISOString(),
    };
    core.store.update(session.id, 'ready_to_apply', 'applying', { checkpoint });
    writeFileSync(join(work.path, 'README.md'), 'changed\n');
    engine.close();
    const reopened = new CoreEngine(databasePath);
    const recovered = new HandoffCore(reopened);
    assert.equal(recovered.recoveredHandoffs, 1);
    assert.equal(recovered.store.get(session.id).status, 'recovery_required');
    writeFileSync(join(work.path, 'README.md'), 'user edit\n');
    assert.throws(() => recovered.rollback(session.id), (error: unknown) => error instanceof CoreError && error.code === 'CONFLICT');
    assert.equal(readFileSync(join(work.path, 'README.md'), 'utf8'), 'user edit\n');
    writeFileSync(join(work.path, 'README.md'), 'changed\n');
    const rolledBack = recovered.rollback(session.id);
    assert.equal(rolledBack.status, 'failed');
    assert.equal(rolledBack.verification?.rollback, 'PASS');
    assert.equal(readFileSync(join(work.path, 'README.md'), 'utf8'), 'original\n');
    reopened.close();
  } finally { work.clean(); }
});
