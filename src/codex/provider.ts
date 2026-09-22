import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppServerRpcError, CodexAppServerClient } from './app-server-client.js';
import type {
  CodexAvailability, CodexEffort, CodexExecutionProvider, CodexRateLimitSnapshot,
  CodexRunOutcome, CodexRunRequest,
} from './types.js';

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const asString = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const cleanError = (value: unknown): string => String(value instanceof Error ? value.message : value)
  .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
  .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
  .slice(0, 8000);

export function resolveCodexJsPath(): string {
  const override = process.env.AI_COMPANY_CODEX_JS?.trim();
  if (override) return resolve(override);
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  }
  return '';
}

export function parseCodexRateLimit(value: unknown): CodexRateLimitSnapshot | null {
  const root = asObject(value);
  const map = asObject(root.rateLimitsByLimitId);
  let raw = asObject(map.codex);
  if (!Object.keys(raw).length) raw = asObject(root.rateLimits);
  if (!Object.keys(raw).length) return null;
  const primary = asObject(raw.primary);
  const secondary = asObject(raw.secondary);
  return {
    limitId: asString(raw.limitId) ?? (Object.keys(map).includes('codex') ? 'codex' : null),
    primaryUsedPercent: asNumber(primary.usedPercent),
    secondaryUsedPercent: asNumber(secondary.usedPercent),
    rateLimitReachedType: asString(raw.rateLimitReachedType),
    checkedAt: new Date().toISOString(),
  };
}

export function isRateLimited(snapshot: CodexRateLimitSnapshot | null): boolean {
  if (!snapshot) return false;
  return snapshot.rateLimitReachedType !== null
    || (snapshot.primaryUsedPercent !== null && snapshot.primaryUsedPercent >= 100)
    || (snapshot.secondaryUsedPercent !== null && snapshot.secondaryUsedPercent >= 100);
}

function mcpSafetyArgs(): string[] {
  return [
    '-c', 'mcp_servers.gemini.enabled=false',
    '-c', 'mcp_servers.apify.enabled=false',
    '-c', 'mcp_servers.mobbin.enabled=false',
    '-c', 'mcp_servers.upbit.enabled=false',
    '-c', 'mcp_servers.local_comfyui.enabled=false',
  ];
}

type ModelRecord = { model?: unknown; supportedReasoningEfforts?: unknown };

export class CodexAppServerProvider implements CodexExecutionProvider {
  readonly id = 'codex-app-server';
  constructor(
    private readonly codexJsPath = resolveCodexJsPath(),
    private readonly defaultModel = 'gpt-5.6-luna',
    private readonly defaultEffort: CodexEffort = 'low',
  ) {}

  private client(cwd: string): CodexAppServerClient {
    return new CodexAppServerClient(this.codexJsPath, cwd, mcpSafetyArgs());
  }

  private pathUsable(): boolean {
    if (!this.codexJsPath || !existsSync(this.codexJsPath)) return false;
    try { return statSync(this.codexJsPath).isFile(); } catch { return false; }
  }

  private async assertChatGptAuth(client: CodexAppServerClient): Promise<void> {
    const result = asObject(await client.request('account/read', { refreshToken: false }, 30_000));
    const account = asObject(result.account);
    const mode = asString(account.type) ?? asString(result.authMode);
    if (mode !== 'chatgpt') {
      throw new Error(`ZERO_COST policy requires ChatGPT login; current auth mode is ${mode ?? 'unknown'}`);
    }
  }

  private async rateLimit(client: CodexAppServerClient): Promise<CodexRateLimitSnapshot | null> {
    return parseCodexRateLimit(await client.request('account/rateLimits/read', undefined, 30_000));
  }

  async checkAvailability(cwd: string): Promise<CodexAvailability> {
    if (!this.pathUsable()) {
      return { state: 'unavailable', reason: 'Codex App Server installation was not found', rateLimit: null };
    }
    const client = this.client(cwd);
    try {
      await client.open();
      await this.assertChatGptAuth(client);
      const rateLimit = await this.rateLimit(client);
      return isRateLimited(rateLimit)
        ? { state: 'rate_limited', reason: 'Codex ChatGPT usage limit is reached', rateLimit }
        : { state: 'available', reason: null, rateLimit };
    } catch (error) {
      return { state: 'unavailable', reason: cleanError(error), rateLimit: null };
    } finally {
      await client.close().catch(() => {});
    }
  }

  private async selectModel(client: CodexAppServerClient, requested?: string, requestedEffort?: CodexEffort): Promise<{ model: string; effort: CodexEffort | null }> {
    const result = asObject(await client.request('model/list', { limit: 100, includeHidden: false }, 30_000));
    const models = Array.isArray(result.data) ? result.data.map(asObject) as ModelRecord[] : [];
    const wanted = requested?.trim() || this.defaultModel;
    const selected = models.find(item => item.model === wanted) ?? models[0];
    const model = asString(selected?.model);
    if (!model) throw new Error('Codex model list is empty');
    const effortRows = Array.isArray(selected?.supportedReasoningEfforts) ? selected!.supportedReasoningEfforts as unknown[] : [];
    const efforts = effortRows.map(item => asString(asObject(item).reasoningEffort)).filter((item): item is CodexEffort =>
      item === 'low' || item === 'medium' || item === 'high' || item === 'xhigh' || item === 'max');
    const wantedEffort = requestedEffort ?? this.defaultEffort;
    return { model, effort: efforts.includes(wantedEffort) ? wantedEffort : efforts[0] ?? null };
  }

