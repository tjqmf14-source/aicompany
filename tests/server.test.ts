import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { CoreEngine } from '../src/core/engine.js';
import { createApp } from '../src/server/app.js';
import { committedFixture } from './helpers.js';

test('HTTP API creates and reloads project and task from SQLite', async () => {
  const work = committedFixture();
  const engine = new CoreEngine(join(work.path, 'state.sqlite'));
  const app = createApp(engine);
  try {
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'HTTP', rootPath: work.path } });
    assert.equal(created.statusCode, 201);
    const project = created.json() as { id: string };
    const task = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks`, payload: { title: 'HTTP task' } });
    assert.equal(task.statusCode, 201);
    const tasks = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/tasks` });
    assert.equal((tasks.json() as unknown[]).length, 1);
    const git = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/git` });
    assert.equal(git.statusCode, 200);
    const invalid = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks`, payload: { title: '' } });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.close(); engine.close(); work.clean();
  }
});
