
import assert from 'node:assert/strict';
import {
  appendFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/core/database.js';
import { CoreEngine } from '../src/core/engine.js';
import { CoreError } from '../src/core/domain.js';
import { migrate, schemaVersion } from '../src/core/migrations.js';
import { CapabilityManagerService } from '../src/capabilities/service.js';
import { inspectSkill } from '../src/capabilities/skill.js';
import { capabilityOverallStatus, type ManagedCapability } from '../src/capabilities/types.js';
import { DashboardService } from '../src/dashboard/service.js';
import { createApp } from '../src/server/app.js';
import { committedFixture } from './helpers.js';

function setup() {
  const work = committedFixture();
  const previousSkills = process.env.AI_COMPANY_SKILLS_ROOT;
  const previousMcp = process.env.AI_COMPANY_MCP_CONFIG;
  const skillsRoot = join(work.path, '.ai-company', 'skills');
  process.env.AI_COMPANY_SKILLS_ROOT = skillsRoot;
  delete process.env.AI_COMPANY_MCP_CONFIG;
  const dbPath = join(work.path, 'state.sqlite');
  const engine = new CoreEngine(dbPath);
  const project = engine.createProject('Phase 6', work.path);
  const manager = new CapabilityManagerService(engine);
  return {
    work, dbPath, engine, project, manager, skillsRoot,
    clean() {
      engine.close();
      if (previousSkills === undefined) delete process.env.AI_COMPANY_SKILLS_ROOT;
      else process.env.AI_COMPANY_SKILLS_ROOT = previousSkills;
      if (previousMcp === undefined) delete process.env.AI_COMPANY_MCP_CONFIG;
      else process.env.AI_COMPANY_MCP_CONFIG = previousMcp;
      work.clean();
    },
  };
}

function baseCapability(overrides: Partial<ManagedCapability> = {}): ManagedCapability {
  return {
    id: 'cap', projectId: 'project', scopeKey: 'project', name: 'Example', type: 'CLI',
    discoveryState: 'FOUND', installationState: 'INSTALLED', authState: 'NOT_REQUIRED',
    costState: 'FREE_LOCAL', verificationState: 'PASS', runtimeState: 'NOT_REQUIRED',
    enablementState: 'ENABLED', approvalState: 'NOT_REQUIRED', version: '1',
    sourceRef: null, details: {}, lastCheckedAt: '2026-09-24T00:00:00.000Z',
    createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

function createSkill(root: string, name = 'sample-skill', description = 'A test skill'): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\n# ' + name + '\n');
  writeFileSync(join(dir, 'guide.txt'), 'safe content\n');
  return dir;
}

function sourceRoot(ctx: ReturnType<typeof setup>): string {
  const root = join(ctx.work.path, '.ai-company', 'sources');
  mkdirSync(root, { recursive: true });
  return root;
}

function writeMcpConfig(ctx: ReturnType<typeof setup>, servers: Record<string, unknown>): string {
  const dir = join(ctx.work.path, '.ai-company');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'mcp.json');
  writeFileSync(path, JSON.stringify({ servers }, null, 2));
  return path;
}

function writeMcpServer(ctx: ReturnType<typeof setup>, name: string, mode: 'legacy' | 'modern' | 'fail'): string {
  const dir = join(ctx.work.path, '.ai-company');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name + '.mjs');
  let behavior: string;
  if (mode === 'fail') {
    behavior = 'process.exit(2);\n';
  } else if (mode === 'legacy') {
    behavior = [
      "process.stdin.setEncoding('utf8');",
      "let buffer = '';",
      "process.stdin.on('data', chunk => {",
      "  buffer += chunk;",
      "  const lines = buffer.split(/\\r?\\n/);",
      "  buffer = lines.pop() || '';",
      "  for (const line of lines) {",
      "    if (!line.trim()) continue;",
      "    const message = JSON.parse(line);",
      "    if (message.method === 'initialize') {",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture', version: '1.0.0' } } }) + '\\n');",
      "    }",
      "  }",
      "});",
      "",
    ].join('\n');
  } else {
    behavior = [
      "process.stdin.setEncoding('utf8');",
      "let buffer = '';",
      "process.stdin.on('data', chunk => {",
      "  buffer += chunk;",
      "  const lines = buffer.split(/\\r?\\n/);",
      "  buffer = lines.pop() || '';",
      "  for (const line of lines) {",
      "    if (!line.trim()) continue;",
      "    const message = JSON.parse(line);",
      "    if (message.method === 'server/discover') {",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersions: ['2026-07-28'], capabilities: {}, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture-modern', version: '1.0.0' } } } }) + '\\n');",
      "    }",
      "  }",
      "});",
      "",
    ].join('\n');
  }
  writeFileSync(path, behavior);
  return path;
}

