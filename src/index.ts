import { Context, Service } from '@deepseek-ai/cordis';
import { promises as fsp } from 'node:fs';
import Schema from '@deepseek-ai/schemastery';
import { AntigravityEngine } from './engine.js';
import { AntigravityAgent, AgentInitConfig, SessionContinuationMode, TokenUsage } from './client.js';
import { PromptContent, MediaInput, fileToMedia, normalizePromptParts } from './media.js';
import {
  listConversations,
  getConversationTree,
  ConversationSummary,
  ConversationTreeNode,
  ListConversationsOptions,
  getDefaultAppDataDir,
} from './storage.js';
import {
  ANTIGRAVITY_MODELS,
  AntigravityModelInfo,
  normalizeModelName,
  DEFAULT_MODEL_ID,
} from './models.js';
import { HubClient } from './hub/client.js';
import { pollTranscript, readCascadeTranscript, TranscriptSnapshot, PendingToolApproval } from './hub/transcript.js';

/** Server-side idle stabilization window for WaitForConversationFullyIdle. */
const IDLE_STABILIZATION_SECONDS = 10;

export interface AntigravityConfig {
  backend?: 'hub' | 'localharness';
  binaryPath?: string;
  protoDir?: string;
  defaultModel?: string;
  appDataDir?: string;
  projectId?: string;
  hubAddress?: string;
  hubCsrfToken?: string;
  pollTimeoutMs?: number;
  watchMaxMs?: number;
}

export const Config: Schema<AntigravityConfig> = Schema.object({
  backend: Schema.union(['hub', 'localharness'])
    .default('hub')
    .description('Backend: hub = local Antigravity IDE gRPC (agy quota), localharness = standalone SDK binary (API key)'),
  binaryPath: Schema.string().description('Path to localharness.exe binary (localharness backend only)'),
  protoDir: Schema.string().description('Path to proto directory (localharness backend only)'),
  defaultModel: Schema.string().default(DEFAULT_MODEL_ID).description('Default model display id'),
  appDataDir: Schema.string().description('Custom Antigravity app data directory'),
  projectId: Schema.string().description('Default Antigravity project id for new conversations'),
  hubAddress: Schema.string().description('Override hub address (e.g. 127.0.0.1:7778); skips discovery when both overrides are set'),
  hubCsrfToken: Schema.string().description('Override hub CSRF token'),
  pollTimeoutMs: Schema.number().default(300_000).description('Transcript poll timeout in ms'),
  watchMaxMs: Schema.number().default(43_200_000).description('Background lifecycle watcher absolute cap in ms (default 12h); settlement watching never expires before this'),
});

declare module '@deepseek-ai/cordis' {
  interface Context {
    antigravity: AntigravityService;
  }
}

export interface RunOneShotOptions extends AgentInitConfig {
  attachments?: string[];
}

/** Live state of one background hub delegation, keyed by cascade id. */
export interface HubRun {
  cascadeId: string;
  status: 'running' | 'done' | 'error' | 'awaiting-approval' | 'timeout';
  startedAt: number;
  baselineStepIndex?: number;
  callerAgent?: any;
  lastActiveAt?: string;
  content?: string;
  error?: string;
  pendingTool?: PendingToolApproval;
  approvalNotified?: boolean;
  resumedNotified?: boolean;
  lastNotifiedTransition?: string;
}

export interface CascadeDetailedResult {
  status: 'done' | 'awaiting-approval' | 'running' | 'timeout' | 'error';
  content: string;
  lastActiveAt?: string;
  pendingTool?: PendingToolApproval;
  error?: string;
}

export interface SettlementNoticePayload {
  summary: string;
  noticeText: string;
  isRefusalOrEarlyDeath: boolean;
}

export function buildSettlementNotice(run: HubRun): SettlementNoticePayload {
  const elapsedSec = Math.max(1, Math.round((Date.now() - run.startedAt) / 1000));
  const content = (run.content || '').trim();

  // Fast refusal and abnormal early termination detection
  const isRefusal = /无法协助|违反|safety policy|cannot assist|unable to assist|policy violation|作为AI|抱歉，我无法|I cannot fulfill|against our safety guidelines/i.test(content);
  const isEarlyDeath = elapsedSec < 60 && (isRefusal || content.length < 50 || !content || run.status === 'error');

  let emoji = '✅';
  let label = 'Settled';
  let detail = '';

  if (run.status === 'awaiting-approval') {
    emoji = '🚨';
    label = 'Awaiting User Approval in IDE';
    const pt = run.pendingTool;
    const argsStr = pt?.args ? JSON.stringify(pt.args, null, 2) : '{}';
    detail = `Tool: **${pt?.name || 'unknown'}**\nAction: ${pt?.action || pt?.summary || 'N/A'}\nArgs:\n\`\`\`json\n${argsStr}\n\`\`\`\n\n> ⚠️ Antigravity IDE 正在等待用户点击授权弹窗，请前往 IDE 操作。`;
  } else if (run.status === 'error') {
    emoji = '❌';
    label = 'Execution Error';
    detail = `Error: ${run.error || 'Unknown error'}`;
  } else if (run.status === 'timeout') {
    emoji = '⏱️';
    label = 'Execution Timed Out';
    detail = `⏱️ **Cascade 超过轮询时限未完成（超时）**\n\n- 最后活跃时间: ${run.lastActiveAt || '无'}\n- 当前输出片段:\n> ${content.slice(0, 400) || '(暂无输出)'}`;
  } else if (isEarlyDeath || isRefusal) {
    emoji = '⚠️';
    label = 'Early Termination / Model Refusal';
    detail = `⚠️ **Cascade 在 ${elapsedSec} 秒内异常结束/拒答**：\n\n> ${content.slice(0, 500) || '(无输出内容)'}`;
  } else {
    emoji = '✅';
    label = 'Completed Successfully';
    detail = `耗时: ${elapsedSec}s\n\n摘要:\n${content.slice(0, 400)}${content.length > 400 ? '...' : ''}`;
  }

  const summary = `${emoji} [Antigravity] ${run.cascadeId.slice(0, 8)} ${label}`;
  const noticeText = `### ${emoji} Antigravity Cascade ${label}\n- **Cascade ID**: \`${run.cascadeId}\`\n- **Status**: \`${run.status}\`\n- **Elapsed**: ${elapsedSec}s\n\n${detail}`;

  return { summary, noticeText, isRefusalOrEarlyDeath: isEarlyDeath || isRefusal };
}

