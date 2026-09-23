import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CoreDatabase } from '../core/database.js';
import { CoreError, nonEmpty } from '../core/domain.js';
import {
  APPROVAL_STATES,
  AUTH_STATES,
  CAPABILITY_TYPES,
  COST_STATES,
  DISCOVERY_STATES,
  ENABLEMENT_STATES,
  INSTALLATION_STATES,
  INSTALL_METHODS,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  RUNTIME_STATES,
  SOURCE_KINDS,
  SOURCE_TRUST_STATES,
  VERIFICATION_STATES,
  capabilityOverallStatus,
  type AuthState,
  type CapabilityApprovalState,
  type CapabilityChange,
  type CapabilityCheck,
  type CapabilityDependency,
  type CapabilityOperation,
  type CapabilitySnapshot,
  type CapabilitySource,
  type CapabilityType,
  type CapabilityView,
  type CostState,
  type DiscoveryState,
  type EnablementState,
  type InstallMethod,
  type InstallationState,
  type ManagedCapability,
  type OperationKind,
  type OperationStatus,
  type RuntimeState,
  type SourceKind,
  type SourceTrustState,
  type VerificationState,
} from './types.js';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const id = (): string => randomUUID();
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new CoreError('NOT_FOUND', `${label} not found`);
  return value;
};
const oneOf = <T extends string>(value: string, allowed: readonly T[], label: string): T => {
  if (!allowed.includes(value as T)) throw new CoreError('INVALID_INPUT', `Invalid ${label}: ${value}`);
  return value as T;
};

export interface CapabilityUpsert {
  projectId: string;
  name: string;
  type: CapabilityType;
  discoveryState: DiscoveryState;
  installationState: InstallationState;
  authState: AuthState;
  costState: CostState;
  verificationState: VerificationState;
  runtimeState: RuntimeState;
  enablementState?: EnablementState;
  approvalState?: CapabilityApprovalState;
  version?: string | null;
  sourceRef?: string | null;
  details?: Record<string, unknown>;
  lastCheckedAt?: string | null;
}

export interface SourceInput {
  trustState: SourceTrustState;
  sourceKind: SourceKind;
  location: string;
  version?: string | null;
  license?: string | null;
  costState: CostState;
  installMethod: InstallMethod;
  metadata?: Record<string, unknown>;
}

export class CapabilityStore {
  private readonly db: DatabaseSync;
  constructor(private readonly database: CoreDatabase) { this.db = database.db; }