function approve(ctx: ReturnType<typeof setup>, approvalId: string | null): void {
  assert.ok(approvalId);
  ctx.engine.repository.resolveApproval(approvalId, 'approved');
}

test('1. schema v7 includes Phase 6 capability state', () => {
  const ctx = setup();
  try { assert.equal(schemaVersion(ctx.engine.database.db), 7); }
  finally { ctx.clean(); }
});

test('2. AVAILABLE requires verified free installed capability', () => {
  assert.equal(capabilityOverallStatus(baseCapability()), 'AVAILABLE');
});

test('3. UNKNOWN_COST is blocked', () => {
  assert.equal(capabilityOverallStatus(baseCapability({ costState: 'UNKNOWN_COST' })), 'BLOCKED_BY_COST');
});

test('4. PAID and usage-based paid are blocked', () => {
  assert.equal(capabilityOverallStatus(baseCapability({ costState: 'PAID' })), 'BLOCKED_BY_COST');
  assert.equal(capabilityOverallStatus(baseCapability({ costState: 'USAGE_BASED_PAID' })), 'BLOCKED_BY_COST');
});

test('5. authentication requirement is explicit', () => {
  assert.equal(capabilityOverallStatus(baseCapability({ authState: 'AUTH_REQUIRED' })), 'AUTH_REQUIRED');
});

test('6. missing discovery wins over unknown cost', () => {
  assert.equal(capabilityOverallStatus(baseCapability({ discoveryState: 'NOT_FOUND', costState: 'UNKNOWN_COST' })), 'MISSING_DEPENDENCY');
});

test('7. runtime NOT_CHECKED remains UNVERIFIED', () => {
  assert.equal(capabilityOverallStatus(baseCapability({ runtimeState: 'NOT_CHECKED' })), 'UNVERIFIED');
});

test('8. dashboard before discovery reports UNVERIFIED instead of fake AVAILABLE', () => {
  const ctx = setup();
  try {
    const rows = ctx.manager.dashboard(ctx.project.id);
    assert.equal(rows.find(row => row.name === 'Skills')?.overallStatus, 'UNVERIFIED');
    assert.equal(rows.find(row => row.name === 'MCP')?.overallStatus, 'UNVERIFIED');
  } finally { ctx.clean(); }
});

test('9. actual discovery verifies Git and Node', async () => {
  const ctx = setup();
  try {
    const snapshot = await ctx.manager.discover(ctx.project.id);
    assert.equal(snapshot.capabilities.find(row => row.name === 'Git')?.overallStatus, 'AVAILABLE');
    assert.equal(snapshot.capabilities.find(row => row.name === 'Node')?.overallStatus, 'AVAILABLE');
  } finally { ctx.clean(); }
});

test('10. missing project build script is explicit', async () => {
  const ctx = setup();
  try {
    const snapshot = await ctx.manager.discover(ctx.project.id);
    assert.equal(snapshot.capabilities.find(row => row.name === 'Build Runner')?.overallStatus, 'MISSING_DEPENDENCY');
  } finally { ctx.clean(); }
});

test('11. valid Skill is static PASS but runtime remains NOT_CHECKED', async () => {
  const ctx = setup();
  try {
    createSkill(ctx.skillsRoot, 'valid-skill');
    const snapshot = await ctx.manager.discover(ctx.project.id);
    const skill = snapshot.capabilities.find(row => row.name === 'Skill:valid-skill');
    assert.equal(skill?.verificationState, 'PASS');
    assert.equal(skill?.runtimeState, 'NOT_CHECKED');
    assert.equal(skill?.overallStatus, 'UNVERIFIED');
  } finally { ctx.clean(); }
});

test('12. malformed Skill frontmatter fails validation', async () => {
  const ctx = setup();
  try {
    const dir = join(ctx.skillsRoot, 'bad-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# missing frontmatter\n');
    const snapshot = await ctx.manager.discover(ctx.project.id);
    const skill = snapshot.capabilities.find(row => row.name === 'Skill:bad-skill');
    assert.equal(skill?.verificationState, 'FAIL');
    assert.equal(skill?.overallStatus, 'ERROR');
  } finally { ctx.clean(); }
});

