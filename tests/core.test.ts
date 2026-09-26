import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/core/database.js';
import { CoreEngine } from '../src/core/engine.js';
import { schemaVersion, migrate } from '../src/core/migrations.js';
import { CoreError } from '../src/core/domain.js';
import { committedFixture, fixture } from './helpers.js';

test('SQLite migration 1 to 8 preserves records and is idempotent', () => {
  const work = fixture();
  try {
    const db = new CoreDatabase(join(work.path, 'state.sqlite'), false);
    assert.equal(migrate(db.db, 1), 1);
    db.db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)').run('p1', 'saved', work.path, 'draft', 1, 't', 't');
    assert.equal(migrate(db.db, 2), 2);
    assert.equal(migrate(db.db, 3), 3);
    assert.equal(migrate(db.db, 4), 4);
    assert.equal(migrate(db.db, 5), 5);
    assert.equal(migrate(db.db), 8);
    assert.equal(migrate(db.db), 8);
    assert.equal(schemaVersion(db.db), 8);
    assert.equal((db.db.prepare('SELECT name FROM projects WHERE id = ?').get('p1') as { name: string }).name, 'saved');
    assert.equal((db.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    db.close();
  } finally { work.clean(); }
});

test('project, task and all core records survive close and reopen', () => {
  const work = committedFixture();
  const path = join(work.path, 'state.sqlite');
  try {
    let engine = new CoreEngine(path);
    const project = engine.createProject('Company', work.path);
    const task = engine.repository.createTask(project.id, 'Implement core');
    engine.repository.setProjectStatus(project.id, 'active');
    engine.repository.setTaskStatus(task.id, 'ready');
    const checkpoint = engine.checkpoint(project.id, 'baseline', task.id);
    const decision = engine.repository.addDecision(project.id, 'Use SQLite', 'Local source of truth', task.id);
    const approval = engine.repository.requestApproval(project.id, 'ship', task.id);
    engine.repository.resolveApproval(approval.id, 'approved');
    const capability = engine.repository.setCapability('git', 'available', 'local', { version: 1 });
    const artifact = engine.addArtifact(project.id, 'README.md', 'document', task.id);
    assert.throws(() => engine.addArtifact(project.id, '../outside.txt', 'document'), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
    assert.throws(() => engine.addArtifact(project.id, '.', 'document'), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
    engine.close();

    engine = new CoreEngine(path);
    assert.equal(engine.repository.getProject(project.id).status, 'active');
    assert.equal(engine.repository.getTask(task.id).status, 'ready');
    assert.throws(() => engine.repository.setTaskStatus(task.id, 'running'), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_TRANSITION');
    assert.equal(engine.repository.listCheckpoints(project.id)[0]?.id, checkpoint.id);
    assert.equal(engine.repository.listDecisions(project.id)[0]?.id, decision.id);
    assert.equal(engine.repository.listApprovals(project.id)[0]?.status, 'approved');
    assert.equal(engine.repository.getCapability('git').id, capability.id);
    assert.equal(engine.repository.listArtifacts(project.id)[0]?.sha256, artifact.sha256);
    assert.equal(engine.repository.listEvents(project.id).some(e => e.type === 'task.status_changed'), true);
    assert.throws(() => engine.repository.setTaskStatus(task.id, 'passed'), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_TRANSITION');
    engine.close();
  } finally { work.clean(); }
});

test('completed run moves task to review and persists both records', () => {
  const work = committedFixture();
  const path = join(work.path, 'state.sqlite');
  try {
    const engine = new CoreEngine(path);
    const project = engine.createProject('Finish', work.path);
    const task = engine.repository.createTask(project.id, 'Finish me');
    engine.repository.setTaskStatus(task.id, 'ready');
    const run = engine.startRun(task.id);
    assert.equal(engine.repository.finishRun(run.id, 'completed').status, 'completed');
    assert.equal(engine.repository.getTask(task.id).status, 'reviewing');
    engine.repository.setTaskStatus(task.id, 'passed');
    assert.equal(engine.repository.getTask(task.id).status, 'passed');
    engine.close();
    const reopened = new CoreEngine(path);
    assert.equal(reopened.repository.getRun(run.id).status, 'completed');
    assert.equal(reopened.repository.getTask(task.id).status, 'passed');
    reopened.close();
  } finally { work.clean(); }
});

test('dirty tree blocks run start; restart marks in-flight run interrupted once', () => {
  const work = committedFixture();
  const path = join(work.path, 'state.sqlite');
  try {
    let engine = new CoreEngine(path);
    const project = engine.createProject('Recovery', work.path);
    const task = engine.repository.createTask(project.id, 'Run me');
    engine.repository.setTaskStatus(task.id, 'ready');
    writeFileSync(join(work.path, 'dirty.txt'), 'dirty');
    assert.throws(() => engine.startRun(task.id), (error: unknown) => error instanceof CoreError && error.code === 'DIRTY_WORKTREE');
    const dirtyCheckpoint = engine.checkpoint(project.id);
    assert.equal(dirtyCheckpoint.snapshot.dirty, true);
    work.git('add', 'dirty.txt'); work.commit();
    const run = engine.startRun(task.id);
    assert.equal(engine.repository.getTask(task.id).status, 'running');
    engine.close();

    engine = new CoreEngine(path);
    assert.equal(engine.recoveredRuns, 1);
    assert.equal(engine.repository.getRun(run.id).status, 'interrupted');
    assert.equal(engine.repository.getTask(task.id).status, 'waiting_provider');
    assert.equal(engine.repository.listEvents(project.id).filter(e => e.type === 'run.interrupted').length, 1);
    engine.close();
    engine = new CoreEngine(path);
    assert.equal(engine.recoveredRuns, 0);
    engine.close();
  } finally { work.clean(); }
});
