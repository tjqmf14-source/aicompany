import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { CoreError } from '../core/domain.js';
import { hasSensitiveArgument, redact, safeExecutable, sanitizedChildEnv } from './security.js';
import type { CostState, McpDefinition, McpProbeResult, SourceTrustState } from './types.js';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const strings = (value: unknown): string[] => Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
const protocol = (value: unknown): McpDefinition['protocolMode'] =>
  value === 'modern' || value === 'legacy' || value === 'auto' ? value : 'auto';
const trust = (value: unknown, projectOwned: boolean): SourceTrustState =>
  projectOwned && value === 'USER_APPROVED' ? 'USER_APPROVED'
    : value === 'OFFICIAL' ? 'OFFICIAL'
      : value === 'VERIFIED_REPOSITORY' ? 'VERIFIED_REPOSITORY'
        : value === 'BLOCKED' ? 'BLOCKED'
          : 'UNKNOWN';
const cost = (value: unknown, projectOwned: boolean): CostState =>
  value === 'PAID' ? 'PAID'
    : value === 'USAGE_BASED_PAID' ? 'USAGE_BASED_PAID'
      : projectOwned && value === 'FREE_LOCAL' ? 'FREE_LOCAL'
        : projectOwned && value === 'FREE_EXISTING_ACCOUNT' ? 'FREE_EXISTING_ACCOUNT'
          : 'UNKNOWN_COST';

function fromMap(map: JsonObject, configPath: string, projectOwned: boolean): McpDefinition[] {
  const result: McpDefinition[] = [];
  for (const [name, raw] of Object.entries(map)) {
    const item = object(raw);
    const command = typeof item.command === 'string' ? item.command.trim() : '';
    if (!command) continue;
    const args = strings(item.args);
    const envKeys = Object.keys(object(item.env));
    result.push({
      name,
      command,
      args,
      configPath,
      protocolMode: protocol(item.protocolMode),
      trustState: trust(item.trust, projectOwned),
      costState: cost(item.cost, projectOwned),
      authRequired: envKeys.length > 0 || hasSensitiveArgument(args),
      envKeys,
    });
  }
  return result;
}

function parseJson(path: string, projectOwned: boolean): McpDefinition[] {
  const parsed = object(JSON.parse(readFileSync(path, 'utf8')));
  return fromMap(object(parsed.mcpServers ?? parsed.servers), path, projectOwned);
}

function parseToml(path: string): McpDefinition[] {
  const text = readFileSync(path, 'utf8');
  const records = new Map<string, { command?: string; args?: string[]; envKeys: string[] }>();
  let current: string | null = null;
  let inEnv = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const section = line.match(/^\[mcp_servers\.([A-Za-z0-9_.-]+)(\.env)?\]$/);
    if (section) {
      current = section[1] ?? null;
      inEnv = Boolean(section[2]);
      if (current && !records.has(current)) records.set(current, { envKeys: [] });
      continue;
    }
    if (!current) continue;
    const record = records.get(current)!;
    const pair = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!pair) continue;
    const key = pair[1]!;
    const value = pair[2]!.trim();
    if (inEnv) {
      record.envKeys.push(key);
      continue;
    }
    if (key === 'command') {
      const match = value.match(/^"(.*)"$/);
      if (match) record.command = match[1]!.replaceAll('\\\\', '\\');
    } else if (key === 'args' && value.startsWith('[')) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) record.args = parsed as string[];
      } catch {
        record.args = [];
      }
    }
  }
  return [...records.entries()].flatMap(([name, record]) => record.command ? [{
    name,
    command: record.command,
    args: record.args ?? [],
    configPath: path,
    protocolMode: 'auto' as const,
    trustState: 'UNKNOWN' as const,
    costState: 'UNKNOWN_COST' as const,
    authRequired: record.envKeys.length > 0 || hasSensitiveArgument(record.args ?? []),
    envKeys: record.envKeys,
  }] : []);
}

