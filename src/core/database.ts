import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.js';

export class CoreDatabase {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string, migrateOnOpen = true) {
    this.path = path === ':memory:' ? path : resolve(path);
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path, { timeout: 5000 });
    this.db.exec('PRAGMA foreign_keys = ON');
    if (this.path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    if (migrateOnOpen) migrate(this.db);
  }

  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