test('13. traversal-like Skill name is rejected', () => {
  const ctx = setup();
  try {
    const dir = join(sourceRoot(ctx), 'evil-source');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: ../evil\ndescription: invalid\n---\n');
    assert.throws(() => inspectSkill(dir), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
  } finally { ctx.clean(); }
});

test('14. Skill tree containing symlink or junction is rejected', () => {
  const ctx = setup();
  try {
    const dir = createSkill(sourceRoot(ctx), 'linked-skill');
    const target = join(dir, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'file.txt'), 'target');
    const link = join(dir, 'alias');
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => inspectSkill(dir), (error: unknown) => error instanceof CoreError && error.code === 'INVALID_INPUT');
  } finally { ctx.clean(); }
});

test('15. duplicate capability observation updates one row', () => {
  const ctx = setup();
  try {
    ctx.manager.store.upsert({
      projectId: ctx.project.id, name: 'Duplicate', type: 'CLI', discoveryState: 'FOUND',
      installationState: 'INSTALLED', authState: 'NOT_REQUIRED', costState: 'FREE_LOCAL',
      verificationState: 'PASS', runtimeState: 'NOT_REQUIRED', version: '1',
    });
    ctx.manager.store.upsert({
      projectId: ctx.project.id, name: 'Duplicate', type: 'CLI', discoveryState: 'FOUND',
      installationState: 'INSTALLED', authState: 'NOT_REQUIRED', costState: 'FREE_LOCAL',
      verificationState: 'PASS', runtimeState: 'NOT_REQUIRED', version: '2',
    });
    assert.equal(ctx.manager.store.list(ctx.project.id).filter(row => row.name === 'Duplicate').length, 1);
    assert.equal(ctx.manager.store.getByName(ctx.project.id, 'Duplicate').version, '2');
  } finally { ctx.clean(); }
});

test('16. capability registry survives restart', async () => {
  const work = committedFixture();
  const previous = process.env.AI_COMPANY_SKILLS_ROOT;
  const root = join(work.path, '.ai-company', 'skills');
  process.env.AI_COMPANY_SKILLS_ROOT = root;
  const dbPath = join(work.path, 'state.sqlite');
  try {
    let engine = new CoreEngine(dbPath);
    const project = engine.createProject('Restart', work.path);
    await new CapabilityManagerService(engine).discover(project.id);
    engine.close();
    engine = new CoreEngine(dbPath);
    assert.ok(new CapabilityManagerService(engine).snapshot(project.id).capabilities.some(row => row.name === 'Node'));
    engine.close();
  } finally {
    if (previous === undefined) delete process.env.AI_COMPANY_SKILLS_ROOT;
    else process.env.AI_COMPANY_SKILLS_ROOT = previous;
    work.clean();
  }
});

test('17. v2 discovery maintains legacy compatibility row', async () => {
  const ctx = setup();
  try {
    await ctx.manager.discover(ctx.project.id);
    const legacy = ctx.engine.repository.getCapability('Node');
    assert.equal(legacy.status, 'available');
    assert.equal(legacy.source, 'capability-manager-v2');
  } finally { ctx.clean(); }
});

test('18. stale Skill is marked NOT_FOUND on next discovery', async () => {
  const ctx = setup();
  try {
    const dir = createSkill(ctx.skillsRoot, 'stale-skill');
    await ctx.manager.discover(ctx.project.id);
    rmSync(dir, { recursive: true, force: true });
    await ctx.manager.discover(ctx.project.id);
    assert.equal(ctx.manager.store.getByName(ctx.project.id, 'Skill:stale-skill').discoveryState, 'NOT_FOUND');
  } finally { ctx.clean(); }
});

test('19. Skill install request creates Approval and Checkpoint without installing', () => {
  const ctx = setup();
  try {
    const source = createSkill(sourceRoot(ctx), 'install-me');
    const operation = ctx.manager.requestSkillInstall(ctx.project.id, source);
    assert.equal(operation.status, 'APPROVAL_PENDING');
    assert.ok(operation.approvalId);
    assert.ok(operation.checkpointId);
    assert.equal(existsSync(join(ctx.skillsRoot, 'install-me')), false);
    assert.equal(ctx.engine.repository.listApprovals(ctx.project.id).at(-1)?.status, 'pending');
  } finally { ctx.clean(); }
});

