export const CAPABILITY_TYPES = ['CLI','CODEX','SKILL','MCP','NODE_DEPENDENCY','BUILD_RUNNER','TEST_RUNNER'] as const;
export const DISCOVERY_STATES = ['NOT_CHECKED','FOUND','NOT_FOUND','ERROR'] as const;
export const INSTALLATION_STATES = ['NOT_INSTALLED','INSTALLED','PARTIAL','UNKNOWN'] as const;
export const AUTH_STATES = ['NOT_REQUIRED','AUTHENTICATED','AUTH_REQUIRED','UNKNOWN'] as const;
export const COST_STATES = ['FREE_LOCAL','FREE_EXISTING_ACCOUNT','UNKNOWN_COST','PAID','USAGE_BASED_PAID'] as const;
export const VERIFICATION_STATES = ['NOT_RUN','PASS','FAIL','ERROR'] as const;
export const RUNTIME_STATES = ['NOT_REQUIRED','NOT_CHECKED','VERIFIED','FAILED','ERROR'] as const;
export const ENABLEMENT_STATES = ['ENABLED','DISABLED'] as const;
export const APPROVAL_STATES = ['NOT_REQUIRED','REQUIRED','PENDING','APPROVED','REJECTED'] as const;
export const SOURCE_TRUST_STATES = ['OFFICIAL','VERIFIED_REPOSITORY','USER_APPROVED','UNKNOWN','BLOCKED'] as const;
export const SOURCE_KINDS = ['LOCAL_PATH','EXECUTABLE','PACKAGE','GITHUB','CONFIG','BUILTIN'] as const;
export const INSTALL_METHODS = ['NONE','LOCAL_COPY','MANUAL'] as const;
export const OPERATION_KINDS = ['INSTALL','VERIFY_MCP','ENABLE','DISABLE','ROLLBACK'] as const;
export const OPERATION_STATUSES = ['PLANNED','APPROVAL_PENDING','APPROVED','RUNNING','COMPLETED','FAILED','ROLLED_BACK','REJECTED'] as const;

export type CapabilityType = typeof CAPABILITY_TYPES[number];
export type DiscoveryState = typeof DISCOVERY_STATES[number];
export type InstallationState = typeof INSTALLATION_STATES[number];
export type AuthState = typeof AUTH_STATES[number];
export type CostState = typeof COST_STATES[number];
export type VerificationState = typeof VERIFICATION_STATES[number];
export type RuntimeState = typeof RUNTIME_STATES[number];
export type EnablementState = typeof ENABLEMENT_STATES[number];
export type CapabilityApprovalState = typeof APPROVAL_STATES[number];
export type SourceTrustState = typeof SOURCE_TRUST_STATES[number];
export type SourceKind = typeof SOURCE_KINDS[number];
export type InstallMethod = typeof INSTALL_METHODS[number];
export type OperationKind = typeof OPERATION_KINDS[number];
export type OperationStatus = typeof OPERATION_STATUSES[number];

export type CapabilityOverallStatus =
  | 'AVAILABLE'
  | 'UNAVAILABLE'
  | 'UNVERIFIED'
  | 'DISABLED'
  | 'AUTH_REQUIRED'
  | 'MISSING_DEPENDENCY'
  | 'BLOCKED_BY_COST'
  | 'UNSUPPORTED'
  | 'ERROR';

export interface ManagedCapability {
  id: string;
  projectId: string | null;
  scopeKey: string;
  name: string;
  type: CapabilityType;
  discoveryState: DiscoveryState;
  installationState: InstallationState;
  authState: AuthState;
  costState: CostState;
  verificationState: VerificationState;
  runtimeState: RuntimeState;
  enablementState: EnablementState;
  approvalState: CapabilityApprovalState;
  version: string | null;
  sourceRef: string | null;
  details: Record<string, unknown>;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilitySource {
  id: string;
  capabilityId: string;
  trustState: SourceTrustState;
  sourceKind: SourceKind;
  location: string;
  version: string | null;
  license: string | null;
  costState: CostState;
  installMethod: InstallMethod;
  metadata: Record<string, unknown>;
  checkedAt: string;
}

export interface CapabilityCheck {
  id: string;
  capabilityId: string;
  checkKind: string;
  result: 'PASS' | 'FAIL' | 'ERROR' | 'NOT_RUN';
  detail: string;
  evidence: Record<string, unknown>;
  checkedAt: string;
}

export interface CapabilityDependency {
  capabilityId: string;
  dependencyName: string;
  status: 'AVAILABLE' | 'MISSING' | 'UNKNOWN' | 'ERROR';
  detail: string;
}

export interface CapabilityOperation {
  id: string;
  capabilityId: string;
  projectId: string;
  kind: OperationKind;
  status: OperationStatus;
  approvalId: string | null;
  checkpointId: string | null;
  preview: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityChange {
  id: string;
  operationId: string;
  path: string;
  changeType: 'CREATE' | 'MODIFY' | 'DELETE';
  beforeSha256: string | null;
  afterSha256: string | null;
  backupPath: string | null;
}

export interface CapabilityView extends ManagedCapability {
  overallStatus: CapabilityOverallStatus;
  source: CapabilitySource | null;
  dependencies: CapabilityDependency[];
}

export interface CapabilitySnapshot {
  projectId: string;
  capabilities: CapabilityView[];
  operations: CapabilityOperation[];
}

export interface SkillFileEvidence {
  relativePath: string;
  sha256: string;
  size: number;
}

export interface SkillInspection {
  name: string;
  description: string;
  rootPath: string;
  files: SkillFileEvidence[];
  totalBytes: number;
}

export interface McpDefinition {
  name: string;
  command: string;
  args: string[];
  configPath: string;
  protocolMode: 'auto' | 'modern' | 'legacy';
  trustState: SourceTrustState;
  costState: CostState;
  authRequired: boolean;
  envKeys: string[];
}

export interface McpProbeResult {
  ok: boolean;
  era: 'modern' | 'legacy' | null;
  detail: string;
  serverInfo: Record<string, unknown> | null;
}

export function capabilityOverallStatus(capability: ManagedCapability): CapabilityOverallStatus {
  if (capability.discoveryState === 'ERROR' || capability.verificationState === 'ERROR' || capability.runtimeState === 'ERROR') return 'ERROR';
  if (capability.discoveryState === 'NOT_FOUND') return 'MISSING_DEPENDENCY';
  if (capability.costState === 'PAID' || capability.costState === 'USAGE_BASED_PAID' || capability.costState === 'UNKNOWN_COST') return 'BLOCKED_BY_COST';
  if (capability.installationState === 'NOT_INSTALLED' || capability.installationState === 'PARTIAL') return 'MISSING_DEPENDENCY';
  if (capability.authState === 'AUTH_REQUIRED') return 'AUTH_REQUIRED';
  if (capability.enablementState === 'DISABLED') return 'DISABLED';
  if (capability.verificationState === 'FAIL' || capability.runtimeState === 'FAILED') return 'ERROR';
  if (capability.discoveryState === 'NOT_CHECKED' || capability.verificationState !== 'PASS' || capability.runtimeState === 'NOT_CHECKED') return 'UNVERIFIED';
  if (capability.installationState === 'UNKNOWN' || capability.authState === 'UNKNOWN') return 'UNVERIFIED';
  return 'AVAILABLE';
}
