import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { CoreDatabase } from './database.js';
import { CoreError, type Artifact, type Checkpoint, type Project, type Run } from './domain.js';
import { GitManager } from './git-manager.js';
import { CoreRepository } from './repository.js';

export class CoreEngine {
  readonly database: CoreDatabase;
  readonly repository: CoreRepository;
  readonly recoveredRuns: number;

  constructor(databasePath: string) {
    this.database = new CoreDatabase(databasePath);
    this.repository = new CoreRepository(this.database);
    this.recoveredRuns = this.repository.recoverInterruptedRuns();
  }

  createProject(name: string, path: string): Project {
    const git = new GitManager(path);
    return this.repository.createProject(name, git.rootPath);
  }

  git(projectId: string): GitManager {
    return new GitManager(this.repository.getProject(projectId).rootPath);
  }

  checkpoint(projectId: string, note = '', taskId: string | null = null, runId: string | null = null): Checkpoint {
    return this.repository.addCheckpoint(projectId, this.git(projectId).snapshot(), note, taskId, runId);
  }

  startRun(taskId: string): Run {
    const task = this.repository.getTask(taskId);
    this.git(task.projectId).requireClean();
    return this.repository.startRun(taskId);
  }

  addArtifact(projectId: string, path: string, kind: string, taskId: string | null = null, runId: string | null = null): Artifact {
    const git = this.git(projectId);
    const fullPath = git.resolveExistingPath(path);
    if (statSync(fullPath).size > 100 * 1024 * 1024) throw new CoreError('INVALID_INPUT', 'Artifact exceeds 100 MiB');
    const buffer = readFileSync(fullPath);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    return this.repository.addArtifact(projectId, relative(git.rootPath, fullPath).replaceAll('\\', '/'), sha256, kind, taskId, runId);
  }

  close(): void { this.database.close(); }
}