test('20. Skill install preview has no shell network or admin action', () => {
  const ctx = setup();
  try {
    const operation = ctx.manager.requestSkillInstall(ctx.project.id, createSkill(sourceRoot(ctx), 'preview-skill'));
    assert.equal(operation.preview.command, null);
    assert.equal(operation.preview.requiresNetwork, false);
    assert.equal(operation.preview.requiresAdmin, false);
  } finally { ctx.clean(); }
});

test('21. pending Approval blocks Skill installation', () => {
  const ctx = setup();
  try {
    const operation = ctx.manager.requestSkillInstall(ctx.project.id, createSkill(sourceRoot(ctx), 'pending-skill'));
    assert.throws(() => ctx.manager.executeInstall(operation.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
    assert.equal(existsSync(join(ctx.skillsRoot, 'pending-skill')), false);
  } finally { ctx.clean(); }
});

test('22. rejected Approval rejects Skill operation', () => {
  const ctx = setup();
  try {
    const operation = ctx.manager.requestSkillInstall(ctx.project.id, createSkill(sourceRoot(ctx), 'rejected-skill'));
    assert.ok(operation.approvalId);
    ctx.engine.repository.resolveApproval(operation.approvalId, 'rejected');
    const result = ctx.manager.executeInstall(operation.id);
    assert.equal(result.status, 'REJECTED');
    assert.equal(ctx.manager.store.get(operation.capabilityId).approvalState, 'REJECTED');
  } finally { ctx.clean(); }
});

test('23. approved local Skill install verifies hashes but stays runtime UNVERIFIED', () => {
  const ctx = setup();
  try {
    const operation = ctx.manager.requestSkillInstall(ctx.project.id, createSkill(sourceRoot(ctx), 'approved-skill'));
    approve(ctx, operation.approvalId);
    const result = ctx.manager.executeInstall(operation.id);
    assert.equal(result.status, 'COMPLETED');
    assert.equal(existsSync(join(ctx.skillsRoot, 'approved-skill', 'SKILL.md')), true);
    const capability = ctx.manager.store.get(operation.capabilityId);
    assert.equal(capability.installationState, 'INSTALLED');
    assert.equal(capability.verificationState, 'PASS');
    assert.equal(capability.runtimeState, 'NOT_CHECKED');
    assert.equal(capabilityOverallStatus(capability), 'UNVERIFIED');
  } finally { ctx.clean(); }
});

test('24. source mutation after Approval blocks install before destination mutation', () => {
  const ctx = setup();
  try {
    const source = createSkill(sourceRoot(ctx), 'mutable-skill');
    const operation = ctx.manager.requestSkillInstall(ctx.project.id, source);
    approve(ctx, operation.approvalId);
    writeFileSync(join(source, 'after-approval.txt'), 'changed');
    assert.throws(() => ctx.manager.executeInstall(operation.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
    assert.equal(existsSync(join(ctx.skillsRoot, 'mutable-skill')), false);
  } finally { ctx.clean(); }
});

test('25. destination appearing after Approval blocks overwrite', () => {
  const ctx = setup();
  try {
    const operation = ctx.manager.requestSkillInstall(ctx.project.id, createSkill(sourceRoot(ctx), 'race-skill'));
    approve(ctx, operation.approvalId);
    mkdirSync(join(ctx.skillsRoot, 'race-skill'), { recursive: true });
    assert.throws(() => ctx.manager.executeInstall(operation.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { ctx.clean(); }
});

test('26. existing Skill destination is never overwritten', () => {
  const ctx = setup();
  try {
    createSkill(ctx.skillsRoot, 'existing-skill');
    const source = createSkill(sourceRoot(ctx), 'existing-skill');
    assert.throws(() => ctx.manager.requestSkillInstall(ctx.project.id, source), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { ctx.clean(); }
});

test('27. rollback removes unchanged created Skill', () => {
  const ctx = setup();
  try {
    const operation = ctx.manager.requestSkillInstall(ctx.project.id, createSkill(sourceRoot(ctx), 'rollback-skill'));
    approve(ctx, operation.approvalId);
    ctx.manager.executeInstall(operation.id);
    const rolled = ctx.manager.rollbackInstall(operation.id);
    assert.equal(rolled.status, 'ROLLED_BACK');
    assert.equal(existsSync(join(ctx.skillsRoot, 'rollback-skill')), false);
  } finally { ctx.clean(); }
});

test('28. rollback refuses user edits', () => {
  const ctx = setup();
  try {
    const operation = ctx.manager.requestSkillInstall(ctx.project.id, createSkill(sourceRoot(ctx), 'edited-skill'));
    approve(ctx, operation.approvalId);
    ctx.manager.executeInstall(operation.id);
    appendFileSync(join(ctx.skillsRoot, 'edited-skill', 'guide.txt'), 'user edit\n');
    assert.throws(() => ctx.manager.rollbackInstall(operation.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
    assert.equal(existsSync(join(ctx.skillsRoot, 'edited-skill')), true);
  } finally { ctx.clean(); }
});

test('29. unknown MCP cost is blocked and cannot request execution', async () => {
  const ctx = setup();
  try {
    const server = writeMcpServer(ctx, 'unknown-cost-server', 'legacy');
    writeMcpConfig(ctx, { unknown: { command: 'node', args: [server], trust: 'USER_APPROVED', protocolMode: 'legacy' } });
    await ctx.manager.discover(ctx.project.id);
    const capability = ctx.manager.store.getByName(ctx.project.id, 'MCP:unknown');
    assert.equal(capabilityOverallStatus(capability), 'BLOCKED_BY_COST');
    assert.throws(() => ctx.manager.requestMcpVerification(ctx.project.id, capability.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { ctx.clean(); }
});

test('30. explicit paid MCP remains blocked', async () => {
  const ctx = setup();
  try {
    const server = writeMcpServer(ctx, 'paid-server', 'legacy');
    writeMcpConfig(ctx, { paid: { command: 'node', args: [server], trust: 'USER_APPROVED', cost: 'PAID', protocolMode: 'legacy' } });
    await ctx.manager.discover(ctx.project.id);
    const capability = ctx.manager.store.getByName(ctx.project.id, 'MCP:paid');
    assert.equal(capability.costState, 'PAID');
    assert.equal(capabilityOverallStatus(capability), 'BLOCKED_BY_COST');
  } finally { ctx.clean(); }
});

test('31. MCP env credentials are detected without persisting secret values', async () => {
  const ctx = setup();
  try {
    const server = writeMcpServer(ctx, 'auth-server', 'legacy');
    writeMcpConfig(ctx, { auth: {
      command: 'node', args: [server], trust: 'USER_APPROVED', cost: 'FREE_LOCAL',
      protocolMode: 'legacy', env: { API_TOKEN: 'do-not-store-this-secret-value' },
    } });
    await ctx.manager.discover(ctx.project.id);
    const capability = ctx.manager.store.getByName(ctx.project.id, 'MCP:auth');
    const source = ctx.manager.store.latestSource(capability.id);
    assert.equal(capability.authState, 'AUTH_REQUIRED');
    assert.ok(source);
    assert.deepEqual(source.metadata.envKeys, ['API_TOKEN']);
    assert.doesNotMatch(JSON.stringify(source.metadata), /do-not-store-this-secret-value/);
    assert.throws(() => ctx.manager.requestMcpVerification(ctx.project.id, capability.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { ctx.clean(); }
});

test('32. credential-like MCP args are redacted from stored metadata', async () => {
  const ctx = setup();
  try {
    const server = writeMcpServer(ctx, 'arg-secret-server', 'legacy');
    writeMcpConfig(ctx, { secretarg: {
      command: 'node', args: [server, '--api-key', 'this-is-a-very-secret-token-value-1234567890'],
      trust: 'USER_APPROVED', cost: 'FREE_LOCAL', protocolMode: 'legacy',
    } });
    await ctx.manager.discover(ctx.project.id);
    const capability = ctx.manager.store.getByName(ctx.project.id, 'MCP:secretarg');
    const source = ctx.manager.store.latestSource(capability.id);
    assert.ok(source);
    assert.equal(source.metadata.argsRedacted, true);
    assert.deepEqual(source.metadata.args, []);
    assert.doesNotMatch(JSON.stringify(source.metadata), /very-secret-token/);
  } finally { ctx.clean(); }
});

test('33. free but untrusted MCP cannot execute', async () => {
  const ctx = setup();
  try {
    const server = writeMcpServer(ctx, 'untrusted-server', 'legacy');
    writeMcpConfig(ctx, { untrusted: { command: 'node', args: [server], cost: 'FREE_LOCAL', protocolMode: 'legacy' } });
    await ctx.manager.discover(ctx.project.id);
    const capability = ctx.manager.store.getByName(ctx.project.id, 'MCP:untrusted');
    assert.equal(ctx.manager.store.latestSource(capability.id)?.trustState, 'UNKNOWN');
    assert.throws(() => ctx.manager.requestMcpVerification(ctx.project.id, capability.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { ctx.clean(); }
});

test('34. trusted free legacy MCP requires Approval then passes probe', async () => {
  const ctx = setup();
  try {
    const server = writeMcpServer(ctx, 'legacy-server', 'legacy');
    writeMcpConfig(ctx, { legacy: {
      command: 'node', args: [server], trust: 'USER_APPROVED', cost: 'FREE_LOCAL', protocolMode: 'legacy',
    } });
    await ctx.manager.discover(ctx.project.id);
    const capability = ctx.manager.store.getByName(ctx.project.id, 'MCP:legacy');
    const operation = ctx.manager.requestMcpVerification(ctx.project.id, capability.id);
    await assert.rejects(() => ctx.manager.executeMcpVerification(operation.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
    approve(ctx, operation.approvalId);
    const completed = await ctx.manager.executeMcpVerification(operation.id);
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(capabilityOverallStatus(ctx.manager.store.get(capability.id)), 'AVAILABLE');
  } finally { ctx.clean(); }
});

test('35. modern server/discover probe is supported after Approval', async () => {
  const ctx = setup();
  try {
    const server = writeMcpServer(ctx, 'modern-server', 'modern');
    writeMcpConfig(ctx, { modern: {
      command: 'node', args: [server], trust: 'USER_APPROVED', cost: 'FREE_LOCAL', protocolMode: 'modern',
    } });
    await ctx.manager.discover(ctx.project.id);
    const capability = ctx.manager.store.getByName(ctx.project.id, 'MCP:modern');
    const operation = ctx.manager.requestMcpVerification(ctx.project.id, capability.id);
    approve(ctx, operation.approvalId);
    const completed = await ctx.manager.executeMcpVerification(operation.id);
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(ctx.manager.store.listChecks(capability.id).at(-1)?.evidence.era, 'modern');
  } finally { ctx.clean(); }
});

test('36. MCP probe failure is persisted instead of fake AVAILABLE', async () => {
  const ctx = setup();
  try {
    const server = writeMcpServer(ctx, 'failed-server', 'fail');
    writeMcpConfig(ctx, { failed: {
      command: 'node', args: [server], trust: 'USER_APPROVED', cost: 'FREE_LOCAL', protocolMode: 'legacy',
    } });
    await ctx.manager.discover(ctx.project.id);
    const capability = ctx.manager.store.getByName(ctx.project.id, 'MCP:failed');
    const operation = ctx.manager.requestMcpVerification(ctx.project.id, capability.id);
    approve(ctx, operation.approvalId);
    const failed = await ctx.manager.executeMcpVerification(operation.id);
    assert.equal(failed.status, 'FAILED');
    assert.equal(ctx.manager.store.get(capability.id).verificationState, 'FAIL');
    assert.equal(capabilityOverallStatus(ctx.manager.store.get(capability.id)), 'ERROR');
  } finally { ctx.clean(); }
});

test('37. missing absolute MCP executable is recorded as dependency failure', async () => {
  const ctx = setup();
  try {
    const missing = process.platform === 'win32' ? 'Z:\\missing\\mcp.exe' : '/definitely/missing/mcp';
    writeMcpConfig(ctx, { missing: {
      command: missing, args: [], trust: 'USER_APPROVED', cost: 'FREE_LOCAL', protocolMode: 'legacy',
    } });
    await ctx.manager.discover(ctx.project.id);
    const capability = ctx.manager.store.getByName(ctx.project.id, 'MCP:missing');
    assert.equal(capability.verificationState, 'FAIL');
    assert.equal(ctx.manager.store.listDependencies(capability.id)[0]?.status, 'MISSING');
  } finally { ctx.clean(); }
});

test('38. stale MCP definition is marked NOT_FOUND after config removal', async () => {
  const ctx = setup();
  try {
    const server = writeMcpServer(ctx, 'stale-mcp-server', 'legacy');
    const config = writeMcpConfig(ctx, { stale: {
      command: 'node', args: [server], trust: 'USER_APPROVED', cost: 'FREE_LOCAL', protocolMode: 'legacy',
    } });
    await ctx.manager.discover(ctx.project.id);
    rmSync(config);
    await ctx.manager.discover(ctx.project.id);
    assert.equal(ctx.manager.store.getByName(ctx.project.id, 'MCP:stale').discoveryState, 'NOT_FOUND');
  } finally { ctx.clean(); }
});

test('39. user approval cannot enable paid capability', () => {
  const ctx = setup();
  try {
    const capability = ctx.manager.store.upsert({
      projectId: ctx.project.id, name: 'Paid service', type: 'MCP',
      discoveryState: 'FOUND', installationState: 'INSTALLED', authState: 'NOT_REQUIRED',
      costState: 'PAID', verificationState: 'PASS', runtimeState: 'VERIFIED',
      enablementState: 'DISABLED',
    });
    assert.throws(() => ctx.manager.setEnabled(ctx.project.id, capability.id, true), (error: unknown) =>
      error instanceof CoreError && error.code === 'CONFLICT');
  } finally { ctx.clean(); }
});

test('40. disable and re-enable free verified capability only changes manager state', async () => {
  const ctx = setup();
  try {
    await ctx.manager.discover(ctx.project.id);
    const node = ctx.manager.store.getByName(ctx.project.id, 'Node');
    assert.equal(ctx.manager.setEnabled(ctx.project.id, node.id, false).overallStatus, 'DISABLED');
    assert.equal(ctx.manager.setEnabled(ctx.project.id, node.id, true).overallStatus, 'AVAILABLE');
    assert.equal(ctx.manager.store.listOperations(ctx.project.id).filter(op => op.kind === 'DISABLE' || op.kind === 'ENABLE').length, 2);
  } finally { ctx.clean(); }
});

test('41. capability operation writes durable audit events', () => {
  const ctx = setup();
  try {
    ctx.manager.requestSkillInstall(ctx.project.id, createSkill(sourceRoot(ctx), 'event-skill'));
    const types = ctx.engine.repository.listEvents(ctx.project.id).map(event => event.type);
    assert.ok(types.includes('capability.operation_created'));
    assert.ok(types.includes('approval.requested'));
    assert.ok(types.includes('checkpoint.captured'));
  } finally { ctx.clean(); }
});

test('42. Dashboard exposes separated Capability state axes', async () => {
  const ctx = setup();
  try {
    await ctx.manager.discover(ctx.project.id);
    const state = new DashboardService(ctx.engine).projectState(ctx.project.id);
    const node = state.capabilities.find(item => item.name === 'Node');
    assert.equal(node?.status, 'AVAILABLE');
    assert.equal(node?.discovery, 'FOUND');
    assert.equal(node?.installation, 'INSTALLED');
    assert.equal(node?.verification, 'PASS');
    assert.equal(node?.cost, 'FREE_LOCAL');
    assert.ok(Array.isArray(state.capabilityOperations));
  } finally { ctx.clean(); }
});

test('43. discovery API returns persisted snapshot', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/capability-manager/projects/' + ctx.project.id + '/discover' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { capabilities: { name: string }[] };
    assert.ok(body.capabilities.some(item => item.name === 'Node'));
  } finally {
    await app.close();
    ctx.clean();
  }
});

test('44. invalid Skill install API input returns 400', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/capability-manager/projects/' + ctx.project.id + '/skills/install-request',
      payload: {},
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    ctx.clean();
  }
});

test('45. missing Capability detail returns 404', async () => {
  const ctx = setup();
  const app = createApp(ctx.engine);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/capability-manager/projects/' + ctx.project.id + '/capabilities/missing',
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    ctx.clean();
  }
});

test('46. v5 database migrates forward preserving project data', () => {
  const work = committedFixture();
  try {
    const db = new CoreDatabase(join(work.path, 'migration.sqlite'), false);
    assert.equal(migrate(db.db, 5), 5);
    db.db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)').run('p-v5', 'saved', work.path, 'draft', 1, 't', 't');
    assert.equal(migrate(db.db), 7);
    assert.equal((db.db.prepare('SELECT name FROM projects WHERE id = ?').get('p-v5') as { name: string }).name, 'saved');
    db.close();
  } finally { work.clean(); }
});