interface QueuedMessage {
  content: string;
  wait: boolean | number;
  mode?: 'step-end' | 'turn-end' | 'interrupt';
  callerAgent?: any;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class AntigravityService extends Service {
  private engine: AntigravityEngine;
  private config: AntigravityConfig;
  private hubClient?: HubClient;
  private runs = new Map<string, HubRun>();
  private watchers = new Map<string, Promise<void>>();
  private messageQueues = new Map<string, QueuedMessage[]>();
  private disposed = false;

  constructor(ctx: Context, config: AntigravityConfig) {
    super(ctx, 'antigravity');
    this.config = config;
    this.engine = new AntigravityEngine({
      binaryPath: config.binaryPath,
      protoDir: config.protoDir,
      appDataDir: config.appDataDir,
    });
    ctx.effect(() => () => {
      this.disposed = true;
    });
  }

  /** Proactively push a settlement/approval notice to DSH session (steering / followup) with idempotency. */
  notifySettlementToDsh(run: HubRun, callerAgent?: any): void {
    if (this.disposed) return;
    try {
      const transitionKey = `${run.status}:${run.startedAt}:${run.pendingTool ? run.pendingTool.name : (run.content?.slice(0, 32) || run.error || '')}`;
      if (run.lastNotifiedTransition === transitionKey) {
        return; // Idempotent: already notified this transition
      }

      const { summary, noticeText } = buildSettlementNotice(run);
      const message = {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content: [{ type: 'text' as const, text: noticeText }],
        source: {
          kind: 'subagent-settled' as const,
          form: 'notice' as const,
          summary,
          senderSessionId: run.cascadeId,
        },
      };

      const targetAgent = callerAgent || run.callerAgent;
      let delivered = false;
      if (targetAgent && !targetAgent.disposed) {
        try {
          if (targetAgent.status === 'idle') {
            targetAgent.followup?.(message);
          } else {
            targetAgent.steer?.(message);
          }
          delivered = true;
        } catch {
          // fallback to active agents
        }
      }

      if (!delivered) {
        const agentsService = (this.ctx as any).agents;
        const liveAgents = agentsService?.list?.() || [];
        for (const ag of liveAgents) {
          if (ag && !ag.disposed) {
            try {
              if (ag.status === 'idle') {
                ag.followup?.(message);
              } else {
                ag.steer?.(message);
              }
              delivered = true;
              break;
            } catch {
              // ignore
            }
          }
        }
      }

      if (delivered) {
        run.lastNotifiedTransition = transitionKey;
      } // else: leave unset so the next watcher tick retries delivery
      (this.ctx as any).emit?.('antigravity/settled', { run, summary, noticeText, delivered });
    } catch {
      // Settlement notices must be safe and never throw
    }
  }

  /** Push a resumption notice when user approvals in IDE are granted. */
  notifyResumedToDsh(run: HubRun, callerAgent?: any): void {
    if (this.disposed) return;
    try {
      const transitionKey = `resumed:${run.startedAt}`;
      if (run.lastNotifiedTransition === transitionKey) {
        return;
      }

      const summary = `▶️ [Antigravity] ${run.cascadeId.slice(0, 8)} User Approved, Resumed`;
      const noticeText = `### ▶️ Antigravity Cascade Resumed\n- **Cascade ID**: \`${run.cascadeId}\`\n- **Status**: \`running\`\n\n> 授权已在 Antigravity IDE 中通过，Cascade 正在恢复执行后续步骤...`;
      const message = {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content: [{ type: 'text' as const, text: noticeText }],
        source: {
          kind: 'subagent-settled' as const,
          form: 'notice' as const,
          summary,
          senderSessionId: run.cascadeId,
        },
      };

      const targetAgent = callerAgent || run.callerAgent;
      let delivered = false;
      if (targetAgent && !targetAgent.disposed) {
        try {
          if (targetAgent.status === 'idle') {
            targetAgent.followup?.(message);
          } else {
            targetAgent.steer?.(message);
          }
          delivered = true;
        } catch {
          // ignore
        }
      }

      if (!delivered) {
        const agentsService = (this.ctx as any).agents;
        const liveAgents = agentsService?.list?.() || [];
        for (const ag of liveAgents) {
          if (ag && !ag.disposed) {
            try {
              if (ag.status === 'idle') {
                ag.followup?.(message);
              } else {
                ag.steer?.(message);
              }
              delivered = true;
              break;
            } catch {
              // ignore
            }
          }
        }
      }

      if (delivered) {
        run.lastNotifiedTransition = transitionKey;
      } // else: leave unset so the next watcher tick retries delivery
      (this.ctx as any).emit?.('antigravity/resumed', { run, summary, noticeText, delivered });
    } catch {
      // safe ignore
    }
  }

  // --- localharness backend ---

  createAgent(initConfig: AgentInitConfig = {}): AntigravityAgent {
    return new AntigravityAgent(this.engine);
  }

  listModels(): AntigravityModelInfo[] {
    return ANTIGRAVITY_MODELS;
  }

  // --- shared: conversation storage ---

  /** Coalesce undefined leaves to null so tool output stays lossless JSON. */
  private static lossless<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, (_k, v) => (v === undefined ? null : v)));
  }

  async listConversations(options: ListConversationsOptions = {}): Promise<ConversationSummary[]> {
    return AntigravityService.lossless(await listConversations({
      appDataDir: options.appDataDir || this.config.appDataDir,
      limit: options.limit,
      onlyRoots: options.onlyRoots,
      includeSubagents: options.includeSubagents,
      maxDepth: options.maxDepth,
      parentId: options.parentId,
    }));
  }

  async getConversationTree(options: {
    conversationId?: string;
    limit?: number;
  } = {}): Promise<{ trees: ConversationTreeNode[]; ascii: string }> {
    return AntigravityService.lossless(await getConversationTree({
      appDataDir: this.config.appDataDir,
      conversationId: options.conversationId,
      limit: options.limit,
    }));
  }

  // --- localharness one-shot ---

  async runOneShot(prompt: PromptContent, options: RunOneShotOptions = {}): Promise<string> {
    const modelToUse = options.model || this.config.defaultModel || DEFAULT_MODEL_ID;
    const agent = this.createAgent({ ...options, model: modelToUse });

    await agent.start({
      ...options,
      model: modelToUse,
      appDataDir: options.appDataDir || this.config.appDataDir,
    });

    const parts = await normalizePromptParts(prompt);
    agent.sendPrompt(parts as any);

    return new Promise<string>((resolve, reject) => {
      const results: string[] = [];
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      const onStep = (step: { content?: string; error?: string; status: string }) => {
        if (step.content) results.push(step.content);
        if (step.error) reject(new Error(step.error));
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          agent.off('step', onStep);
          agent.off('error', onError);
          resolve(results.join('\n'));
        }, 3000);
      };

      const onError = (err: Error) => {
        agent.off('step', onStep);
        agent.off('error', onError);
        reject(err);
      };

      agent.on('step', onStep);
      agent.on('error', onError);
    });
  }

  // --- hub backend ---

  private async getHubClient(): Promise<HubClient> {
    if (!this.hubClient) {
      this.hubClient = await HubClient.create({
        address: this.config.hubAddress,
        csrfToken: this.config.hubCsrfToken,
      });
    }
    return this.hubClient;
  }

  /** Hub GetAvailableModels, slimmed to the fields a model caller needs. */
  async hubListModels(): Promise<unknown> {
    const client = await this.getHubClient();
    const resp = (await client.getAvailableModels()) as {
      response?: { models?: Record<string, Record<string, unknown>> };
    };
    const models = resp.response?.models ?? {};
    const slim: Record<string, unknown> = {};
    for (const [id, m] of Object.entries(models)) {
      const quota = m.quotaInfo as Record<string, unknown> | undefined;
      // Tool output must be lossless JSON: coalesce every absent field to null.
      slim[id] = {
        displayName: m.displayName ?? null,
        recommended: m.recommended ?? null,
        maxTokens: m.maxTokens ?? null,
        maxOutputTokens: m.maxOutputTokens ?? null,
        supportsImages: m.supportsImages ?? null,
        quotaRemainingFraction: quota?.remainingFraction ?? null,
        quotaResetTime: quota?.resetTime ?? null,
      };
    }
    return slim;
  }

  /** Ensure an active background watcher exists and monitors this cascade's lifecycle until final settlement. */
  ensureActiveWatcher(cascadeId: string, callerAgent?: any, baselineStepIndex?: number): void {
    if (this.disposed) return;

    let run = this.runs.get(cascadeId);
    if (!run) {
      run = {
        cascadeId,
        status: 'running',
        startedAt: Date.now(),
        baselineStepIndex: baselineStepIndex ?? -1,
        callerAgent,
      };
      this.runs.set(cascadeId, run);
    } else {
      if (callerAgent) run.callerAgent = callerAgent;
      if (baselineStepIndex !== undefined) run.baselineStepIndex = baselineStepIndex;
      if (run.status === 'done' || run.status === 'error' || run.status === 'timeout') {
        // Re-activated cascade
        run.status = 'running';
        run.startedAt = Date.now();
        run.approvalNotified = false;
        run.resumedNotified = false;
        run.lastNotifiedTransition = undefined;
        run.error = undefined;
        run.content = undefined;
      }
    }

    if (this.watchers.has(cascadeId)) {
      return;
    }

    const watcher = this.runCascadeWatcher(cascadeId);
    this.watchers.set(cascadeId, watcher);
  }

  /** Unified active cascade loop: continuously tracks running/approval/done transitions and notifies DSH. */
  private async runCascadeWatcher(cascadeId: string): Promise<void> {
    const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
    const brainDir = `${appDataDir}/brain`;
    // Lifecycle watcher: keep watching until terminal settlement (done/error).
    // pollTimeoutMs applies ONLY to synchronous wait paths — previously this watcher
    // died at 300s, fabricated a spurious 'timeout' notice, and left the cascade
    // unwatched, so the genuine settlement was never delivered to DSH.
    const watchMs = this.config.watchMaxMs ?? 43_200_000;
    const deadline = Date.now() + watchMs;
    let lastStepSeen = -2;
    let idleCycles = 0;

    try {
      while (!this.disposed && Date.now() < deadline) {
        const run = this.runs.get(cascadeId) ?? {
          cascadeId,
          status: 'running',
          startedAt: Date.now(),
          baselineStepIndex: -1,
        };
        const baseline = run.baselineStepIndex ?? -1;
        const snap = await readCascadeTranscript(brainDir, cascadeId, baseline);

        if (snap) {
          run.lastActiveAt = snap.lastActiveAt;
          if (snap.plannerContents.length > 0) {
            run.content = snap.plannerContents.join('\n\n');
          }
        }

        // 1. Error state
        if (snap?.error) {
          run.status = 'error';
          run.error = snap.error;
          this.runs.set(cascadeId, run);
          this.notifySettlementToDsh(run);
          break;
        }

        // 2. Pending tool approval in IDE
        if (snap?.pendingApproval) {
          const isNewApproval = run.status !== 'awaiting-approval' || !run.approvalNotified;
          run.status = 'awaiting-approval';
          run.pendingTool = snap.pendingApproval;
          this.runs.set(cascadeId, run);

          if (isNewApproval) {
            run.approvalNotified = true;
            run.resumedNotified = false;
            // Proactively notify caller of approval requirement immediately
            this.notifySettlementToDsh(run);
          }

          // IMPORTANT: Do NOT stop the watcher! Cascade is alive but blocked waiting for user approval.
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }

        // 3. Resumed from awaiting-approval back to running (User approved/rejected in IDE)
        if (run.status === 'awaiting-approval' && !snap?.pendingApproval) {
          run.status = 'running';
          run.pendingTool = undefined;
          run.approvalNotified = false;
          if (!run.resumedNotified) {
            run.resumedNotified = true;
            this.notifyResumedToDsh(run);
          }
          this.runs.set(cascadeId, run);
        }

        // 4. Finished naturally (transcript has done step or isFinished after baseline)
        if (snap?.isFinished && snap.plannerContents.length > 0) {
          run.status = 'done';
          this.runs.set(cascadeId, run);
          this.notifySettlementToDsh(run);
          break;
        }

        // 5. Hub waitForIdle probe
        try {
          const client = await this.getHubClient();
          const remainingSeconds = Math.max(1, Math.min(3, Math.ceil((deadline - Date.now()) / 1000)));
          const resp = await client.waitForIdle(cascadeId, remainingSeconds, IDLE_STABILIZATION_SECONDS);

          const freshSnap = await readCascadeTranscript(brainDir, cascadeId, baseline);
          if (freshSnap?.pendingApproval) {
            const isNewApproval = run.status !== 'awaiting-approval' || !run.approvalNotified;
            run.status = 'awaiting-approval';
            run.pendingTool = freshSnap.pendingApproval;
            this.runs.set(cascadeId, run);
            if (isNewApproval) {
              run.approvalNotified = true;
              run.resumedNotified = false;
              this.notifySettlementToDsh(run);
            }
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          if (freshSnap?.error) {
            run.status = 'error';
            run.error = freshSnap.error;
            this.runs.set(cascadeId, run);
            this.notifySettlementToDsh(run);
            break;
          }
          if (!resp?.timedOut) {
            if (freshSnap?.isFinished || (freshSnap && freshSnap.plannerContents.length > 0)) {
              run.status = 'done';
              run.content = freshSnap.plannerContents.join('\n\n');
              this.runs.set(cascadeId, run);
              this.notifySettlementToDsh(run);
              break;
            }
          }
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }

        // Idle backoff: poll less aggressively while the cascade makes no progress.
        const stepNow = snap?.maxStepIndex ?? -1;
        if (stepNow === lastStepSeen) {
          idleCycles = Math.min(idleCycles + 1, 5);
        } else {
          idleCycles = 0;
          lastStepSeen = stepNow;
        }
        if (idleCycles > 0) {
          await new Promise((r) => setTimeout(r, idleCycles * 1000));
        }
      }

      if (Date.now() >= deadline) {
        const run = this.runs.get(cascadeId);
        if (run && (run.status === 'running' || run.status === 'awaiting-approval')) {
          run.status = 'timeout';
          run.error = `Cascade execution timed out after ${Math.round(watchMs / 1000)}s (lifecycle watcher cap)`;
          this.runs.set(cascadeId, run);
          this.notifySettlementToDsh(run);
        }
      }
    } catch (err) {
      const run = this.runs.get(cascadeId) ?? { cascadeId, status: 'running', startedAt: Date.now() };
      run.status = 'error';
      run.error = err instanceof Error ? err.message : String(err);
      this.runs.set(cascadeId, run);
      this.notifySettlementToDsh(run);
    } finally {
      this.watchers.delete(cascadeId);
      await this.flushMessageQueue(cascadeId);
    }
  }

  /** Flush any messages that were queued while the cascade was actively generating or running. */
  private async flushMessageQueue(cascadeId: string): Promise<void> {
    if (this.disposed) return;
    const queue = this.messageQueues.get(cascadeId);
    if (!queue || queue.length === 0) {
      this.messageQueues.delete(cascadeId);
      return;
    }
    const next = queue.shift()!;
    try {
      const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
      const brainDir = `${appDataDir}/brain`;
      const preSnap = await readCascadeTranscript(brainDir, cascadeId, -1);
      const baselineStepIndex = preSnap?.maxStepIndex ?? -1;

      const client = await this.getHubClient();
      await client.sendMessage(cascadeId, next.content);
      const run = this.runs.get(cascadeId) ?? { cascadeId, status: 'running', startedAt: Date.now() };
      run.status = 'running';
      run.startedAt = Date.now();
      run.baselineStepIndex = baselineStepIndex;
      run.content = undefined;
      run.lastNotifiedTransition = undefined;
      run.approvalNotified = false;
      run.resumedNotified = false;
      if (next.callerAgent) run.callerAgent = next.callerAgent;
      this.runs.set(cascadeId, run);

      // Make sure unified watcher is running
      this.ensureActiveWatcher(cascadeId, next.callerAgent, baselineStepIndex);

      if (next.wait) {
        const timeoutMs =
          typeof next.wait === 'number' && next.wait > 0
            ? next.wait * 1000
            : (this.config.pollTimeoutMs ?? 300_000);
        const res = await this.waitCascadeDetailed(cascadeId, timeoutMs, baselineStepIndex);
        if (res.status === 'error') {
          next.reject(new Error(res.error || 'Antigravity execution failed'));
        } else {
          next.resolve(res.content || '[Antigravity returned no planner output]');
        }
      } else {
        next.resolve(`Queued message sent to ${cascadeId}`);
      }
    } catch (err) {
      next.reject(err);
    } finally {
      if (this.messageQueues.get(cascadeId)?.length) {
        await this.flushMessageQueue(cascadeId);
      }
    }
  }

  async hubDelegate(
    task: string,
    model?: string,
    projectId?: string,
    conversationId?: string,
    background = false,
    callerAgent?: any,
  ): Promise<string> {
    const client = await this.getHubClient();
    const proj = projectId || this.config.projectId || '';
    const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
    const brainDir = `${appDataDir}/brain`;

    let baselineStepIndex = -1;
    if (conversationId) {
      const preSnap = await readCascadeTranscript(brainDir, conversationId, -1);
      baselineStepIndex = preSnap?.maxStepIndex ?? -1;
    }

    if (!conversationId) {
      if (!proj) {
        throw new Error(
          'No project_id available: pass project_id, set config.projectId, or create one with antigravity_create_project.',
        );
      }
      const resolved = await client.resolveModel(model || this.config.defaultModel || DEFAULT_MODEL_ID);
      if (!resolved) {
        throw new Error(`Model "${model || this.config.defaultModel}" not found on hub; call antigravity_list_models for valid ids.`);
      }
      const cascadeId = crypto.randomUUID();
      await client.startCascade({ cascadeId, requestedModel: resolved, projectId: proj });
      conversationId = cascadeId;
      baselineStepIndex = -1;
    }

    const startedAt = Date.now();
    await client.sendMessage(conversationId, task);
    this.runs.set(conversationId, {
      cascadeId: conversationId,
      status: 'running',
      startedAt,
      baselineStepIndex,
      callerAgent,
    });

    // Ensure active watcher is monitoring across entire lifecycle
    this.ensureActiveWatcher(conversationId, callerAgent, baselineStepIndex);

    if (!background) {
      const result = await this.waitCascadeDetailed(conversationId, this.config.pollTimeoutMs ?? 300_000, baselineStepIndex);
      if (result.status === 'awaiting-approval') {
        const tool = result.pendingTool;
        const toolDesc = tool ? `${tool.name} (${tool.action || tool.summary || JSON.stringify(tool.args || {})})` : 'unknown';
        return `[Awaiting Approval in Antigravity IDE]\nTool execution paused waiting for user confirmation: ${toolDesc}\n\nPartial output:\n${result.content}`;
      }
      if (result.status === 'error') {
        const partial = result.content ? `\n\nPartial output before error:\n${result.content}` : '';
        throw new Error(`${result.error || 'Antigravity execution failed'}${partial}`);
      }
      return result.content || '[Antigravity returned no planner output]';
    }

    // Short probe (3 seconds) for background runs to detect immediate fast refusal, error, or early completion
    const probeDeadline = Date.now() + 3000;
    while (Date.now() < probeDeadline) {
      await new Promise((r) => setTimeout(r, 250));
      const snap = await readCascadeTranscript(brainDir, conversationId, baselineStepIndex);
      if (snap && (snap.isFinished || snap.error || snap.pendingApproval)) {
        const status = snap.error ? 'error' : snap.pendingApproval ? 'awaiting-approval' : 'done';
        const run: HubRun = {
          cascadeId: conversationId,
          status,
          startedAt,
          baselineStepIndex,
          callerAgent,
          content: snap.plannerContents.join('\n\n'),
          lastActiveAt: snap.lastActiveAt,
          pendingTool: snap.pendingApproval,
          error: snap.error,
        };
        this.runs.set(conversationId, run);

        return JSON.stringify({
          cascadeId: conversationId,
          status,
          earlySettled: true,
          elapsedMs: Date.now() - startedAt,
          content: run.content || null,
          pendingTool: run.pendingTool || null,
          error: run.error || null,
          note: run.status === 'awaiting-approval'
            ? 'Cascade immediately paused waiting for user approval in Antigravity IDE.'
            : 'Cascade settled during initial probe window.',
        }, null, 2);
      }
    }

    return JSON.stringify({
      cascadeId: conversationId,
      status: 'running',
      startedAt,
      elapsedMs: Date.now() - startedAt,
      note: 'Cascade is actively running in background. A notice will be pushed upon settlement or approval requirement.',
    }, null, 2);
  }

  /** Inspect a background run; wait supports boolean or timeout in seconds. */
  async hubCheckRun(runId: string, wait: boolean | number = false, callerAgent?: any): Promise<unknown> {
    const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
    const brainDir = `${appDataDir}/brain`;
    const existingRun = this.runs.get(runId);
    const startedAt = existingRun?.startedAt ?? Date.now();
    const baselineStepIndex = existingRun?.baselineStepIndex ?? -1;

    // Auto-attach watcher if active but no watcher is currently running
    if (!this.watchers.has(runId)) {
      const snap = await readCascadeTranscript(brainDir, runId, baselineStepIndex);
      if (snap && (snap.pendingApproval || (!snap.isFinished && snap.engaged))) {
        this.ensureActiveWatcher(runId, callerAgent || existingRun?.callerAgent, baselineStepIndex);
      }
    }

    const timeoutMs =
      typeof wait === 'number' && wait > 0
        ? wait * 1000
        : wait === true
        ? (this.config.pollTimeoutMs ?? 300_000)
        : 0;

    if (timeoutMs > 0) {
      const detailed = await this.waitCascadeDetailed(runId, timeoutMs, baselineStepIndex);
      const updatedRun: HubRun = {
        cascadeId: runId,
        status: detailed.status,
        startedAt,
        baselineStepIndex,
        callerAgent: callerAgent || existingRun?.callerAgent,
        lastActiveAt: detailed.lastActiveAt,
        content: detailed.content,
        error: detailed.error,
        pendingTool: detailed.pendingTool,
      };
      this.runs.set(runId, updatedRun);

      return AntigravityService.lossless({
        cascadeId: runId,
        status: detailed.status,
        pendingTool: detailed.pendingTool,
        lastActiveAt: detailed.lastActiveAt,
        elapsedMs: Date.now() - startedAt,
        content: detailed.content || null,
        error: detailed.error || null,
      });
    }

    // Instant snapshot check
    const snap = await readCascadeTranscript(brainDir, runId, baselineStepIndex);
    let status: HubRun['status'] = existingRun?.status ?? 'running';
    if (snap?.error) {
      status = 'error';
    } else if (snap?.pendingApproval) {
      status = 'awaiting-approval';
    } else if (snap?.isFinished || existingRun?.status === 'done') {
      status = 'done';
    } else if (snap?.engaged) {
      status = 'running';
    }

    const updatedRun: HubRun = {
      cascadeId: runId,
      status,
      startedAt,
      baselineStepIndex,
      callerAgent: callerAgent || existingRun?.callerAgent,
      lastActiveAt: snap?.lastActiveAt ?? existingRun?.lastActiveAt,
      content: snap?.plannerContents.join('\n\n') ?? existingRun?.content,
      error: snap?.error ?? existingRun?.error,
      pendingTool: snap?.pendingApproval ?? existingRun?.pendingTool,
    };
    this.runs.set(runId, updatedRun);

    return AntigravityService.lossless({
      cascadeId: runId,
      status,
      pendingTool: updatedRun.pendingTool,
      lastActiveAt: updatedRun.lastActiveAt,
      elapsedMs: Date.now() - startedAt,
      content: updatedRun.content || null,
      error: updatedRun.error || null,
    });
  }

  /** Best-effort confirmation that a sent user message materialized in the cascade transcript. */
  private async confirmMessageDelivered(brainDir: string, cascadeId: string, content: string, timeoutMs = 8000): Promise<boolean> {
    // Probe with a run of plain letters/numbers: they appear verbatim in the JSONL
    // (CJK included), unlike quotes/backslashes/whitespace which get JSON-escaped.
    const probe = (content.match(/[\p{L}\p{N}]{8,}/u)?.[0] ?? '').slice(0, 24);
    if (!probe) return true; // nothing distinctive to probe; skip confirmation
    const file = `${brainDir}/${cascadeId}/.system_generated/logs/transcript.jsonl`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const text = await fsp.readFile(file, 'utf8');
        if (text.includes(probe)) return true;
      } catch {
        // transcript not readable yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  async hubSendMessage(
    conversationId: string,
    content: string,
    wait: boolean | number = true,
    mode: 'step-end' | 'turn-end' | 'interrupt' = 'step-end',
    callerAgent?: any,
  ): Promise<unknown> {
    const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
    const brainDir = `${appDataDir}/brain`;

    let isRunning =
      this.watchers.has(conversationId) ||
      this.runs.get(conversationId)?.status === 'running' ||
      this.runs.get(conversationId)?.status === 'awaiting-approval';

    if (!isRunning) {
      // The registry can be stale (e.g. a watcher that expired while the cascade kept
      // running). Verify against the transcript before taking the idle path — a plain
      // send into an actually-running cascade vanishes hub-side without any error.
      try {
        const snap = await readCascadeTranscript(brainDir, conversationId);
        const lastActive = snap?.lastActiveAt ? Date.parse(snap.lastActiveAt) : 0;
        const recentlyActive = lastActive > 0 && Date.now() - lastActive < 120_000;
        if (snap && !snap.isFinished && !snap.error && (snap.engaged || recentlyActive || snap.pendingApproval)) {
          isRunning = true;
        }
      } catch {
        // fall through: treat as idle
      }
    }

    if (isRunning) {
      if (mode === 'turn-end') {
        // Queue safely until current turn completes naturally
        return new Promise((resolve, reject) => {
          let queue = this.messageQueues.get(conversationId);
          if (!queue) {
            queue = [];
            this.messageQueues.set(conversationId, queue);
          }
          queue.push({ content, wait, mode, callerAgent, resolve, reject });
          if (!wait) {
            resolve(`Message queued for ${conversationId} (turn-end); will be sent automatically when current turn finishes.`);
          }
        });
      }

      const client = await this.getHubClient();

      if (mode === 'step-end') {
        // Step-end insertion: safely wait for currently running tool step to complete
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const snap = await readCascadeTranscript(brainDir, conversationId);
          if (snap?.pendingApproval || snap?.isFinished || !snap?.engaged) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      // Only cancel when genuinely mid-step. Cancelling an IDLE cascade makes the IDE
      // show a spurious "User cancelled agent execution" and the follow-up message
      // vanishes hub-side. (v3.11: root cause of lost mid-run messages.)
      const snapBeforeSend = await readCascadeTranscript(brainDir, conversationId);
      const genuinelyEngaged = !!snapBeforeSend && snapBeforeSend.engaged && !snapBeforeSend.isFinished && !snapBeforeSend.pendingApproval;
      if (genuinelyEngaged) {
        try {
          await client.cancelCascade(conversationId);
        } catch {
          // Ignore cancellation error if already idle
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const preSnap = await readCascadeTranscript(brainDir, conversationId, -1);
      const baselineStepIndex = preSnap?.maxStepIndex ?? -1;

      await client.sendMessage(conversationId, content);
      this.runs.set(conversationId, {
        cascadeId: conversationId,
        status: 'running',
        startedAt: Date.now(),
        baselineStepIndex,
        callerAgent,
      });

      // Ensure active watcher tracks the newly resumed run
      this.ensureActiveWatcher(conversationId, callerAgent, baselineStepIndex);

      if (!wait) {
        let delivered = await this.confirmMessageDelivered(brainDir, conversationId, content);
        if (!delivered) {
          // The cancel+inject sequence raced the hub; retry once as a plain send.
          try {
            await client.sendMessage(conversationId, content);
            delivered = await this.confirmMessageDelivered(brainDir, conversationId, content, 10_000);
          } catch {
            // fall through to failure report
          }
        }
        return delivered
          ? `Message injected into ${conversationId} (${mode}); transcript delivery confirmed.`
          : `DELIVERY FAILED for ${conversationId}: message not visible in transcript after send + plain resend. The cascade may need a fresh conversation or IDE-side nudge.`;
      }

      const timeoutMs =
        typeof wait === 'number' && wait > 0
          ? wait * 1000
          : (this.config.pollTimeoutMs ?? 300_000);
      const result = await this.waitCascadeDetailed(conversationId, timeoutMs, baselineStepIndex);
      if (result.status === 'error') {
        throw new Error(result.error || 'Antigravity execution failed');
      }
      return result.content || '[Antigravity returned no planner output]';
    }

    const preSnap = await readCascadeTranscript(brainDir, conversationId, -1);
    const baselineStepIndex = preSnap?.maxStepIndex ?? -1;

    const client = await this.getHubClient();
    await client.sendMessage(conversationId, content);
    this.runs.set(conversationId, {
      cascadeId: conversationId,
      status: 'running',
      startedAt: Date.now(),
      baselineStepIndex,
      callerAgent,
    });

    // Ensure active watcher tracks the run
    this.ensureActiveWatcher(conversationId, callerAgent, baselineStepIndex);

    if (!wait) {
      let delivered = await this.confirmMessageDelivered(brainDir, conversationId, content);
      if (!delivered) {
        // One retry before reporting failure (hub occasionally drops the first send
        // for conversations in odd states).
        try {
          await client.sendMessage(conversationId, content);
          delivered = await this.confirmMessageDelivered(brainDir, conversationId, content, 10_000);
        } catch {
          // fall through to failure report
        }
      }
      return delivered
        ? `Message sent to ${conversationId}; transcript delivery confirmed.`
        : `DELIVERY FAILED for ${conversationId}: message not visible in transcript after send + resend. The conversation may be in a hub-side dead state; start a fresh cascade.`;
    }

    const timeoutMs =
      typeof wait === 'number' && wait > 0
        ? wait * 1000
        : (this.config.pollTimeoutMs ?? 300_000);
    const result = await this.waitCascadeDetailed(conversationId, timeoutMs, baselineStepIndex);
    if (result.status === 'error') {
      throw new Error(result.error || 'Antigravity execution failed');
    }
    return result.content || '[Antigravity returned no planner output]';
  }

  /**
   * Answer a pending approval in the IDE programmatically (YOLO leaves network/permission
   * prompts blocking; this is the orchestrator-side approval channel).
   * Reads the pending interaction from the live trajectory and answers it via
   * HandleCascadeUserInteraction. confirm=false rejects.
   */
  async hubRespondApproval(cascadeId: string, confirm: boolean, scope?: string): Promise<unknown> {
    const client = await this.getHubClient();
    const traj = (await client.getCascadeTrajectory(cascadeId)) as any;
    const trajectory = traj?.trajectory ?? {};
    const trajectoryId = trajectory.trajectoryId;
    const steps: any[] = trajectory.steps ?? [];
    if (!trajectoryId) throw new Error('GetCascadeTrajectory returned no trajectoryId');

    let pending: { stepIndex: number; ri: any } | undefined;
    for (let i = steps.length - 1; i >= 0; i--) {
      const ri = steps[i]?.requestedInteraction;
      if (ri && Object.keys(ri).length > 0) {
        pending = { stepIndex: i, ri };
        break;
      }
    }
    if (!pending) throw new Error('No pending requestedInteraction in trajectory (nothing to approve)');

    const { stepIndex, ri } = pending;
    const scopeName = scope ?? 'PERMISSION_SCOPE_ONCE';
    let variant: Record<string, unknown>;
    let kind: string;
    if (ri.runCommand) {
      kind = 'run_command';
      const proposed = ri.runCommand.commandLine ?? ri.runCommand.proposedCommandLine ?? '';
      variant = { runCommand: { confirm, proposedCommandLine: proposed, submittedCommandLine: proposed } };
    } else if (ri.readUrlContent) {
      kind = 'read_url_content';
      variant = { readUrlContent: { confirm } };
    } else if (ri.permission) {
      kind = `permission(${ri.permission.resource?.action ?? '?'}:${ri.permission.resource?.target ?? '?'})`;
      variant = { permission: { allow: confirm, scope: scopeName } };
    } else if (ri.filePermission) {
      kind = `file_permission(${ri.filePermission.absolutePathUri ?? '?'})`;
      variant = { filePermission: { allow: confirm, scope: scopeName, absolutePathUri: ri.filePermission.absolutePathUri ?? '' } };
    } else if (ri.approvalInteraction) {
      kind = 'approval_interaction';
      variant = { approvalInteraction: { confirm } };
    } else if (ri.mcp) {
      kind = 'mcp';
      variant = { mcp: { confirm } };
    } else if (ri.openBrowserUrl) {
      kind = 'open_browser_url';
      variant = { openBrowserUrl: { confirm } };
    } else {
      throw new Error(`Unsupported interaction variant; keys present: ${Object.keys(ri).join(', ')}`);
    }

    const resp = await client.handleCascadeUserInteraction(cascadeId, {
      trajectoryId,
      stepIndex,
      ...variant,
    });
    return AntigravityService.lossless({
      cascadeId,
      answered: kind,
      confirm,
      scope: scopeName,
      stepIndex,
      hubResponse: resp ?? {},
    });
  }

  private async waitCascadeDetailed(
    conversationId: string,
    timeoutMs = this.config.pollTimeoutMs ?? 300_000,
    baselineStepIndex = -1,
  ): Promise<CascadeDetailedResult> {
    const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
    const brainDir = `${appDataDir}/brain`;
    const deadline = Date.now() + timeoutMs;

    // Phase 1: engagement guard. Wait until executor produces steps or timeout
    const engageDeadline = Math.min(deadline, Date.now() + 15_000);
    while (Date.now() < engageDeadline) {
      const snap = await readCascadeTranscript(brainDir, conversationId, baselineStepIndex);
      if (snap?.error) {
        return {
          status: 'error',
          content: snap.plannerContents.join('\n\n'),
          lastActiveAt: snap.lastActiveAt,
          error: snap.error,
        };
      }
      if (snap?.pendingApproval) {
        return {
          status: 'awaiting-approval',
          content: snap.plannerContents.join('\n\n'),
          lastActiveAt: snap.lastActiveAt,
          pendingTool: snap.pendingApproval,
        };
      }
      if (snap?.engaged) break;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    // Phase 2: Hub waitForIdle + Transcript status checking
    const client = await this.getHubClient();
    let fallback = false;

    while (Date.now() < deadline) {
      try {
        const remainingSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
        const sliceSeconds = Math.min(30, remainingSeconds);
        const resp = await client.waitForIdle(conversationId, sliceSeconds, IDLE_STABILIZATION_SECONDS);

        const snap = await readCascadeTranscript(brainDir, conversationId, baselineStepIndex);
        if (snap?.error) {
          return {
            status: 'error',
            content: snap.plannerContents.join('\n\n'),
            lastActiveAt: snap.lastActiveAt,
            error: snap.error,
          };
        }
        if (snap?.pendingApproval) {
          return {
            status: 'awaiting-approval',
            content: snap.plannerContents.join('\n\n'),
            lastActiveAt: snap.lastActiveAt,
            pendingTool: snap.pendingApproval,
          };
        }

        if (!resp?.timedOut) {
          if (snap?.isFinished || (snap && snap.plannerContents.length > 0)) {
            return {
              status: 'done',
              content: snap.plannerContents.join('\n\n'),
              lastActiveAt: snap.lastActiveAt,
            };
          }
          break;
        }
      } catch {
        fallback = true;
        break;
      }
    }

    if (fallback) {
      const remainingMs = Math.max(1000, deadline - Date.now());
      const pollRes = await pollTranscript(brainDir, conversationId, remainingMs, 1500, 4000, baselineStepIndex);
      return {
        status: pollRes.status ?? (pollRes.done ? 'done' : 'running'),
        content: pollRes.content,
        lastActiveAt: pollRes.lastActiveAt,
        pendingTool: pollRes.pendingTool,
        error: pollRes.error,
      };
    }

    const finalSnap = await readCascadeTranscript(brainDir, conversationId, baselineStepIndex);
    if (finalSnap?.error) {
      return {
        status: 'error',
        content: finalSnap.plannerContents.join('\n\n'),
        lastActiveAt: finalSnap.lastActiveAt,
        error: finalSnap.error,
      };
    }
    if (finalSnap?.pendingApproval) {
      return {
        status: 'awaiting-approval',
        content: finalSnap.plannerContents.join('\n\n'),
        lastActiveAt: finalSnap.lastActiveAt,
        pendingTool: finalSnap.pendingApproval,
      };
    }
    if (finalSnap?.isFinished) {
      return {
        status: 'done',
        content: finalSnap.plannerContents.join('\n\n'),
        lastActiveAt: finalSnap.lastActiveAt,
      };
    }

    return {
      status: finalSnap?.engaged ? 'running' : 'timeout',
      content: finalSnap?.plannerContents.join('\n\n') ?? '',
      lastActiveAt: finalSnap?.lastActiveAt,
    };
  }

  async hubCreateProject(name: string, folderUri: string): Promise<unknown> {
    const client = await this.getHubClient();
    return client.createProject(name, folderUri);
  }
}

function renderText(_args: unknown, value: unknown) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

export default class AntigravityBridgePlugin {
  static name = 'dsh-antigravity-bridge';
  static Config = Config;
  static inject = ['tools', 'systemPrompt'];

  constructor(ctx: Context, config: AntigravityConfig) {
    ctx.plugin(AntigravityService, config);

    if ((ctx as any).systemPrompt?.register) {
      (ctx as any).systemPrompt.register({
        name: 'antigravity-guide',
        order: 118,
        render: () => `## Google Antigravity Agent Tools
Google Antigravity (AGY) is Google's multi-agent coding harness running locally on this machine. The default backend is "hub": sessions run INSIDE the local Antigravity IDE and burn the IDE's own OAuth quota (not Google Cloud billing).
- 'gemini-3.7-flash-tiered' (default): Gemini quota group (very generous limit), 1M context, fast multimodal; use for general and parallel coding subtasks.
- 'claude-opus-4-6-thinking': non-Gemini quota group (strict limit); deep reasoning for tough challenges.
- 'antigravity_list_models' shows the live model catalog with remaining quota fractions.
- 'antigravity_delegate' runs a task: with conversation_id it continues that conversation; without, it creates a new cascade (needs project_id or config default). Default blocks until the reply stabilizes; background=true returns a run id immediately so you can keep working, then poll with 'antigravity_check_run' (wait=true blocks until done).
- Mid-run steering: 'antigravity_send_message' with wait=false injects guidance into a running conversation.
- 'antigravity_create_project' creates a project (returns projectId).
- 'antigravity_list_conversations' and 'antigravity_get_conversation_tree' browse local session history.
`,
      });
    }

    const tools = (ctx as any).tools;
    if (!tools?.register) return;

    if (config.backend === 'localharness') {
      tools.register({
        name: 'antigravity_delegate',
        description: 'Delegates a task to Antigravity (localharness backend) with optional model selection, session resuming, and multimodal attachments.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Task prompt' },
            model: { type: 'string', description: 'Model alias or ID' },
            conversation_id: { type: 'string', description: 'Conversation UUID to resume' },
            session_continuation_mode: { type: 'string', enum: ['resume', 'create_or_resume', 'create_only'] },
            attachments: { type: 'array', items: { type: 'string' }, description: 'Local file paths to attach' },
          },
          required: ['task'],
        },
        output: { schema: { type: 'string' }, render: renderText },
        execute: async (args: {
          task: string;
          model?: string;
          conversation_id?: string;
          session_continuation_mode?: SessionContinuationMode;
          attachments?: string[];
        }) => {
          return await (ctx.get('antigravity') as AntigravityService).runOneShot(args.task, {
            model: args.model,
            conversationId: args.conversation_id,
            sessionContinuationMode: args.session_continuation_mode,
            attachments: args.attachments,
          });
        },
      });

      tools.register({
        name: 'antigravity_list_models',
        description: 'List supported Antigravity models (static local catalog, localharness backend).',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'array', items: { type: 'object' } }, render: renderText },
        execute: async () => {
          return (ctx.get('antigravity') as AntigravityService).listModels();
        },
      });
    } else {
      tools.register({
        name: 'antigravity_list_models',
        description: 'List models available on the local Antigravity hub with live quota (remainingFraction/resetTime), capabilities, and context sizes.',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' }, render: renderText },
        execute: async () => {
          return await (ctx.get('antigravity') as AntigravityService).hubListModels();
        },
      });

      tools.register({
        name: 'antigravity_delegate',
        description: 'Delegate a task to Google Antigravity via the local hub (burns agy OAuth quota, sessions visible in the IDE). '
          + 'With conversation_id: continues that conversation. Without: creates a new cascade in project_id (or configured default project). '
          + 'Default: waits for the reply by polling the local transcript (timeout 300s). '
          + 'With background=true: returns a run id immediately; poll it with antigravity_check_run.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'The clear, detailed instruction for the Antigravity agent' },
            model: { type: 'string', description: 'Model display id from antigravity_list_models (default: gemini-3.7-flash-tiered)' },
            project_id: { type: 'string', description: 'Target project UUID for new cascades' },
            conversation_id: { type: 'string', description: 'Existing conversation/cascade UUID to continue' },
            background: { type: 'boolean', description: 'Return a run id immediately instead of waiting for the reply (default false)' },
          },
          required: ['task'],
        },
        output: { schema: { type: 'string' }, render: renderText },
        execute: async (
          args: {
            task: string;
            model?: string;
            project_id?: string;
            conversation_id?: string;
            background?: boolean;
          },
          execContext?: any,
        ) => {
          const callerAgent = execContext?.agent;
          return await (ctx.get('antigravity') as AntigravityService).hubDelegate(
            args.task,
            args.model,
            args.project_id,
            args.conversation_id,
            args.background,
            callerAgent,
          );
        },
      });

      tools.register({
        name: 'antigravity_check_run',
        description: 'Check a background antigravity_delegate run (cascade UUID): returns status (running, awaiting-approval, done, error, timeout), elapsed time, last active timestamp, and pending tool approvals. '
          + 'Set wait=true to block until done or timeout (default 300s), or specify seconds (e.g. wait=30).',
        parameters: {
          type: 'object',
          properties: {
            run_id: { type: 'string', description: 'Cascade UUID returned by a background delegate or external conversation' },
            wait: { description: 'Block until done or timeout. Pass true for default timeout (300s), or a number for custom seconds (e.g. 30).' },
          },
          required: ['run_id'],
        },
        output: { schema: { type: 'object' }, render: renderText },
        execute: async (args: { run_id: string; wait?: boolean | number }, execContext?: any) => {
          const callerAgent = execContext?.agent;
          return await (ctx.get('antigravity') as AntigravityService).hubCheckRun(args.run_id, args.wait, callerAgent);
        },
      });

      tools.register({
        name: 'antigravity_send_message',
        description: 'Send a follow-up message/instruction to an existing Antigravity conversation (cascade UUID). '
          + 'Supports mid-run insertion modes: '
          + 'mode="step-end" (default, IDE style: safely interrupts after current tool step ends); '
          + 'mode="turn-end" (queues safely until entire turn finishes); '
          + 'mode="interrupt" (immediately interrupts current step). '
          + 'Optionally waits for the reply (pass true, false, or number in seconds).',
        parameters: {
          type: 'object',
          properties: {
            conversation_id: { type: 'string', description: 'Existing cascade UUID' },
            content: { type: 'string', description: 'Instruction or text to send' },
            wait: { description: 'Wait for the planner reply (default true, or custom seconds like 30, or false to fire-and-forget)' },
            mode: { type: 'string', enum: ['step-end', 'turn-end', 'interrupt'], description: 'Insertion mode when cascade is running (default: step-end)' },
          },
          required: ['conversation_id', 'content'],
        },
        output: { schema: { type: 'string' }, render: renderText },
        execute: async (
          args: {
            conversation_id: string;
            content: string;
            wait?: boolean | number;
            mode?: 'step-end' | 'turn-end' | 'interrupt';
          },
          execContext?: any,
        ) => {
          const callerAgent = execContext?.agent;
          const res = await (ctx.get('antigravity') as AntigravityService).hubSendMessage(
            args.conversation_id,
            args.content,
            args.wait,
            args.mode,
            callerAgent,
          );
          return typeof res === 'string' ? res : JSON.stringify(res, null, 2);
        },
      });

      tools.register({
        name: 'antigravity_respond',
        description: 'Answer a pending Antigravity IDE approval prompt programmatically (orchestrator-side approval channel for when the user is away — e.g. YOLO mode leaves network/permission prompts blocking). '
          + 'Reads the pending interaction from the live cascade trajectory and answers it. confirm=false rejects. '
          + 'scope defaults to PERMISSION_SCOPE_ONCE (options: PERMISSION_SCOPE_ONCE/CONVERSATION/WORKSPACE/PROJECT/GLOBAL).',
        parameters: {
          type: 'object',
          properties: {
            run_id: { type: 'string', description: 'Cascade UUID with a pending approval' },
            confirm: { type: 'boolean', description: 'true = allow/approve, false = reject' },
            scope: { type: 'string', description: 'Permission scope for permission/file_permission interactions (default PERMISSION_SCOPE_ONCE)' },
          },
          required: ['run_id', 'confirm'],
        },
        output: { schema: { type: 'object' }, render: renderText },
        execute: async (args: { run_id: string; confirm: boolean; scope?: string }) => {
          return await (ctx.get('antigravity') as AntigravityService).hubRespondApproval(
            args.run_id,
            args.confirm,
            args.scope,
          );
        },
      });

      tools.register({
        name: 'antigravity_create_project',
        description: 'Create a new Antigravity project rooted at a local folder. Returns the generated projectId for use with antigravity_delegate.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            folder_uri: { type: 'string', description: 'Absolute folder URI, e.g. file:///d:/myproject' },
          },
          required: ['name', 'folder_uri'],
        },
        output: { schema: { type: 'object' }, render: renderText },
        execute: async (args: { name: string; folder_uri: string }) => {
          return await (ctx.get('antigravity') as AntigravityService).hubCreateProject(
            args.name,
            args.folder_uri,
          );
        },
      });
    }

    // Shared tools (backend-agnostic, read local storage)
    tools.register({
      name: 'antigravity_list_conversations',
      description: 'List historical Google Antigravity agent conversations stored locally (~/.gemini/antigravity). '
        + 'By default returns only Root user conversations; supports include_subagents, parent_id, and max_depth filters.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum number of recent conversations (default 10)' },
          only_roots: { type: 'boolean' },
          include_subagents: { type: 'boolean' },
          max_depth: { type: 'number' },
          parent_id: { type: 'string', description: 'Filter to direct children of a parent conversation UUID' },
        },
      },
      output: { schema: { type: 'array', items: { type: 'object' } }, render: renderText },
      execute: async (args: {
        limit?: number;
        only_roots?: boolean;
        include_subagents?: boolean;
        max_depth?: number;
        parent_id?: string;
      }) => {
        return await (ctx.get('antigravity') as AntigravityService).listConversations(args);
      },
    });

    tools.register({
      name: 'antigravity_get_conversation_tree',
      description: 'Visualize the hierarchical multi-agent lineage tree of Google Antigravity sessions (ASCII + JSON).',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string' },
          limit: { type: 'number', description: 'Maximum number of recent root trees (default 5)' },
        },
      },
      output: {
        schema: { type: 'object', properties: { ascii: { type: 'string' }, trees: { type: 'array' } } },
        render: (_args: unknown, value: unknown) => {
          const v = value as { ascii?: string } | undefined;
          return [{ type: 'text', text: v?.ascii ?? JSON.stringify(value, null, 2) }];
        },
      },
      execute: async (args: { conversation_id?: string; limit?: number }) => {
        return await (ctx.get('antigravity') as AntigravityService).getConversationTree(args);
      },
    });
  }
}

export * from './engine.js';
export * from './client.js';
export * from './media.js';
export * from './storage.js';
export * from './models.js';
export * from './hub/client.js';
export * from './hub/discovery.js';
export * from './hub/transcript.js';
