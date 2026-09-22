import type { DatabaseSync } from 'node:sqlite';

export const LATEST_SCHEMA_VERSION = 2;

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(trim(name)) > 0),
        root_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('draft','active','paused','blocked','review','completed','failed')),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        title TEXT NOT NULL CHECK(length(trim(title)) > 0),
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('queued','ready','running','waiting_user','waiting_provider','reviewing','passed','failed','cancelled')),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX tasks_project_id_idx ON tasks(project_id);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        recovered_at TEXT,
        error TEXT
      );
      CREATE INDEX runs_task_id_idx ON runs(task_id, started_at);
      CREATE INDEX runs_status_idx ON runs(status);
      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
        note TEXT NOT NULL DEFAULT '',
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX checkpoints_project_id_idx ON checkpoints(project_id, created_at);
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
        relative_path TEXT NOT NULL,
        sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX artifacts_project_id_idx ON artifacts(project_id);
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        summary TEXT NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX decisions_project_id_idx ON decisions(project_id);
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX events_project_id_idx ON events(project_id, created_at);
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        action TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
        requested_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX approvals_project_id_idx ON approvals(project_id);
      CREATE TABLE capabilities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('available','unavailable','degraded')),
        source TEXT NOT NULL,
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        checked_at TEXT NOT NULL
      );
    `,
  },
] as const;

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

export function migrate(db: DatabaseSync, targetVersion = LATEST_SCHEMA_VERSION): number {
  const current = schemaVersion(db);
  if (!Number.isInteger(targetVersion) || targetVersion < current || targetVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported SQLite migration: ${current} -> ${targetVersion}`);
  }
  for (const migration of migrations) {
    if (migration.version <= current || migration.version > targetVersion) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return schemaVersion(db);
}