export function discoverMcpDefinitions(projectRoot: string): { definitions: McpDefinition[]; errors: string[] } {
  const candidates: { path: string; projectOwned: boolean; format: 'json' | 'toml' }[] = [];
  const envPath = process.env.AI_COMPANY_MCP_CONFIG;
  if (envPath) candidates.push({ path: resolve(envPath), projectOwned: false, format: envPath.endsWith('.toml') ? 'toml' : 'json' });
  candidates.push({ path: join(projectRoot, '.ai-company', 'mcp.json'), projectOwned: true, format: 'json' });
  candidates.push({ path: join(homedir(), '.codex', 'mcp.json'), projectOwned: false, format: 'json' });
  candidates.push({ path: join(homedir(), '.codex', 'config.toml'), projectOwned: false, format: 'toml' });

  const definitions: McpDefinition[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const path = resolve(candidate.path);
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    try {
      definitions.push(...(candidate.format === 'json' ? parseJson(path, candidate.projectOwned) : parseToml(path)));
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { definitions, errors };
}

interface ProbeMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

function runProbe(definition: McpDefinition, era: 'modern' | 'legacy', timeoutMs = 2500): Promise<McpProbeResult> {
  return new Promise(resolveResult => {
    const executable = safeExecutable(definition.command);
    if (!executable) {
      resolveResult({ ok: false, era: null, detail: 'MCP command must be node or an absolute regular executable path', serverInfo: null });
      return;
    }
    if (hasSensitiveArgument(definition.args)) {
      resolveResult({ ok: false, era: null, detail: 'MCP arguments appear to contain credentials; automatic probe is blocked', serverInfo: null });
      return;
    }
    const child = spawn(executable, definition.args, {
      cwd: dirname(definition.configPath),
      env: sanitizedChildEnv(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: McpProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* Process may already be gone. */ }
      resolveResult(result);
    };
    const timer = setTimeout(() => finish({
      ok: false,
      era: null,
      detail: `MCP ${era} probe timed out`,
      serverInfo: null,
    }), timeoutMs);

    child.on('error', error => finish({ ok: false, era: null, detail: redact(error.message), serverInfo: null }));
    child.stderr?.on('data', chunk => { stderr = redact(stderr + String(chunk), 4000); });
    child.stdout?.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.length > 256 * 1024) {
        finish({ ok: false, era: null, detail: 'MCP probe exceeded output limit', serverInfo: null });
        return;
      }
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: ProbeMessage;
        try { message = JSON.parse(line) as ProbeMessage; } catch { continue; }
        if (message.id !== 1) continue;
        if (message.error !== undefined) {
          finish({ ok: false, era: null, detail: `MCP returned JSON-RPC error: ${redact(JSON.stringify(message.error), 1000)}`, serverInfo: null });
          return;
        }
        const result = object(message.result);
        if (!Object.keys(result).length) continue;
        if (era === 'legacy') {
          const notification: ProbeMessage = { jsonrpc: '2.0', method: 'notifications/initialized', params: {} };
          child.stdin?.write(JSON.stringify(notification) + '\n');
        }
        const meta = object(result._meta);
        const serverInfo = object(meta['io.modelcontextprotocol/serverInfo']);
        finish({
          ok: true,
          era,
          detail: `MCP ${era} protocol probe passed`,
          serverInfo: Object.keys(serverInfo).length ? serverInfo : null,
        });
        return;
      }
    });
    child.on('exit', code => {
      if (!settled) finish({
        ok: false,
        era: null,
        detail: `MCP process exited before a valid response (code ${code ?? 'unknown'})${stderr ? `: ${stderr}` : ''}`,
        serverInfo: null,
      });
    });

    const request: ProbeMessage = era === 'modern'
      ? {
        jsonrpc: '2.0', id: 1, method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'ai-company-bridge', version: '0.1.0' },
          },
        },
      }
      : {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'ai-company-bridge', version: '0.1.0' },
        },
      };
    child.stdin?.write(JSON.stringify(request) + '\n');
  });
}

export async function probeMcp(definition: McpDefinition): Promise<McpProbeResult> {
  if (definition.authRequired) return { ok: false, era: null, detail: 'MCP configuration references environment credentials; automatic probe does not forward secrets', serverInfo: null };
  if (definition.protocolMode === 'modern') return runProbe(definition, 'modern');
  if (definition.protocolMode === 'legacy') return runProbe(definition, 'legacy');
  const modern = await runProbe(definition, 'modern', 1500);
  if (modern.ok) return modern;
  return runProbe(definition, 'legacy', 2500);
}

export function validateMcpDefinition(definition: McpDefinition): void {
  if (!definition.name.trim() || definition.name.length > 200) throw new CoreError('INVALID_INPUT', 'Invalid MCP name');
  if (!definition.command.trim() || definition.command.includes('\0')) throw new CoreError('INVALID_INPUT', 'Invalid MCP command');
  if (definition.args.length > 100 || definition.args.some(arg => arg.length > 2000 || arg.includes('\0') || /[\r\n]/.test(arg))) {
    throw new CoreError('INVALID_INPUT', 'Invalid MCP arguments');
  }
  if (isAbsolute(definition.command) && !existsSync(definition.command)) throw new CoreError('INVALID_INPUT', 'MCP executable path does not exist');
}
