import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CoreError } from '../core/domain.js';
import { CoreEngine } from '../core/engine.js';
import { CodexAppServerProvider, resolveCodexJsPath } from '../codex/provider.js';
import { CapabilityStore, type CapabilityUpsert } from './store.js';
import {
  assertContained, hasSensitiveArgument, safeExecutable, safeSkillName,
} from './security.js';
import { discoverSkills, inspectSkill } from './skill.js';
import { discoverMcpDefinitions, probeMcp, validateMcpDefinition } from './mcp.js';
import {
  capabilityOverallStatus,
  type CapabilityOperation,
  type CapabilitySnapshot,
  type CapabilityView,
  type CostState,
  type McpDefinition,
  type SkillFileEvidence,
} from './types.js';

const now = (): string => new Date().toISOString();

function commandVersion(command: string, args: string[] = ['--version']): { ok: boolean; detail: string; version: string | null } {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false });
  const detail = String(result.stdout || result.stderr || result.error?.message || '').trim().slice(0, 1000);
  return { ok: !result.error && result.status === 0, detail, version: !result.error && result.status === 0 ? detail.split(/\r?\n/)[0]?.trim() ?? null : null };
}

function packageScripts(root: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) return {};
    return Object.fromEntries(Object.entries(parsed.scripts as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function skillsRoot(): string {
  return resolve(process.env.AI_COMPANY_SKILLS_ROOT || join(homedir(), '.codex', 'skills'));
}

function legacyStatus(view: CapabilityView): 'available' | 'unavailable' | 'degraded' {
  if (view.overallStatus === 'AVAILABLE') return 'available';
  if (view.overallStatus === 'UNVERIFIED' || view.overallStatus === 'AUTH_REQUIRED' || view.overallStatus === 'DISABLED' || view.overallStatus === 'UNAVAILABLE') return 'degraded';
  return 'unavailable';
}

function exactFiles(left: SkillFileEvidence[], right: SkillFileEvidence[]): boolean {
  const normalize = (files: SkillFileEvidence[]) => [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function recordFiles(value: unknown): SkillFileEvidence[] {
  if (!Array.isArray(value)) throw new CoreError('INVALID_INPUT', 'Operation file evidence is invalid');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new CoreError('INVALID_INPUT', `Operation file evidence ${index} is invalid`);
    const row = item as Record<string, unknown>;
    if (typeof row.relativePath !== 'string' || typeof row.sha256 !== 'string' || typeof row.size !== 'number') {
      throw new CoreError('INVALID_INPUT', `Operation file evidence ${index} is invalid`);
    }
    return { relativePath: row.relativePath, sha256: row.sha256, size: row.size };
  });
}

export class CapabilityManagerService {
  readonly store: CapabilityStore;
  private readonly codexProvider = new CodexAppServerProvider();

  constructor(readonly engine: CoreEngine) {
    this.store = new CapabilityStore(engine.database);
  }

  private syncLegacy(projectId: string, capabilityName: string): void {
    const capability = this.store.getByName(projectId, capabilityName);
    const view: CapabilityView = {
      ...capability,
      overallStatus: capabilityOverallStatus(capability),
      source: this.store.latestSource(capability.id),
      dependencies: this.store.listDependencies(capability.id),
    };
    this.engine.repository.setCapability(
      capability.name,
      legacyStatus(view),
      'capability-manager-v2',
      {
        projectId,
        type: capability.type,
        overallStatus: view.overallStatus,
        discoveryState: capability.discoveryState,
        installationState: capability.installationState,
        authState: capability.authState,
        costState: capability.costState,
        verificationState: capability.verificationState,
        runtimeState: capability.runtimeState,
      },
    );
  }

  private observe(input: CapabilityUpsert, source?: Parameters<CapabilityStore['addSource']>[1]): CapabilityView {
    const capability = this.store.upsert(input);
    if (source) this.store.addSource(capability.id, source);
    this.syncLegacy(input.projectId, input.name);
    const latest = this.store.get(capability.id);
    return {
      ...latest,
      overallStatus: capabilityOverallStatus(latest),
      source: this.store.latestSource(latest.id),
      dependencies: this.store.listDependencies(latest.id),
    };
  }

  async discover(projectId: string): Promise<CapabilitySnapshot> {
    const project = this.engine.repository.getProject(projectId);
    const checkedAt = now();

    const git = commandVersion('git');
    this.observe({
      projectId, name: 'Git', type: 'CLI',
      discoveryState: git.ok ? 'FOUND' : 'NOT_FOUND',
      installationState: git.ok ? 'INSTALLED' : 'NOT_INSTALLED',
      authState: 'NOT_REQUIRED', costState: 'FREE_LOCAL',
      verificationState: git.ok ? 'PASS' : 'FAIL', runtimeState: 'NOT_REQUIRED',
      version: git.version, details: { check: 'git --version', detail: git.detail }, lastCheckedAt: checkedAt,
    }, {
      trustState: 'UNKNOWN', sourceKind: 'EXECUTABLE', location: 'PATH:git', version: git.version,
      costState: 'FREE_LOCAL', installMethod: 'MANUAL', metadata: { discoveredBy: 'git --version' },
    });

    this.observe({
      projectId, name: 'Node', type: 'CLI',
      discoveryState: existsSync(process.execPath) ? 'FOUND' : 'NOT_FOUND',
      installationState: existsSync(process.execPath) ? 'INSTALLED' : 'NOT_INSTALLED',
      authState: 'NOT_REQUIRED', costState: 'FREE_LOCAL',
      verificationState: existsSync(process.execPath) ? 'PASS' : 'FAIL', runtimeState: 'NOT_REQUIRED',
      version: process.version, details: { executable: process.execPath }, lastCheckedAt: checkedAt,
    }, {
      trustState: 'UNKNOWN', sourceKind: 'EXECUTABLE', location: process.execPath, version: process.version,
      costState: 'FREE_LOCAL', installMethod: 'MANUAL', metadata: {},
    });

    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const npm = commandVersion(npmCommand);
    this.observe({
      projectId, name: 'npm', type: 'CLI',
      discoveryState: npm.ok ? 'FOUND' : 'NOT_FOUND',
      installationState: npm.ok ? 'INSTALLED' : 'NOT_INSTALLED',
      authState: 'NOT_REQUIRED', costState: 'FREE_LOCAL',
      verificationState: npm.ok ? 'PASS' : 'FAIL', runtimeState: 'NOT_REQUIRED',
      version: npm.version, details: { check: 'npm --version', detail: npm.detail }, lastCheckedAt: checkedAt,
    }, {
      trustState: 'UNKNOWN', sourceKind: 'EXECUTABLE', location: `PATH:${npmCommand}`, version: npm.version,
      costState: 'FREE_LOCAL', installMethod: 'MANUAL', metadata: {},
    });

    const scripts = packageScripts(project.rootPath);
    for (const [name, script, type] of [
      ['Build Runner', scripts.build, 'BUILD_RUNNER'],
      ['Test Runner', scripts.test, 'TEST_RUNNER'],
    ] as const) {
      const present = typeof script === 'string' && script.trim().length > 0;
      this.observe({
        projectId, name, type,
        discoveryState: present ? 'FOUND' : 'NOT_FOUND',
        installationState: present ? 'INSTALLED' : 'NOT_INSTALLED',
        authState: 'NOT_REQUIRED', costState: 'FREE_LOCAL',
        verificationState: present ? 'PASS' : 'NOT_RUN', runtimeState: 'NOT_REQUIRED',
        details: { script: present ? script : null, source: 'package.json' }, lastCheckedAt: checkedAt,
      }, {
        trustState: 'USER_APPROVED', sourceKind: 'BUILTIN', location: join(project.rootPath, 'package.json'),
        costState: 'FREE_LOCAL', installMethod: 'NONE', metadata: { scriptName: name === 'Build Runner' ? 'build' : 'test' },
      });
    }

    const codexPath = resolveCodexJsPath();
    if (!codexPath || !existsSync(codexPath)) {
      this.observe({
        projectId, name: 'Codex', type: 'CODEX',
        discoveryState: 'NOT_FOUND', installationState: 'NOT_INSTALLED', authState: 'UNKNOWN',
        costState: 'FREE_EXISTING_ACCOUNT', verificationState: 'NOT_RUN', runtimeState: 'NOT_CHECKED',
        details: { reason: 'Codex App Server installation was not found' }, lastCheckedAt: checkedAt,
      });
    } else {
      const availability = await this.codexProvider.checkAvailability(project.rootPath);
      const authRequired = availability.state === 'unavailable' && /auth|login|account|unauthor/i.test(availability.reason ?? '');
      this.observe({
        projectId, name: 'Codex', type: 'CODEX',
        discoveryState: 'FOUND', installationState: 'INSTALLED',
        authState: availability.state === 'available' || availability.state === 'rate_limited' ? 'AUTHENTICATED' : authRequired ? 'AUTH_REQUIRED' : 'UNKNOWN',
        costState: 'FREE_EXISTING_ACCOUNT',
        verificationState: availability.state === 'available' || availability.state === 'rate_limited' ? 'PASS' : 'FAIL',
        runtimeState: availability.state === 'available' || availability.state === 'rate_limited' ? 'VERIFIED' : 'FAILED',
        details: { path: codexPath, availability: availability.state, reason: availability.reason, rateLimit: availability.rateLimit },
        lastCheckedAt: checkedAt,
      }, {
        trustState: 'OFFICIAL', sourceKind: 'EXECUTABLE', location: codexPath,
        costState: 'FREE_EXISTING_ACCOUNT', installMethod: 'MANUAL', metadata: { provider: 'codex-app-server' },
      });
    }

    const skillRoot = skillsRoot();
    const skillResult = discoverSkills(skillRoot);
    const rootExists = existsSync(skillRoot);
    this.observe({
      projectId, name: 'Skills', type: 'SKILL',
      discoveryState: rootExists ? 'FOUND' : 'NOT_FOUND',
      installationState: rootExists ? 'INSTALLED' : 'NOT_INSTALLED',
      authState: 'NOT_REQUIRED', costState: 'FREE_LOCAL',
      verificationState: !rootExists ? 'NOT_RUN' : skillResult.errors.length ? 'FAIL' : 'PASS',
      runtimeState: rootExists ? 'NOT_CHECKED' : 'NOT_CHECKED',
      details: { root: skillRoot, validSkills: skillResult.inspections.length, invalidSkills: skillResult.errors },
      lastCheckedAt: checkedAt,
    }, rootExists ? {
      trustState: 'UNKNOWN', sourceKind: 'LOCAL_PATH', location: skillRoot,
      costState: 'FREE_LOCAL', installMethod: 'LOCAL_COPY', metadata: {},
    } : undefined);

    for (const inspection of skillResult.inspections) {
      this.observe({
        projectId, name: `Skill:${inspection.name}`, type: 'SKILL',
        discoveryState: 'FOUND', installationState: 'INSTALLED', authState: 'NOT_REQUIRED',
        costState: 'FREE_LOCAL', verificationState: 'PASS', runtimeState: 'NOT_CHECKED',
        version: null, sourceRef: inspection.rootPath,
        details: { description: inspection.description, fileCount: inspection.files.length, totalBytes: inspection.totalBytes, staticValidation: 'PASS', runtimeRecognition: 'NOT_CHECKED' },
        lastCheckedAt: checkedAt,
      }, {
        trustState: 'UNKNOWN', sourceKind: 'LOCAL_PATH', location: inspection.rootPath,
        costState: 'FREE_LOCAL', installMethod: 'LOCAL_COPY',
        metadata: { skillName: inspection.name, fileCount: inspection.files.length },
      });
    }

    for (const invalid of skillResult.errors) {
      this.observe({
        projectId, name: `Skill:${invalid.name}`, type: 'SKILL',
        discoveryState: 'FOUND', installationState: 'PARTIAL', authState: 'NOT_REQUIRED',
        costState: 'FREE_LOCAL', verificationState: 'FAIL', runtimeState: 'FAILED',
        details: { error: invalid.error }, lastCheckedAt: checkedAt,
      });
    }

    const mcp = discoverMcpDefinitions(project.rootPath);
    this.observe({
      projectId, name: 'MCP', type: 'MCP',
      discoveryState: mcp.definitions.length ? 'FOUND' : mcp.errors.length ? 'ERROR' : 'NOT_FOUND',
      installationState: mcp.definitions.length ? 'UNKNOWN' : 'NOT_INSTALLED',
      authState: mcp.definitions.some(item => item.authRequired) ? 'AUTH_REQUIRED' : 'UNKNOWN',
      costState: mcp.definitions.length && mcp.definitions.every(item => item.costState === 'FREE_LOCAL' || item.costState === 'FREE_EXISTING_ACCOUNT')
        ? 'FREE_LOCAL' : 'UNKNOWN_COST',
      verificationState: mcp.errors.length ? 'FAIL' : mcp.definitions.length ? 'PASS' : 'NOT_RUN',
      runtimeState: 'NOT_CHECKED',
      details: { definitions: mcp.definitions.map(item => item.name), errors: mcp.errors },
      lastCheckedAt: checkedAt,
    });

    for (const definition of mcp.definitions) {
      let structural: 'PASS' | 'FAIL' = 'PASS';
      let error: string | null = null;
      try { validateMcpDefinition(definition); } catch (caught) {
        structural = 'FAIL';
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const executable = safeExecutable(definition.command);
      const argsSensitive = hasSensitiveArgument(definition.args);
      const capability = this.observe({
        projectId, name: `MCP:${definition.name}`, type: 'MCP',
        discoveryState: 'FOUND',
        installationState: executable ? 'INSTALLED' : 'UNKNOWN',
        authState: definition.authRequired || argsSensitive ? 'AUTH_REQUIRED' : 'NOT_REQUIRED',
        costState: definition.costState,
        verificationState: structural === 'PASS' ? 'PASS' : 'FAIL',
        runtimeState: 'NOT_CHECKED',
        sourceRef: definition.configPath,
        details: { configPath: definition.configPath, protocolMode: definition.protocolMode, staticValidation: structural, error },
        lastCheckedAt: checkedAt,
      }, {
        trustState: definition.trustState,
        sourceKind: 'CONFIG',
        location: definition.configPath,
        costState: definition.costState,
        installMethod: 'MANUAL',
        metadata: {
          command: definition.command,
          args: argsSensitive ? [] : definition.args,
          argsRedacted: argsSensitive,
          envKeys: definition.envKeys,
          protocolMode: definition.protocolMode,
        },
      });
      this.store.replaceDependencies(capability.id, [{
        dependencyName: definition.command,
        status: executable ? 'AVAILABLE' : isAbsoluteSafe(definition.command) ? 'MISSING' : 'UNKNOWN',
        detail: executable ? executable : 'Only node or absolute executable paths are eligible for automatic MCP verification',
      }]);
    }

    return this.store.snapshot(projectId);
  }

  snapshot(projectId: string): CapabilitySnapshot {
    this.engine.repository.getProject(projectId);
    return this.store.snapshot(projectId);
  }

  dashboard(projectId: string): CapabilityView[] {
    this.engine.repository.getProject(projectId);
    const snapshot = this.store.snapshot(projectId);
    if (snapshot.capabilities.length) return snapshot.capabilities;
    const names: [string, CapabilityUpsert['type']][] = [
      ['Codex','CODEX'], ['Git','CLI'], ['Node','CLI'], ['npm','CLI'],
      ['Skills','SKILL'], ['MCP','MCP'], ['Build Runner','BUILD_RUNNER'], ['Test Runner','TEST_RUNNER'],
    ];
    return names.map(([name, type]) => {
      const capability: CapabilityUpsert = {
        projectId, name, type, discoveryState: 'NOT_CHECKED', installationState: 'UNKNOWN',
        authState: 'UNKNOWN', costState: name === 'Codex' ? 'FREE_EXISTING_ACCOUNT' : 'FREE_LOCAL',
        verificationState: 'NOT_RUN', runtimeState: 'NOT_CHECKED',
        details: { reason: 'Capability discovery has not been run for this project' }, lastCheckedAt: null,
      };
      return {
        id: `not-checked:${name}`, projectId, scopeKey: projectId, name, type,
        discoveryState: capability.discoveryState, installationState: capability.installationState,
        authState: capability.authState, costState: capability.costState,
        verificationState: capability.verificationState, runtimeState: capability.runtimeState,
        enablementState: 'ENABLED', approvalState: 'NOT_REQUIRED',
        version: null, sourceRef: null, details: capability.details ?? {}, lastCheckedAt: null,
        createdAt: '', updatedAt: '', overallStatus: 'UNVERIFIED', source: null, dependencies: [],
      };
    });
  }

  requestSkillInstall(projectId: string, sourcePath: string): CapabilityOperation {
    const project = this.engine.repository.getProject(projectId);
    const inspection = inspectSkill(resolve(sourcePath));
    const name = safeSkillName(inspection.name);
    const destinationRoot = skillsRoot();
    const destination = assertContained(destinationRoot, join(destinationRoot, name), 'Skill destination');
    if (existsSync(destination)) throw new CoreError('CONFLICT', 'Skill destination already exists; Phase 6 does not overwrite installed skills');

    const capability = this.store.upsert({
      projectId, name: `Skill:${name}`, type: 'SKILL',
      discoveryState: 'FOUND', installationState: 'NOT_INSTALLED', authState: 'NOT_REQUIRED',
      costState: 'FREE_LOCAL', verificationState: 'NOT_RUN', runtimeState: 'NOT_CHECKED',
      approvalState: 'REQUIRED', sourceRef: inspection.rootPath,
      details: { description: inspection.description, requestedInstall: true }, lastCheckedAt: now(),
    });
    this.store.addSource(capability.id, {
      trustState: 'UNKNOWN', sourceKind: 'LOCAL_PATH', location: inspection.rootPath,
      costState: 'FREE_LOCAL', installMethod: 'LOCAL_COPY',
      metadata: { skillName: name, fileCount: inspection.files.length, totalBytes: inspection.totalBytes },
    });
    this.store.addCheck(capability.id, 'skill_source_static_validation', 'PASS', 'Source SKILL.md and file tree passed static validation', {
      fileCount: inspection.files.length, totalBytes: inspection.totalBytes,
    });
    const checkpoint = this.engine.checkpoint(project.id, `Before Capability install: Skill:${name}`);
    const approval = this.engine.repository.requestApproval(project.id, `capability.install:${capability.id}:${name}`);
    const operation = this.store.createOperation({
      capabilityId: capability.id, projectId, kind: 'INSTALL', status: 'APPROVAL_PENDING',
      approvalId: approval.id, checkpointId: checkpoint.id,
      preview: {
        sourcePath: inspection.rootPath,
        destinationRoot,
        destination,
        files: inspection.files,
        totalBytes: inspection.totalBytes,
        requiresNetwork: false,
        requiresAdmin: false,
        command: null,
        risk: 'MEDIUM',
        rollback: 'Remove only the newly created destination when every installed file hash is unchanged',
        verification: 'Static SKILL.md validation plus installed file hash verification; Codex runtime recognition remains NOT_CHECKED',
      },
      snapshot: { sourceFiles: inspection.files },
    });
    this.store.patch(capability.id, { approvalState: 'PENDING' });
    this.syncLegacy(projectId, capability.name);
    return operation;
  }

  executeInstall(operationId: string): CapabilityOperation {
    let operation = this.store.getOperation(operationId);
    if (operation.kind !== 'INSTALL') throw new CoreError('INVALID_INPUT', 'Operation is not an install');
    if (operation.status !== 'APPROVAL_PENDING' && operation.status !== 'APPROVED') throw new CoreError('INVALID_TRANSITION', 'Install operation is not awaiting execution');
    const approval = this.engine.repository.listApprovals(operation.projectId).find(item => item.id === operation.approvalId);
    if (!approval) throw new CoreError('NOT_FOUND', 'Install approval not found');
    if (approval.status === 'rejected') {
      this.store.patch(operation.capabilityId, { approvalState: 'REJECTED' });
      return this.store.updateOperation(operation.id, 'REJECTED', { error: 'User rejected installation' });
    }
    if (approval.status !== 'approved') throw new CoreError('CONFLICT', 'Install approval is still pending');

    const capability = this.store.get(operation.capabilityId);
    if (capability.costState !== 'FREE_LOCAL' && capability.costState !== 'FREE_EXISTING_ACCOUNT') throw new CoreError('CONFLICT', 'ZERO-COST gate blocks installation');
    const source = this.store.latestSource(capability.id);
    if (!source || source.installMethod !== 'LOCAL_COPY') throw new CoreError('CONFLICT', 'Only reviewed LOCAL_COPY installation is supported');

    const sourcePath = stringField(operation.preview.sourcePath, 'sourcePath');
    const destinationRoot = stringField(operation.preview.destinationRoot, 'destinationRoot');
    const destination = stringField(operation.preview.destination, 'destination');
    if (resolve(destinationRoot) !== skillsRoot()) throw new CoreError('CONFLICT', 'Skills root changed after approval');
    assertContained(destinationRoot, destination, 'Skill destination');
    if (existsSync(destination)) throw new CoreError('CONFLICT', 'Skill destination appeared after approval');

    const expectedFiles = recordFiles(operation.preview.files);
    const inspection = inspectSkill(sourcePath);
    if (!exactFiles(expectedFiles, inspection.files)) throw new CoreError('CONFLICT', 'Skill source changed after approval');

    operation = this.store.updateOperation(operation.id, 'RUNNING');
    this.store.patch(capability.id, { approvalState: 'APPROVED' });
    this.store.setLatestSourceTrust(capability.id, 'USER_APPROVED');

    mkdirSync(destinationRoot, { recursive: true });
    const temp = assertContained(destinationRoot, join(destinationRoot, `.ai-company-install-${operation.id}`), 'Temporary skill destination');
    if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
    mkdirSync(temp, { recursive: false });
    try {
      for (const file of inspection.files) {
        const sourceFile = assertContained(inspection.rootPath, join(inspection.rootPath, file.relativePath), 'Skill source file');
        const targetFile = assertContained(temp, join(temp, file.relativePath), 'Skill target file');
        mkdirSync(dirname(targetFile), { recursive: true });
        writeFileSync(targetFile, readFileSync(sourceFile), { flag: 'wx' });
      }
      renameSync(temp, destination);
      const installed = inspectSkill(destination);
      if (installed.name !== inspection.name || !exactFiles(inspection.files, installed.files)) {
        throw new CoreError('CONFLICT', 'Installed Skill verification did not match approved source');
      }
      for (const file of installed.files) {
        this.store.addChange(operation.id, {
          path: join(destination, file.relativePath), changeType: 'CREATE',
          beforeSha256: null, afterSha256: file.sha256, backupPath: null,
        });
      }
      this.store.addCheck(capability.id, 'skill_install_verification', 'PASS', 'Installed Skill files match approved source hashes', {
        destination, fileCount: installed.files.length, runtimeRecognition: 'NOT_CHECKED',
      });
      this.store.patch(capability.id, {
        discoveryState: 'FOUND', installationState: 'INSTALLED', verificationState: 'PASS',
        runtimeState: 'NOT_CHECKED', approvalState: 'APPROVED', sourceRef: destination,
        details: { ...capability.details, installedPath: destination, staticValidation: 'PASS', runtimeRecognition: 'NOT_CHECKED' },
        lastCheckedAt: now(),
      });
      operation = this.store.updateOperation(operation.id, 'COMPLETED', {
        snapshot: { destination, installedFiles: installed.files },
      });
      this.syncLegacy(operation.projectId, capability.name);
      return operation;
    } catch (error) {
      if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
      if (existsSync(destination)) {
        try {
          const installed = inspectSkill(destination);
          if (exactFiles(inspection.files, installed.files)) rmSync(destination, { recursive: true, force: true });
        } catch {}
      }
      this.store.patch(capability.id, { verificationState: 'ERROR', runtimeState: 'ERROR' });
      this.store.addCheck(capability.id, 'skill_install_verification', 'ERROR', error instanceof Error ? error.message : String(error));
      this.syncLegacy(operation.projectId, capability.name);
      return this.store.updateOperation(operation.id, 'FAILED', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  rollbackInstall(operationId: string): CapabilityOperation {
    const operation = this.store.getOperation(operationId);
    if (operation.kind !== 'INSTALL' || operation.status !== 'COMPLETED') throw new CoreError('INVALID_TRANSITION', 'Only completed Skill installs can be rolled back');
    const destination = stringField(operation.snapshot.destination, 'destination');
    const expected = recordFiles(operation.snapshot.installedFiles);
    const root = skillsRoot();
    assertContained(root, destination, 'Skill rollback destination');
    if (!existsSync(destination)) throw new CoreError('CONFLICT', 'Installed Skill destination is already missing');
    const current = inspectSkill(destination);
    if (!exactFiles(expected, current.files)) throw new CoreError('CONFLICT', 'Installed Skill changed after installation; automatic rollback refuses user edits');
    rmSync(destination, { recursive: true, force: false });
    const capability = this.store.patch(operation.capabilityId, {
      discoveryState: 'NOT_FOUND', installationState: 'NOT_INSTALLED', verificationState: 'NOT_RUN',
      runtimeState: 'NOT_CHECKED', approvalState: 'NOT_REQUIRED', sourceRef: null,
      details: { rollback: 'PASS', previousDestination: destination }, lastCheckedAt: now(),
    });
    this.store.addCheck(capability.id, 'skill_install_rollback', 'PASS', 'Created Skill directory removed after hash verification', { destination });
    this.syncLegacy(operation.projectId, capability.name);
    return this.store.updateOperation(operation.id, 'ROLLED_BACK', { error: null });
  }

  requestMcpVerification(projectId: string, capabilityId: string): CapabilityOperation {
    const project = this.engine.repository.getProject(projectId);
    const capability = this.store.get(capabilityId);
    if (capability.projectId !== projectId || capability.type !== 'MCP') throw new CoreError('INVALID_INPUT', 'Capability is not an MCP capability in this project');
    if (capability.costState !== 'FREE_LOCAL' && capability.costState !== 'FREE_EXISTING_ACCOUNT') throw new CoreError('CONFLICT', 'ZERO-COST gate blocks MCP execution');
    if (capability.authState === 'AUTH_REQUIRED') throw new CoreError('CONFLICT', 'MCP credentials are required; Phase 6 does not forward secrets');
    const source = this.store.latestSource(capability.id);
    if (!source || !['OFFICIAL','VERIFIED_REPOSITORY','USER_APPROVED'].includes(source.trustState)) {
      throw new CoreError('CONFLICT', 'MCP source is not trusted enough for automatic execution');
    }
    const definition = sourceDefinition(capability.name, source.location, source.metadata, capability.costState, source.trustState);
    validateMcpDefinition(definition);
    if (!safeExecutable(definition.command)) throw new CoreError('CONFLICT', 'MCP executable is not eligible for automatic verification');
    const checkpoint = this.engine.checkpoint(project.id, `Before MCP verification: ${capability.name}`);
    const approval = this.engine.repository.requestApproval(project.id, `capability.verify_mcp:${capability.id}`);
    const operation = this.store.createOperation({
      capabilityId: capability.id, projectId, kind: 'VERIFY_MCP', status: 'APPROVAL_PENDING',
      approvalId: approval.id, checkpointId: checkpoint.id,
      preview: {
        command: definition.command, args: definition.args, protocolMode: definition.protocolMode,
        configPath: definition.configPath, requiresNetwork: false, forwardsSecrets: false,
        risk: 'HIGH', timeoutMs: 4000,
      },
      snapshot: {},
    });
    this.store.patch(capability.id, { approvalState: 'PENDING' });
    this.syncLegacy(projectId, capability.name);
    return operation;
  }

  async executeMcpVerification(operationId: string): Promise<CapabilityOperation> {
    let operation = this.store.getOperation(operationId);
    if (operation.kind !== 'VERIFY_MCP') throw new CoreError('INVALID_INPUT', 'Operation is not MCP verification');
    if (operation.status !== 'APPROVAL_PENDING' && operation.status !== 'APPROVED') throw new CoreError('INVALID_TRANSITION', 'MCP verification operation is not executable');
    const approval = this.engine.repository.listApprovals(operation.projectId).find(item => item.id === operation.approvalId);
    if (!approval) throw new CoreError('NOT_FOUND', 'MCP verification approval not found');
    if (approval.status === 'rejected') {
      this.store.patch(operation.capabilityId, { approvalState: 'REJECTED' });
      return this.store.updateOperation(operation.id, 'REJECTED', { error: 'User rejected MCP verification' });
    }
    if (approval.status !== 'approved') throw new CoreError('CONFLICT', 'MCP verification approval is still pending');

    const capability = this.store.get(operation.capabilityId);
    const source = this.store.latestSource(capability.id);
    if (!source || !['OFFICIAL','VERIFIED_REPOSITORY','USER_APPROVED'].includes(source.trustState)) throw new CoreError('CONFLICT', 'MCP source trust changed');
    if (capability.costState !== 'FREE_LOCAL' && capability.costState !== 'FREE_EXISTING_ACCOUNT') throw new CoreError('CONFLICT', 'ZERO-COST gate blocks MCP verification');
    const definition = sourceDefinition(capability.name, source.location, source.metadata, capability.costState, source.trustState);
    operation = this.store.updateOperation(operation.id, 'RUNNING');
    this.store.patch(capability.id, { approvalState: 'APPROVED' });
    const result = await probeMcp(definition);
    this.store.addCheck(capability.id, 'mcp_protocol_probe', result.ok ? 'PASS' : 'FAIL', result.detail, {
      era: result.era, serverInfo: result.serverInfo,
    });
    this.store.patch(capability.id, {
      verificationState: result.ok ? 'PASS' : 'FAIL',
      runtimeState: result.ok ? 'VERIFIED' : 'FAILED',
      authState: result.ok ? 'NOT_REQUIRED' : capability.authState,
      lastCheckedAt: now(),
      details: { ...capability.details, protocolProbe: result },
    });
    this.syncLegacy(operation.projectId, capability.name);
    return this.store.updateOperation(operation.id, result.ok ? 'COMPLETED' : 'FAILED', {
      error: result.ok ? null : result.detail,
      snapshot: { probe: result },
    });
  }

  setEnabled(projectId: string, capabilityId: string, enabled: boolean): CapabilityView {
    const capability = this.store.get(capabilityId);
    if (capability.projectId !== projectId) throw new CoreError('NOT_FOUND', 'Capability not in project');
    if (enabled && (capability.costState === 'PAID' || capability.costState === 'USAGE_BASED_PAID' || capability.costState === 'UNKNOWN_COST')) {
      throw new CoreError('CONFLICT', 'ZERO-COST gate blocks enabling this capability');
    }
    const next = this.store.patch(capabilityId, { enablementState: enabled ? 'ENABLED' : 'DISABLED' });
    this.store.createOperation({
      capabilityId, projectId, kind: enabled ? 'ENABLE' : 'DISABLE', status: 'COMPLETED',
      preview: { managerStateOnly: true }, snapshot: {},
    });
    this.syncLegacy(projectId, next.name);
    return {
      ...next, overallStatus: capabilityOverallStatus(next),
      source: this.store.latestSource(next.id), dependencies: this.store.listDependencies(next.id),
    };
  }
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new CoreError('INVALID_INPUT', `${label} is missing`);
  return value;
}

function isAbsoluteSafe(command: string): boolean {
  return command.startsWith('/') || /^[A-Za-z]:[\\/]/.test(command);
}

function sourceDefinition(
  capabilityName: string,
  configPath: string,
  metadata: Record<string, unknown>,
  costState: CostState,
  trustState: McpDefinition['trustState'],
): McpDefinition {
  const command = stringField(metadata.command, 'MCP command');
  const rawArgs = metadata.args;
  if (!Array.isArray(rawArgs) || rawArgs.some(item => typeof item !== 'string')) throw new CoreError('INVALID_INPUT', 'MCP source arguments are invalid');
  const mode = metadata.protocolMode;
  const protocolMode: McpDefinition['protocolMode'] = mode === 'modern' || mode === 'legacy' || mode === 'auto' ? mode : 'auto';
  const envKeys = Array.isArray(metadata.envKeys) ? metadata.envKeys.filter((item): item is string => typeof item === 'string') : [];
  return {
    name: capabilityName.replace(/^MCP:/, ''),
    command,
    args: rawArgs as string[],
    configPath,
    protocolMode,
    trustState,
    costState,
    authRequired: envKeys.length > 0 || hasSensitiveArgument(rawArgs as string[]),
    envKeys,
  };
}
