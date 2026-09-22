import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { GitManager } from '../src/core/git-manager.js';
import { CoreError } from '../src/core/domain.js';
import { committedFixture, fixture } from './helpers.js';

test('new repository has branch, null HEAD, and becomes dirty without changing branch', () => {
  const work = fixture();
  try {
    const git = new GitManager(work.path);
    assert.equal(git.branch(), 'main');
    assert.equal(git.head(), null);
    assert.equal(git.snapshot().dirty, false);
    writeFileSync(join(work.path, 'new.txt'), 'new');
    assert.equal(git.snapshot().dirty, true);
    assert.deepEqual(git.status().map(x => x.path), ['new.txt']);
    assert.throws(() => git.requireClean(), (error: unknown) => error instanceof CoreError && error.code === 'DIRTY_WORKTREE');
    assert.equal(git.branch(), 'main');
  } finally { work.clean(); }
});

test('existing repository reports HEAD, tracked diff and untracked dirty state', () => {
  const work = committedFixture();
  try {
    const git = new GitManager(work.path);
    assert.match(git.head() ?? '', /^[a-f0-9]{40}$/);
    assert.equal(git.snapshot().dirty, false);
    writeFileSync(join(work.path, 'README.md'), 'changed\n');
    writeFileSync(join(work.path, 'extra.txt'), 'extra\n');
    const snapshot = git.snapshot();
    assert.equal(snapshot.dirty, true);
    assert.match(snapshot.diff, /\+changed/);
    assert.deepEqual(snapshot.changes.map(x => x.path).sort(), ['README.md', 'extra.txt']);
    assert.equal(git.branch(), 'main');
    assert.equal(work.git('status', '--porcelain').includes('extra.txt'), true);
  } finally { work.clean(); }
});
