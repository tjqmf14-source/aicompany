import type { DatabaseSync } from 'node:sqlite';

export const LATEST_SCHEMA_VERSION = 6;

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
  {
    version: 3,
    sql: `
      CREATE TABLE handoffs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('awaiting_response','ready_to_apply','applying','verified','failed','recovery_required')),
        objective TEXT NOT NULL,
        bundle_path TEXT NOT NULL,
        base_head TEXT,
        base_branch TEXT,
        response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
        preview_json TEXT CHECK(preview_json IS NULL OR json_valid(preview_json)),
        checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
        verification_json TEXT CHECK(verification_json IS NULL OR json_valid(verification_json)),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX handoffs_project_id_idx ON handoffs(project_id, created_at);
      CREATE INDEX handoffs_status_idx ON handoffs(status);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE codex_executions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('checking','running','high_ready','completed','failed','recovery_required')),
        objective TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        model TEXT,
        effort TEXT CHECK(effort IS NULL OR effort IN ('low','medium','high','xhigh','max')),
        base_head TEXT,
        base_branch TEXT,
        checkpoint_id TEXT REFERENCES checkpoints(id) ON DELETE RESTRICT,
        handoff_id TEXT REFERENCES handoffs(id) ON DELETE RESTRICT,
        rate_limit_json TEXT CHECK(rate_limit_json IS NULL OR json_valid(rate_limit_json)),
        last_event_json TEXT CHECK(last_event_json IS NULL OR json_valid(last_event_json)),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX codex_executions_project_id_idx ON codex_executions(project_id, created_at);
      CREATE INDEX codex_executions_task_id_idx ON codex_executions(task_id, created_at);
      CREATE INDEX codex_executions_status_idx ON codex_executions(status);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE organization_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        objective TEXT NOT NULL CHECK(length(trim(objective)) > 0),
        status TEXT NOT NULL CHECK(status IN ('draft','active','blocked','completed')),
        stage TEXT NOT NULL CHECK(stage IN ('planning','execution','validation','independent_review','qa','pd_acceptance','completed','blocked')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX organization_plans_project_id_idx ON organization_plans(project_id, created_at);

      CREATE TABLE organization_assignments (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
        plan_id TEXT NOT NULL REFERENCES organization_plans(id) ON DELETE RESTRICT,
        role TEXT NOT NULL CHECK(role IN ('Executive PD','Planning','Research','Design Director','UI/UX','Visual Design','Engineering Director','Coding','Code Review','QA','Security','Release')),
        priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 10000),
        provider TEXT NOT NULL CHECK(provider IN ('GPT_HIGH','CODEX','SYSTEM')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX organization_assignments_plan_id_idx ON organization_assignments(plan_id, priority);

      CREATE TABLE organization_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        PRIMARY KEY(task_id, depends_on_task_id),
        CHECK(task_id <> depends_on_task_id)
      );

      CREATE TABLE organization_gates (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES organization_plans(id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK(kind IN ('validation','independent_review','qa','pd_acceptance')),
        result TEXT NOT NULL CHECK(result IN ('PASS','FAIL')),
        summary TEXT NOT NULL CHECK(length(trim(summary)) > 0),
        evidence TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX organization_gates_plan_id_idx ON organization_gates(plan_id, created_at);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE capability_registry_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        scope_key TEXT NOT NULL,
        name TEXT NOT NULL CHECK(length(trim(name)) > 0),
        type TEXT NOT NULL CHECK(type IN ('CLI','CODEX','SKILL','MCP','NODE_DEPENDENCY','BUILD_RUNNER','TEST_RUNNER')),
        discovery_state TEXT NOT NULL CHECK(discovery_state IN ('NOT_CHECKED','FOUND','NOT_FOUND','ERROR')),
        installation_state TEXT NOT NULL CHECK(installation_state IN ('NOT_INSTALLED','INSTALLED','PARTIAL','UNKNOWN')),
        auth_state TEXT NOT NULL CHECK(auth_state IN ('NOT_REQUIRED','AUTHENTICATED','AUTH_REQUIRED','UNKNOWN')),
        cost_state TEXT NOT NULL CHECK(cost_state IN ('FREE_LOCAL','FREE_EXISTING_ACCOUNT','UNKNOWN_COST','PAID','USAGE_BASED_PAID')),
        verification_state TEXT NOT NULL CHECK(verification_state IN ('NOT_RUN','PASS','FAIL','ERROR')),
        runtime_state TEXT NOT NULL CHECK(runtime_state IN ('NOT_REQUIRED','NOT_CHECKED','VERIFIED','FAILED','ERROR')),
        enablement_state TEXT NOT NULL CHECK(enablement_state IN ('ENABLED','DISABLED')),
        approval_state TEXT NOT NULL CHECK(approval_state IN ('NOT_REQUIRED','REQUIRED','PENDING','APPROVED','REJECTED')),
        version TEXT,
        source_ref TEXT,
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_key, name)
      );
      CREATE INDEX capability_registry_v2_project_idx ON capability_registry_v2(project_id, name);
      CREATE INDEX capability_registry_v2_state_idx ON capability_registry_v2(discovery_state, verification_state, runtime_state);

      CREATE TABLE capability_sources (
        id TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL REFERENCES capability_registry_v2(id) ON DELETE CASCADE,
        trust_state TEXT NOT NULL CHECK(trust_state IN ('OFFICIAL','VERIFIED_REPOSITORY','USER_APPROVED','UNKNOWN','BLOCKED')),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('LOCAL_PATH','EXECUTABLE','PACKAGE','GITHUB','CONFIG','BUILTIN')),
        location TEXT NOT NULL,
        version TEXT,
        license TEXT,
        cost_state TEXT NOT NULL CHECK(cost_state IN ('FREE_LOCAL','FREE_EXISTING_ACCOUNT','UNKNOWN_COST','PAID','USAGE_BASED_PAID')),
        install_method TEXT NOT NULL CHECK(install_method IN ('NONE','LOCAL_COPY','MANUAL')),
        metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
        checked_at TEXT NOT NULL
      );
      CREATE INDEX capability_sources_capability_idx ON capability_sources(capability_id, checked_at);

      CREATE TABLE capability_checks (
        id TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL REFERENCES capability_registry_v2(id) ON DELETE CASCADE,
        check_kind TEXT NOT NULL,
        result TEXT NOT NULL CHECK(result IN ('PASS','FAIL','ERROR','NOT_RUN')),
        detail TEXT NOT NULL,
        evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
        checked_at TEXT NOT NULL
      );
      CREATE INDEX capability_checks_capability_idx ON capability_checks(capability_id, checked_at);

      CREATE TABLE capability_dependencies (
        capability_id TEXT NOT NULL REFERENCES capability_registry_v2(id) ON DELETE CASCADE,
        dependency_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('AVAILABLE','MISSING','UNKNOWN','ERROR')),
        detail TEXT NOT NULL,
        PRIMARY KEY(capability_id, dependency_name)
      );

      CREATE TABLE capability_operations (
        id TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL REFERENCES capability_registry_v2(id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK(kind IN ('INSTALL','VERIFY_MCP','ENABLE','DISABLE','ROLLBACK')),
        status TEXT NOT NULL CHECK(status IN ('PLANNED','APPROVAL_PENDING','APPROVED','RUNNING','COMPLETED','FAILED','ROLLED_BACK','REJECTED')),
        approval_id TEXT REFERENCES approvals(id) ON DELETE RESTRICT,
        checkpoint_id TEXT REFERENCES checkpoints(id) ON DELETE RESTRICT,
        preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX capability_operations_project_idx ON capability_operations(project_id, created_at);
      CREATE INDEX capability_operations_capability_idx ON capability_operations(capability_id, created_at);

      CREATE TABLE capability_changes (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES capability_operations(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        change_type TEXT NOT NULL CHECK(change_type IN ('CREATE','MODIFY','DELETE')),
        before_sha256 TEXT,
        after_sha256 TEXT,
        backup_path TEXT
      );
      CREATE INDEX capability_changes_operation_idx ON capability_changes(operation_id);
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