  private async startThread(client: CodexAppServerClient, cwd: string, model: string): Promise<Record<string, unknown>> {
    const common = { model, cwd, approvalPolicy: 'never', serviceName: 'ai_company_bridge' };
    try {
      return asObject(await client.request('thread/start', { ...common, sandbox: 'workspace-write' }, 90_000));
    } catch (error) {
      if (!(error instanceof AppServerRpcError)) throw error;
      return asObject(await client.request('thread/start', { ...common, sandbox: 'workspaceWrite' }, 90_000));
    }
  }

  private async resumeThread(client: CodexAppServerClient, threadId: string, cwd: string): Promise<Record<string, unknown>> {
    try {
      return asObject(await client.request('thread/resume', { threadId, cwd, approvalPolicy: 'never', sandbox: 'workspace-write' }, 90_000));
    } catch (error) {
      if (!(error instanceof AppServerRpcError)) throw error;
      return asObject(await client.request('thread/resume', { threadId, cwd, approvalPolicy: 'never', sandbox: 'workspaceWrite' }, 90_000));
    }
  }

  async run(request: CodexRunRequest): Promise<CodexRunOutcome> {
    if (!this.pathUsable()) {
      return {
        status: 'failed', threadId: request.threadId, turnId: null, model: null, effort: null,
        reusedThread: false, rateLimit: null, lastEvent: null, error: 'Codex App Server installation was not found',
      };
    }
    const client = this.client(request.cwd);
    let threadId = request.threadId;
    let turnId: string | null = null;
    let model: string | null = null;
    let effort: CodexEffort | null = null;
    let reusedThread = false;
    try {
      await client.open();
      await this.assertChatGptAuth(client);
      const before = await this.rateLimit(client);
      if (isRateLimited(before)) {
        return {
          status: 'rate_limited', threadId, turnId, model, effort, reusedThread,
          rateLimit: before, lastEvent: null, error: 'Codex ChatGPT usage limit is reached',
        };
      }
      const selected = await this.selectModel(client, request.model, request.effort);
      model = selected.model;
      effort = selected.effort;

      if (threadId) {
        try {
          const resumed = this.resumeThread(client, threadId, request.cwd);
          threadId = asString(asObject(resumed.thread).id) ?? threadId;
          reusedThread = true;
        } catch (error) {
          if (!request.allowNewThreadOnResumeFailure) throw error;
          threadId = null;
        }
      }
      if (!threadId) {
        const started = await this.startThread(client, request.cwd, model);
        threadId = asString(asObject(started.thread).id);
        if (!threadId) throw new Error('thread/start did not return a thread ID');
        reusedThread = false;
      }

      const startedAt = Date.now();
      const turnParams: Record<string, unknown> = {
        threadId,
        input: [{
          type: 'text',
          text: `${request.objective}\n\nAI Company Bridge constraints: work only in this repository, do not use paid APIs or external paid services, preserve existing architecture, and leave the workspace in an inspectable state.`,
        }],
      };
      if (effort) turnParams.effort = effort;
      const startedTurn = asObject(await client.request('turn/start', turnParams, 120_000));
      turnId = asString(asObject(startedTurn.turn).id);
      if (!turnId) throw new Error('turn/start did not return a turn ID');
      const completed = await client.waitEvent(
        'turn/completed',
        params => asString(asObject(params.turn).id) === turnId,
        30 * 60_000,
        startedAt,
      );
      const finalStatus = asString(asObject(completed.params.turn).status);
      const after = await this.rateLimit(client).catch(() => before);
      const lastEvent = client.latestEvent();
      if (finalStatus === 'completed') {
        return {
          status: 'completed', threadId, turnId, model, effort, reusedThread, rateLimit: after,
          lastEvent: lastEvent ? { method: lastEvent.method, params: lastEvent.params } : null, error: null,
        };
      }
      if (isRateLimited(after)) {
        return {
          status: 'rate_limited', threadId, turnId, model, effort, reusedThread, rateLimit: after,
          lastEvent: lastEvent ? { method: lastEvent.method, params: lastEvent.params } : null,
          error: `Codex turn ended with ${finalStatus ?? 'unknown'} while the usage limit was reached`,
        };
      }
      return {
        status: finalStatus === 'interrupted' ? 'interrupted' : 'failed',
        threadId, turnId, model, effort, reusedThread, rateLimit: after,
        lastEvent: lastEvent ? { method: lastEvent.method, params: lastEvent.params } : null,
        error: `Codex turn ended with status ${finalStatus ?? 'unknown'}`,
      };
    } catch (error) {
      const rateLimit = await this.rateLimit(client).catch(() => null);
      const lastEvent = client.latestEvent();
      return {
        status: isRateLimited(rateLimit) ? 'rate_limited' : 'failed',
        threadId, turnId, model, effort, reusedThread, rateLimit,
        lastEvent: lastEvent ? { method: lastEvent.method, params: lastEvent.params } : null,
        error: cleanError(error),
      };
    } finally {
      await client.close().catch(() => {});
    }
  }
}