  private event(projectId: string, type: string, payload: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id(), projectId, null, null, type, JSON.stringify(payload), now(),
    );
  }

  private capability(row: Row): ManagedCapability {
    return {
      id: String(row.id),
      projectId: row.project_id === null ? null : String(row.project_id),
      scopeKey: String(row.scope_key),
      name: String(row.name),
      type: row.type as CapabilityType,
      discoveryState: row.discovery_state as DiscoveryState,
      installationState: row.installation_state as InstallationState,
      authState: row.auth_state as AuthState,
      costState: row.cost_state as CostState,
      verificationState: row.verification_state as VerificationState,
      runtimeState: row.runtime_state as RuntimeState,
      enablementState: row.enablement_state as EnablementState,
      approvalState: row.approval_state as CapabilityApprovalState,
      version: row.version === null ? null : String(row.version),
      sourceRef: row.source_ref === null ? null : String(row.source_ref),
      details: parse<Record<string, unknown>>(row.details_json),
      lastCheckedAt: row.last_checked_at === null ? null : String(row.last_checked_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private source(row: Row): CapabilitySource {
    return {
      id: String(row.id),
      capabilityId: String(row.capability_id),
      trustState: row.trust_state as SourceTrustState,
      sourceKind: row.source_kind as SourceKind,
      location: String(row.location),
      version: row.version === null ? null : String(row.version),
      license: row.license === null ? null : String(row.license),
      costState: row.cost_state as CostState,
      installMethod: row.install_method as InstallMethod,
      metadata: parse<Record<string, unknown>>(row.metadata_json),
      checkedAt: String(row.checked_at),
    };
  }

  private operation(row: Row): CapabilityOperation {
    return {
      id: String(row.id),
      capabilityId: String(row.capability_id),
      projectId: String(row.project_id),
      kind: row.kind as OperationKind,
      status: row.status as OperationStatus,
      approvalId: row.approval_id === null ? null : String(row.approval_id),
      checkpointId: row.checkpoint_id === null ? null : String(row.checkpoint_id),
      preview: parse<Record<string, unknown>>(row.preview_json),
      snapshot: parse<Record<string, unknown>>(row.snapshot_json),
      error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  upsert(input: CapabilityUpsert): ManagedCapability {
    const projectId = nonEmpty(input.projectId, 'projectId', 200);
    const name = nonEmpty(input.name, 'capability name', 200);
    const type = oneOf(input.type, CAPABILITY_TYPES, 'capability type');
    const discoveryState = oneOf(input.discoveryState, DISCOVERY_STATES, 'discovery state');
    const installationState = oneOf(input.installationState, INSTALLATION_STATES, 'installation state');
    const authState = oneOf(input.authState, AUTH_STATES, 'auth state');
    const costState = oneOf(input.costState, COST_STATES, 'cost state');
    const verificationState = oneOf(input.verificationState, VERIFICATION_STATES, 'verification state');
    const runtimeState = oneOf(input.runtimeState, RUNTIME_STATES, 'runtime state');
    const enablementState = oneOf(input.enablementState ?? 'ENABLED', ENABLEMENT_STATES, 'enablement state');
    const approvalState = oneOf(input.approvalState ?? 'NOT_REQUIRED', APPROVAL_STATES, 'approval state');
    const timestamp = now();
    this.database.transaction(() => {
      this.db.prepare(`
        INSERT INTO capability_registry_v2 (
          id, project_id, scope_key, name, type, discovery_state, installation_state, auth_state,
          cost_state, verification_state, runtime_state, enablement_state, approval_state,
          version, source_ref, details_json, last_checked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key, name) DO UPDATE SET
          project_id = excluded.project_id,
          type = excluded.type,
          discovery_state = excluded.discovery_state,
          installation_state = excluded.installation_state,
          auth_state = excluded.auth_state,
          cost_state = excluded.cost_state,
          verification_state = excluded.verification_state,
          runtime_state = excluded.runtime_state,
          enablement_state = excluded.enablement_state,
          approval_state = excluded.approval_state,
          version = excluded.version,
          source_ref = excluded.source_ref,
          details_json = excluded.details_json,
          last_checked_at = excluded.last_checked_at,
          updated_at = excluded.updated_at
      `).run(
        id(), projectId, projectId, name, type, discoveryState, installationState, authState,
        costState, verificationState, runtimeState, enablementState, approvalState,
        input.version ?? null, input.sourceRef ?? null, JSON.stringify(input.details ?? {}),
        input.lastCheckedAt ?? timestamp, timestamp, timestamp,
      );
      this.event(projectId, 'capability.observed', {
        name, type, discoveryState, installationState, authState, costState, verificationState, runtimeState,
      });
    });
    return this.getByName(projectId, name);
  }

  patch(capabilityId: string, patch: Partial<Pick<
    ManagedCapability,
    'discoveryState' | 'installationState' | 'authState' | 'costState' | 'verificationState' |
    'runtimeState' | 'enablementState' | 'approvalState' | 'version' | 'sourceRef' | 'details' | 'lastCheckedAt'
  >>): ManagedCapability {
    const current = this.get(capabilityId);
    const next: ManagedCapability = { ...current, ...patch, updatedAt: now() };
    oneOf(next.discoveryState, DISCOVERY_STATES, 'discovery state');
    oneOf(next.installationState, INSTALLATION_STATES, 'installation state');
    oneOf(next.authState, AUTH_STATES, 'auth state');
    oneOf(next.costState, COST_STATES, 'cost state');
    oneOf(next.verificationState, VERIFICATION_STATES, 'verification state');
    oneOf(next.runtimeState, RUNTIME_STATES, 'runtime state');
    oneOf(next.enablementState, ENABLEMENT_STATES, 'enablement state');
    oneOf(next.approvalState, APPROVAL_STATES, 'approval state');
    this.db.prepare(`
      UPDATE capability_registry_v2 SET
        discovery_state = ?, installation_state = ?, auth_state = ?, cost_state = ?,
        verification_state = ?, runtime_state = ?, enablement_state = ?, approval_state = ?,
        version = ?, source_ref = ?, details_json = ?, last_checked_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.discoveryState, next.installationState, next.authState, next.costState,
      next.verificationState, next.runtimeState, next.enablementState, next.approvalState,
      next.version, next.sourceRef, JSON.stringify(next.details), next.lastCheckedAt, next.updatedAt, capabilityId,
    );
    if (current.projectId) this.event(current.projectId, 'capability.state_changed', {
      capabilityId, name: current.name, overallStatus: capabilityOverallStatus(next),
    });
    return this.get(capabilityId);
  }

  get(capabilityId: string): ManagedCapability {
    return this.capability(required(
      this.db.prepare('SELECT * FROM capability_registry_v2 WHERE id = ?').get(capabilityId) as Row | undefined,
      'Capability',
    ));
  }

  getByName(projectId: string, name: string): ManagedCapability {
    return this.capability(required(
      this.db.prepare('SELECT * FROM capability_registry_v2 WHERE scope_key = ? AND name = ?').get(projectId, name) as Row | undefined,
      'Capability',
    ));
  }

  findByName(projectId: string, name: string): ManagedCapability | null {
    const row = this.db.prepare('SELECT * FROM capability_registry_v2 WHERE scope_key = ? AND name = ?').get(projectId, name) as Row | undefined;
    return row ? this.capability(row) : null;
  }

  list(projectId: string): ManagedCapability[] {
    return (this.db.prepare('SELECT * FROM capability_registry_v2 WHERE project_id = ? ORDER BY type, name').all(projectId) as Row[])
      .map(row => this.capability(row));
  }

  addSource(capabilityId: string, input: SourceInput): CapabilitySource {
    this.get(capabilityId);
    const source: CapabilitySource = {
      id: id(),
      capabilityId,
      trustState: oneOf(input.trustState, SOURCE_TRUST_STATES, 'source trust'),
      sourceKind: oneOf(input.sourceKind, SOURCE_KINDS, 'source kind'),
      location: nonEmpty(input.location, 'source location', 20_000),
      version: input.version ?? null,
      license: input.license ?? null,
      costState: oneOf(input.costState, COST_STATES, 'source cost'),
      installMethod: oneOf(input.installMethod, INSTALL_METHODS, 'install method'),
      metadata: input.metadata ?? {},
      checkedAt: now(),
    };
    this.db.prepare('INSERT INTO capability_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      source.id, source.capabilityId, source.trustState, source.sourceKind, source.location,
      source.version, source.license, source.costState, source.installMethod,
      JSON.stringify(source.metadata), source.checkedAt,
    );
    return source;
  }

  latestSource(capabilityId: string): CapabilitySource | null {
    const row = this.db.prepare('SELECT * FROM capability_sources WHERE capability_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1')
      .get(capabilityId) as Row | undefined;
    return row ? this.source(row) : null;
  }

  setLatestSourceTrust(capabilityId: string, trustState: SourceTrustState): CapabilitySource {
    const source = this.latestSource(capabilityId);
    if (!source) throw new CoreError('NOT_FOUND', 'Capability source not found');
    const trust = oneOf(trustState, SOURCE_TRUST_STATES, 'source trust');
    this.db.prepare('UPDATE capability_sources SET trust_state = ?, checked_at = ? WHERE id = ?').run(trust, now(), source.id);
    return this.latestSource(capabilityId)!;
  }

  addCheck(capabilityId: string, checkKind: string, result: CapabilityCheck['result'], detail: string, evidence: Record<string, unknown> = {}): CapabilityCheck {
    this.get(capabilityId);
    if (!['PASS','FAIL','ERROR','NOT_RUN'].includes(result)) throw new CoreError('INVALID_INPUT', 'Invalid check result');
    const check: CapabilityCheck = {
      id: id(), capabilityId, checkKind: nonEmpty(checkKind, 'check kind', 200), result,
      detail: detail.slice(0, 20_000), evidence, checkedAt: now(),
    };
    this.db.prepare('INSERT INTO capability_checks VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      check.id, check.capabilityId, check.checkKind, check.result, check.detail,
      JSON.stringify(check.evidence), check.checkedAt,
    );
    return check;
  }

  listChecks(capabilityId: string): CapabilityCheck[] {
    return (this.db.prepare('SELECT * FROM capability_checks WHERE capability_id = ? ORDER BY checked_at, rowid').all(capabilityId) as Row[]).map(row => ({
      id: String(row.id), capabilityId: String(row.capability_id), checkKind: String(row.check_kind),
      result: row.result as CapabilityCheck['result'], detail: String(row.detail),
      evidence: parse<Record<string, unknown>>(row.evidence_json), checkedAt: String(row.checked_at),
    }));
  }

  replaceDependencies(capabilityId: string, dependencies: Omit<CapabilityDependency, 'capabilityId'>[]): CapabilityDependency[] {
    this.get(capabilityId);
    this.database.transaction(() => {
      this.db.prepare('DELETE FROM capability_dependencies WHERE capability_id = ?').run(capabilityId);
      for (const dependency of dependencies) {
        if (!['AVAILABLE','MISSING','UNKNOWN','ERROR'].includes(dependency.status)) throw new CoreError('INVALID_INPUT', 'Invalid dependency status');
        this.db.prepare('INSERT INTO capability_dependencies VALUES (?, ?, ?, ?)').run(
          capabilityId, nonEmpty(dependency.dependencyName, 'dependency name', 200), dependency.status, dependency.detail.slice(0, 4000),
        );
      }
    });
    return this.listDependencies(capabilityId);
  }

  listDependencies(capabilityId: string): CapabilityDependency[] {
    return (this.db.prepare('SELECT * FROM capability_dependencies WHERE capability_id = ? ORDER BY dependency_name').all(capabilityId) as Row[]).map(row => ({
      capabilityId: String(row.capability_id), dependencyName: String(row.dependency_name),
      status: row.status as CapabilityDependency['status'], detail: String(row.detail),
    }));
  }

  createOperation(input: {
    capabilityId: string;
    projectId: string;
    kind: OperationKind;
    status: OperationStatus;
    approvalId?: string | null;
    checkpointId?: string | null;
    preview?: Record<string, unknown>;
    snapshot?: Record<string, unknown>;
  }): CapabilityOperation {
    const capability = this.get(input.capabilityId);
    if (capability.projectId !== input.projectId) throw new CoreError('INVALID_INPUT', 'Capability belongs to another project');
    const timestamp = now();
    const operation: CapabilityOperation = {
      id: id(), capabilityId: input.capabilityId, projectId: input.projectId,
      kind: oneOf(input.kind, OPERATION_KINDS, 'operation kind'),
      status: oneOf(input.status, OPERATION_STATUSES, 'operation status'),
      approvalId: input.approvalId ?? null, checkpointId: input.checkpointId ?? null,
      preview: input.preview ?? {}, snapshot: input.snapshot ?? {}, error: null,
      createdAt: timestamp, updatedAt: timestamp,
    };
    this.database.transaction(() => {
      this.db.prepare('INSERT INTO capability_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        operation.id, operation.capabilityId, operation.projectId, operation.kind, operation.status,
        operation.approvalId, operation.checkpointId, JSON.stringify(operation.preview),
        JSON.stringify(operation.snapshot), null, operation.createdAt, operation.updatedAt,
      );
      this.event(operation.projectId, 'capability.operation_created', {
        operationId: operation.id, capabilityId: operation.capabilityId, kind: operation.kind, status: operation.status,
      });
    });
    return operation;
  }

  getOperation(operationId: string): CapabilityOperation {
    return this.operation(required(
      this.db.prepare('SELECT * FROM capability_operations WHERE id = ?').get(operationId) as Row | undefined,
      'Capability operation',
    ));
  }

  listOperations(projectId: string): CapabilityOperation[] {
    return (this.db.prepare('SELECT * FROM capability_operations WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as Row[])
      .map(row => this.operation(row));
  }

  updateOperation(operationId: string, status: OperationStatus, patch: {
    approvalId?: string | null;
    checkpointId?: string | null;
    preview?: Record<string, unknown>;
    snapshot?: Record<string, unknown>;
    error?: string | null;
  } = {}): CapabilityOperation {
    const current = this.getOperation(operationId);
    const nextStatus = oneOf(status, OPERATION_STATUSES, 'operation status');
    const updatedAt = now();
    this.db.prepare(`
      UPDATE capability_operations SET status = ?, approval_id = ?, checkpoint_id = ?,
        preview_json = ?, snapshot_json = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(
      nextStatus,
      patch.approvalId === undefined ? current.approvalId : patch.approvalId,
      patch.checkpointId === undefined ? current.checkpointId : patch.checkpointId,
      JSON.stringify(patch.preview ?? current.preview),
      JSON.stringify(patch.snapshot ?? current.snapshot),
      patch.error === undefined ? current.error : patch.error,
      updatedAt, operationId,
    );
    this.event(current.projectId, 'capability.operation_state_changed', {
      operationId, capabilityId: current.capabilityId, from: current.status, to: nextStatus,
    });
    return this.getOperation(operationId);
  }

  addChange(operationId: string, change: Omit<CapabilityChange, 'id' | 'operationId'>): CapabilityChange {
    this.getOperation(operationId);
    const record: CapabilityChange = { id: id(), operationId, ...change };
    this.db.prepare('INSERT INTO capability_changes VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      record.id, record.operationId, record.path, record.changeType,
      record.beforeSha256, record.afterSha256, record.backupPath,
    );
    return record;
  }

  listChanges(operationId: string): CapabilityChange[] {
    return (this.db.prepare('SELECT * FROM capability_changes WHERE operation_id = ? ORDER BY path').all(operationId) as Row[]).map(row => ({
      id: String(row.id), operationId: String(row.operation_id), path: String(row.path),
      changeType: row.change_type as CapabilityChange['changeType'],
      beforeSha256: row.before_sha256 === null ? null : String(row.before_sha256),
      afterSha256: row.after_sha256 === null ? null : String(row.after_sha256),
      backupPath: row.backup_path === null ? null : String(row.backup_path),
    }));
  }

  snapshot(projectId: string): CapabilitySnapshot {
    const capabilities: CapabilityView[] = this.list(projectId).map(capability => ({
      ...capability,
      overallStatus: capabilityOverallStatus(capability),
      source: this.latestSource(capability.id),
      dependencies: this.listDependencies(capability.id),
    }));
    return { projectId, capabilities, operations: this.listOperations(projectId) };
  }
}
