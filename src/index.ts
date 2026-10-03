import { Context, Service, type Volatile } from '@deepseek-ai/cordis';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
import {
  readCascadeTranscript,
  loadTranscriptFile,
  PendingToolApproval,
  decideTailSettle,
  LAUNCH_OBSERVATION_GRACE_MS,
  pruneStaleBackgroundTasks,
  parseStructuredTrajectoryTasks,
  readStructuredTasksFromSqlite,
  type TranscriptSnapshot,
  type AutoContinueReason,
  type ActiveBackgroundTask,
  type StructuredCascadeTasksResult,
} from './hub/transcript.js';
import {
  classifyError,
  isTransientRetryableError,
  isAuthTokenExpiredError,
  getAutoResumeBackoffMs,
  getMaxRetriesForSignature,
  formatExhaustedRetryError,
  formatAuthExpiredTerminalError,
  TransientErrorSignature,
  ErrorClassification,
} from './hub/classifier.js';

export interface AutoResumeConfig {
  /** Automatically resume cascade on transient errors (default true). */
  enabled?: boolean;
  /** Maximum consecutive auto-resume retries per cascade (default 3). */
  maxRetries?: number;
  /** Instruction sent to the cascade when resuming (default "继续。按原计划继续执行当前任务，不要停止。"). */
  message?: string;
}

/** Default budget of tail-guard auto-"Continue" nudges per turn. */
export const DEFAULT_AUTO_CONTINUE_MAX = 5;
/** Default message sent by the tail-guard auto-continue. */
export const DEFAULT_AUTO_CONTINUE_MESSAGE = 'Continue';
/** Stillness (ms) required before a stalled tail may be nudged with "Continue". */
export const AUTO_CONTINUE_QUIET_MS = 10_000;
/** Stillness (ms) required before a final-looking assistant reply may enter two-phase settle confirmation (minimum 15s). */
export const SETTLE_STABLE_MS = 15_000;
/** Minimum interval (ms) required between first-round settle candidate snapshot and second-round fresh confirmation query (10s). */
export const SETTLE_CONFIRMATION_INTERVAL_MS = 10_000;
/** Default absolute cap on background lifecycle watcher in ms (12h). */
export const DEFAULT_WATCH_MAX_MS = 43_200_000;
/**
 * Max consecutive settlement/approval notices that may WAKE one agent without
 * an intervening model-authored tool call against an existing lane. Bounds the
 * self-excitation loop "cascade done → wake → model delegates again → done →
 * wake". An idle caller is still woken past the cap (see
 * `AntigravityService.deliverMessageToAgent`): the budget throttles, it never
 * silently discards an undelivered notice.
 */
export const MAX_CONSECUTIVE_NOTICE_WAKES = 5;
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
  /** Inline character budget for tool-result report bodies; longer reports are persisted and referenced by path. */
  inlineCharBudget?: number;
  /** true (default): bridge-created cascades appear in the IDE sidebar (agy ≥ 2.9.1 requires trajectory source UNSPECIFIED). */
  sidebarVisible?: boolean;
  /** Grace window (ms) for YOLO auto-approval before an awaiting-approval notice is pushed (default 3000). */
  approvalGraceMs?: number;
  /** Transient error auto-resume configuration. */
  autoResume?: AutoResumeConfig;
  /** Inactivity timeout (ms) for a mid-turn running cascade before triggering stall recovery (default 120_000, 2m).
   *  When no new steps or heartbeats arrive for this duration, the bridge treats it as a network error / stalled stream
   *  and sends an auto-resume nudge up to autoResume.maxRetries. */
  stallTimeoutMs?: number;
  /** Max consecutive auto-"Continue" nudges per turn when the transcript tail shows the turn is not
   *  really finished (tool tail / no assistant text); 0 disables nudging and settles after the quiet
   *  window with autoContinueExhausted flagged (default 5). */
  autoContinueMax?: number;
  /** Message sent to the cascade for each tail-guard auto-continue (default "Continue"). */
  autoContinueMessage?: string;
}

// NOTE: intentionally unannotated (sibling-vertex-bridge style). Direct-call
// parse output carries Volatile boxes (schemastery wraps volatile fields on
// resolve); the plain-values contract for Loader delivery is LiveAntigravityConfig.
export const Config = Schema.object({
  backend: Schema.union(['hub', 'localharness'])
    .default('hub')
    .description('Backend: hub = local Antigravity IDE gRPC (agy quota), localharness = standalone SDK binary (API key)')
    .volatile(),
  binaryPath: Schema.string().description('Path to localharness.exe binary (localharness backend only)').volatile(),
  protoDir: Schema.string().description('Path to proto directory (localharness backend only)').volatile(),
  defaultModel: Schema.string().default(DEFAULT_MODEL_ID).description('Default model display id').volatile(),
  appDataDir: Schema.string().description('Custom Antigravity app data directory').volatile(),
  projectId: Schema.string().description('Default Antigravity project id for new conversations').volatile(),
  hubAddress: Schema.string().description('Override hub address (e.g. 127.0.0.1:7778); skips discovery when both overrides are set').volatile(),
  hubCsrfToken: Schema.string().description('Override hub CSRF token').volatile(),
  pollTimeoutMs: Schema.number().default(300_000).description('Settlement-wait timeout in ms (sync delegate replies and check_run wait=true)').volatile(),
  watchMaxMs: Schema.number().default(43_200_000).description('Background lifecycle watcher absolute cap in ms (default 12h); settlement watching never expires before this').volatile(),
  inlineCharBudget: Schema.number().default(4_000).description('Inline character budget for report bodies; longer reports are persisted to a file and referenced by path (default 4000)').volatile(),
  sidebarVisible: Schema.boolean().default(true).description('Show bridge-created cascades in the Antigravity IDE sidebar (agy >= 2.9.1 hides source=CASCADE_CLIENT sessions; uses JETBOX which the hub accepts and the frontend treats as local); false keeps them external/search-only').volatile(),
  approvalGraceMs: Schema.number().default(3_000).description('Grace window in ms for IDE YOLO auto-approval before pushing an awaiting-approval notice (default 3000)').volatile(),
  autoResume: Schema.object({
    enabled: Schema.boolean().default(true).description('Automatically resume cascade on transient errors (default true)'),
    maxRetries: Schema.number().default(3).description('Maximum consecutive auto-resume retries per cascade (default 3)'),
    message: Schema.string().default('继续。按原计划继续执行当前任务，不要停止。').description('Resume prompt message sent to the cascade'),
  }).default({
    enabled: true,
    maxRetries: 3,
    message: '继续。按原计划继续执行当前任务，不要停止。',
  }).description('Transient error auto-resume configuration').volatile(),
  autoContinueMax: Schema.number().default(DEFAULT_AUTO_CONTINUE_MAX).description('Max consecutive auto-"Continue" nudges per turn when the transcript tail shows unfinished work (tool tail / no assistant text); 0 disables nudging (default 5)').volatile(),
  autoContinueMessage: Schema.string().default(DEFAULT_AUTO_CONTINUE_MESSAGE).description('Message sent to the cascade for each tail-guard auto-continue (default "Continue")').volatile(),
  stallTimeoutMs: Schema.number().default(120_000).description('Inactivity timeout in ms for mid-turn running cascade before triggering stall recovery (default 120000, 2m)').volatile(),
});

/** Live volatile references delivered by the Loader; snapshot into {@link AntigravityConfig} to read. */
export interface LiveAntigravityConfig {
  backend: Volatile<'hub' | 'localharness'>;
  binaryPath: Volatile<string | undefined>;
  protoDir: Volatile<string | undefined>;
  defaultModel: Volatile<string>;
  appDataDir: Volatile<string | undefined>;
  projectId: Volatile<string | undefined>;
  hubAddress: Volatile<string | undefined>;
  hubCsrfToken: Volatile<string | undefined>;
  pollTimeoutMs: Volatile<number>;
  watchMaxMs: Volatile<number>;
  inlineCharBudget: Volatile<number>;
  sidebarVisible: Volatile<boolean>;
  approvalGraceMs: Volatile<number>;
  autoResume: Volatile<AutoResumeConfig>;
  autoContinueMax: Volatile<number>;
  autoContinueMessage: Volatile<string>;
  stallTimeoutMs: Volatile<number>;
}

/** Snapshot the live volatile references into plain values. The Loader commits Settings form edits into the running references and emits `loader/volatile-update`; `get()` reads the just-committed value. */
export function snapshotAntigravityConfig(live: LiveAntigravityConfig): AntigravityConfig {
  return {
    backend: live.backend.get(),
    binaryPath: live.binaryPath.get(),
    protoDir: live.protoDir.get(),
    defaultModel: live.defaultModel.get(),
    appDataDir: live.appDataDir.get(),
    projectId: live.projectId.get(),
    hubAddress: live.hubAddress.get(),
    hubCsrfToken: live.hubCsrfToken.get(),
    pollTimeoutMs: live.pollTimeoutMs.get(),
    watchMaxMs: live.watchMaxMs.get(),
    inlineCharBudget: live.inlineCharBudget.get(),
    sidebarVisible: live.sidebarVisible.get(),
    approvalGraceMs: live.approvalGraceMs.get(),
    autoResume: live.autoResume.get(),
    autoContinueMax: live.autoContinueMax.get(),
    autoContinueMessage: live.autoContinueMessage.get(),
    stallTimeoutMs: live.stallTimeoutMs.get(),
  };
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    antigravity: AntigravityService;
  }
  interface Events {
    /**
     * Volatile config values were committed into the running fiber without a
     * remount; dispatched to the owning fiber only.
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
  }
}

export interface RunOneShotOptions extends AgentInitConfig {
  attachments?: string[];
}

/** Live state of one background hub delegation, keyed by cascade id. */
export interface HubRun {
  cascadeId: string;
  status: 'running' | 'done' | 'error' | 'awaiting-approval' | 'timeout' | 'waiting-background';
  startedAt: number;
  baselineStepIndex?: number;
  callerAgent?: any;
  callerAgentId?: string;
  lastActiveAt?: string;
  content?: string;
  error?: string;
  pendingTool?: PendingToolApproval;
  approvalNotified?: boolean;
  resumedNotified?: boolean;
  lastNotifiedTransition?: string;
  /** Turn index when the resumption notice was last delivered to DSH. */
  lastResumedNotifiedTurn?: number;
  /** 1-based user-turn counter; bumped on every new delegation or injected message into this cascade. */
  turnSeq?: number;
  /** Final planner text of completed prior turns; keeps history reachable after baseline resets. */
  priorContents?: string[];
  /** Locator (spill ref or file path) of the persisted full report for the latest settled turn. */
  reportPath?: string;
  /** Character length of the full accumulated report that reportPath covers. */
  reportChars?: number;
  /** Consecutive auto-resume retry count for transient errors in the current turn/streak. */
  autoResumeRetries?: number;
  /** Auto-"Continue" nudges already sent for the current turn's tail-guard stalls. */
  autoContinueCount?: number;
  /** True once the tail-guard nudge budget was exhausted (or delivery failed) and the run settled anyway. */
  autoContinueExhausted?: boolean;
  /** Reason the last tail-guard nudge was sent ('tool-tail' | 'no-assistant-text'). */
  lastAutoContinueReason?: AutoContinueReason;
  /** Timestamp when the 5-minute waiting-background warning notice was last sent. */
  lastBackgroundWarningAt?: number;
  /** Timestamp when the current waiting-background episode began. */
  waitingBackgroundStartedAt?: number;
  /** R1: The maxStepIndex at which the cascade was settled as done; used by resident watcher to detect growth. */
  settledStepIndex?: number;
  /** R1: Content hash of planner output when cascade was settled as done. */
  settledContentHash?: string;
  /** Silenced tasks by normalized task id (e.g. 'task-114' or 'cascadeId/task-114'). */
  silencedTasks?: Record<string, TaskSilenceEntry>;
  /** Residual background task IDs that were alive (infinitely silenced) when cascade settled. */
  residualBackgroundTasks?: string[];
  /** Two-phase settlement confirmation snapshot (Round 1). */
  settleCandidateSnapshot?: {
    stepIndex: number;
    transcriptHash: string;
    firstSeenAt: number;
  };
}

export function computeTranscriptHash(snap: TranscriptSnapshot | undefined): string {
  if (!snap) return '';
  const hash = crypto.createHash('sha256');
  hash.update(String(snap.maxStepIndex));
  hash.update(':');
  hash.update(snap.lastActiveAt ?? '');
  hash.update(':');
  hash.update(snap.plannerContents.join('\n\n'));
  hash.update(':');
  hash.update(snap.tailKind);
  return hash.digest('hex');
}

export interface TaskSilenceEntry {
  taskId: string;
  infinite: boolean;
  until?: number;
  silencedAt: number;
}

export interface SettlementOutboxItem {
  id: string;
  cascadeId: string;
  turnSeq: number;
  transitionKey: string;
  summary: string;
  noticeText: string;
  callerAgentId?: string;
  enqueuedAt: number;
  lastAttemptAt?: number;
  attempts: number;
}

export interface PersistedRun {
  cascadeId: string;
  status: 'running' | 'done' | 'error' | 'awaiting-approval' | 'timeout' | 'waiting-background';
  startedAt: number;
  baselineStepIndex?: number;
  callerAgentId?: string;
  lastActiveAt?: string;
  content?: string;
  error?: string;
  pendingTool?: PendingToolApproval;
  approvalNotified?: boolean;
  resumedNotified?: boolean;
  lastNotifiedTransition?: string;
  lastResumedNotifiedTurn?: number;
  turnSeq?: number;
  priorContents?: string[];
  reportPath?: string;
  reportChars?: number;
  autoResumeRetries?: number;
  autoContinueCount?: number;
  autoContinueExhausted?: boolean;
  lastAutoContinueReason?: AutoContinueReason;
  lastBackgroundWarningAt?: number;
  /** Timestamp when the current waiting-background episode began. */
  waitingBackgroundStartedAt?: number;
  /** R1: The maxStepIndex at which the cascade was settled as done. */
  settledStepIndex?: number;
  /** R1: Content hash of planner output when cascade was settled as done. */
  settledContentHash?: string;
  /** Silenced tasks by normalized task id. */
  silencedTasks?: Record<string, TaskSilenceEntry>;
  /** Residual background task IDs that were alive (infinitely silenced) when cascade settled. */
  residualBackgroundTasks?: string[];
  /** Two-phase settlement confirmation snapshot (Round 1). */
  settleCandidateSnapshot?: {
    stepIndex: number;
    transcriptHash: string;
    firstSeenAt: number;
  };
}

export interface PersistedQueuedMessage {
  content: string;
  wait?: boolean | number;
  mode?: 'step-end' | 'turn-end' | 'interrupt';
  callerAgentId?: string;
  enqueuedAt: number;
}

export interface PersistedBridgeState {
  version: 1;
  savedAt: string;
  runs: Record<string, PersistedRun>;
  messageQueues: Record<string, PersistedQueuedMessage[]>;
  settlementOutbox: SettlementOutboxItem[];
}

export interface CascadeDetailedResult {
  status: 'done' | 'awaiting-approval' | 'running' | 'timeout' | 'error' | 'waiting-background';
  content: string;
  lastActiveAt?: string;
  pendingTool?: PendingToolApproval;
  error?: string;
  /** Auto-"Continue" nudges spent on the current turn. */
  autoContinueCount?: number;
  /** True when the tail guard burned the whole nudge budget and the run settled anyway. */
  autoContinueExhausted?: boolean;
  /** Active (uncompleted) background tasks discovered in the transcript. */
  activeBackgroundTasks?: ActiveBackgroundTask[];
  /** Residual background tasks running (infinitely silenced) when settled. */
  residualBackgroundTasks?: string[];
}

export interface SettlementNoticePayload {
  summary: string;
  noticeText: string;
  isRefusalOrEarlyDeath: boolean;
}

export function buildSettlementNotice(run: HubRun): SettlementNoticePayload {
  const elapsedSec = Math.max(1, Math.round((Date.now() - run.startedAt) / 1000));
  const content = (run.content || '').trim();
  const reportLine = run.reportPath
    ? `\n- **Full report** (${run.reportChars ?? content.length} chars): ${run.reportPath}`
    : '';

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
    // The notice is model-visible context: cap oversized tool args and keep the
    // complete value reachable through check_run instead.
    const argsJson = pt?.args ? JSON.stringify(pt.args, null, 2) : '{}';
    const argsCap = 1500;
    const argsStr = argsJson.length > argsCap ? `${argsJson.slice(0, argsCap)}\n…(args truncated; full value via antigravity_check_run)` : argsJson;
    detail = `Tool: **${pt?.name || 'unknown'}**\nAction: ${pt?.action || pt?.summary || 'N/A'}\nArgs:\n\`\`\`json\n${argsStr}\n\`\`\`\n\n> ⚠️ Antigravity IDE 正在等待用户点击授权弹窗，请前往 IDE 操作。`;
  } else if (run.status === 'error') {
    emoji = '❌';
    label = 'Execution Error';
    detail = `Error: ${run.error || 'Unknown error'}${reportLine}`;
  } else if (run.status === 'waiting-background') {
    emoji = '⏳';
    label = 'Waiting for Background Task';
    detail = `⏳ **Cascade 正在等待后台任务完成**\n- 已运行: ${elapsedSec}s${reportLine}\n> 后台任务仍在执行中，未到达真正完成状态。后台任务完成后 hub 将自动唤醒会话并继续/结算。`;
  } else if (run.status === 'timeout') {
    emoji = '⏱️';
    label = 'Execution Timed Out';
    detail = `⏱️ **Cascade 超过轮询时限未完成（超时）**\n\n- 最后活跃时间: ${run.lastActiveAt || '无'}${reportLine}\n- 当前输出片段:\n> ${content.slice(0, 400) || '(暂无输出)'}`;
  } else if (isEarlyDeath || isRefusal) {
    emoji = '⚠️';
    label = 'Early Termination / Model Refusal';
    detail = `⚠️ **Cascade 在 ${elapsedSec} 秒内异常结束/拒答**：\n\n> ${content.slice(0, 500) || '(无输出内容)'}`;
  } else {
    emoji = '✅';
    label = 'Completed Successfully';
    detail = `耗时: ${elapsedSec}s${reportLine}\n\n摘要:\n${content.slice(0, 400)}${content.length > 400 ? `...(共 ${content.length} 字符，全文见上方路径)` : ''}`;
  }

  if (run.residualBackgroundTasks && run.residualBackgroundTasks.length > 0) {
    detail += `\n\n> ⚠️ **静默后台任务残留警告**: 有静默后台任务仍在运行中，id=${run.residualBackgroundTasks.join(',')}，请适时通知该车道终止任务。`;
  }

  if (run.autoContinueExhausted) {
    detail += `\n\n> ⚠️ **autoContinueExhausted**: 连续 ${run.autoContinueCount ?? 0} 次自动 "Continue" 后 transcript 尾部仍是工具消息/无文本回复，已达上限并按当前状态结算 — 请核实任务是否真正完成（可用 antigravity_check_run 再查）。`;
  }

  const summary = `${emoji} [Antigravity] ${run.cascadeId.slice(0, 8)} ${label}`;
  const residualIdsStr = run.residualBackgroundTasks && run.residualBackgroundTasks.length > 0
    ? run.residualBackgroundTasks.join(',')
    : 'none';
  const noticeText = `### ${emoji} Antigravity Cascade ${label}\n- **Cascade ID**: \`${run.cascadeId}\`\n- **Status**: \`${run.status}\`\n- **Elapsed**: ${elapsedSec}s\n- **Settled Step Index**: \`${run.settledStepIndex ?? 'N/A'}\`\n- **Active Background Tasks**: ${run.residualBackgroundTasks?.length ?? 0}\n- **Residual Background Task IDs**: \`${residualIdsStr}\`\n\n${detail}`;

  return { summary, noticeText, isRefusalOrEarlyDeath: isEarlyDeath || isRefusal };
}

interface QueuedMessage {
  content: string;
  wait: boolean | number;
  mode?: 'step-end' | 'turn-end' | 'interrupt';
  callerAgent?: any;
  callerAgentId?: string;
  enqueuedAt?: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** One check_run-style caller blocked on the cascade watcher's next state transition. */
interface SettlementWaiter {
  done: boolean;
  finish: (result: CascadeDetailedResult) => void;
}

export class AntigravityService extends Service {
  private engine: AntigravityEngine;
  private config: AntigravityConfig;
  private hubClient?: HubClient;
  private runs = new Map<string, HubRun>();
  private watchers = new Map<string, Promise<void>>();
  private messageQueues = new Map<string, QueuedMessage[]>();
  /** Callers parked inside waitForSettlement, keyed by cascade id; resolved by the watcher's transitions. */
  private settlementWaiters = new Map<string, SettlementWaiter[]>();
  private settlementOutbox: SettlementOutboxItem[] = [];
  private outboxTimer?: NodeJS.Timeout;
  private saveStateTimer?: NodeJS.Timeout;
  stateInitPromise?: Promise<void>;
  private globalTaskSilences = new Map<string, TaskSilenceEntry>();
  /**
   * Consecutive notice-driven wakes per caller agent id. Bounds the
   * self-excitation loop "cascade done → wake the model → model launches another
   * cascade → done → wake again". Refunded by {@link noteModelActivity} when the
   * model itself drives an existing lane.
   */
  private noticeWakeCount = new Map<string, number>();
  private trajectoryTaskCache = new Map<
    string,
    {
      lastFetchedAt: number;
      lastMaxStepIndex: number;
      result: StructuredCascadeTasksResult;
    }
  >();
  private disposed = false;

  constructor(ctx: Context, config: AntigravityConfig) {
    super(ctx, 'antigravity');
    this.config = config;
    this.engine = new AntigravityEngine({
      binaryPath: config.binaryPath,
      protoDir: config.protoDir,
      appDataDir: config.appDataDir,
    });
    this.startOutboxTimer();

    // Hook lifecycle ready and agents injection to rebind restored runs to live agents
    const rebind = () => {
      this.rebindAgents().catch(() => {});
    };
    if (typeof (ctx as any).on === 'function') {
      try {
        (ctx as any).on('ready', rebind);
      } catch {
        // ignore
      }
    }
    if (typeof (ctx as any).inject === 'function') {
      try {
        (ctx as any).inject(['agents'] as any, rebind);
      } catch {
        // ignore
      }
    }

    this.stateInitPromise = this.initState().catch((err) => {
      console.warn('[antigravity] Failed to restore bridge state:', err);
    });
    ctx.effect(() => () => {
      this.disposed = true;
      if (this.outboxTimer) {
        clearInterval(this.outboxTimer);
        this.outboxTimer = undefined;
      }
      if (this.saveStateTimer) {
        clearTimeout(this.saveStateTimer);
        this.saveStateTimer = undefined;
      }
      this.saveStateNow().catch(() => {});
      // Release parked waiters so no tool call outlives the service.
      for (const waiters of this.settlementWaiters.values()) {
        for (const waiter of waiters) waiter.finish({ status: 'error', content: '', error: 'antigravity bridge service disposed' });
      }
      this.settlementWaiters.clear();
    });
  }

  getAgentsService(): any {
    try {
      if (typeof (this.ctx as any).get === 'function') {
        const svc = (this.ctx as any).get('agents', false) ?? (this.ctx as any).get('agents');
        if (svc) return svc;
      }
      return (this.ctx as any).agents;
    } catch {
      return undefined;
    }
  }

  findLiveAgent(agentId?: string): any {
    if (!agentId) return undefined;
    try {
      const agentsService = this.getAgentsService();
      const liveAgents = agentsService?.list?.() || [];
      return liveAgents.find(
        (ag: any) =>
          ag?.id === agentId ||
          ag?.session?.header?.id === agentId ||
          ag?.name === agentId,
      );
    } catch {
      return undefined;
    }
  }

  async rebindAgents(): Promise<void> {
    if (this.disposed) return;
    if (this.stateInitPromise) {
      try {
        await this.stateInitPromise;
      } catch {
        // ignore
      }
    }
    for (const run of this.runs.values()) {
      if (run.callerAgentId && (!run.callerAgent || run.callerAgent.disposed)) {
        const found = this.findLiveAgent(run.callerAgentId);
        if (found) {
          run.callerAgent = found;
        }
      }
    }
    if (this.settlementOutbox.length > 0) {
      this.retrySettlementOutbox();
    }
  }

  private getStateFilePath(): string {
    const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
    return path.join(appDataDir, 'dsh-antigravity-bridge', 'state.json');
  }

  private shouldPersist(): boolean {
    if (process.env.VITEST && !this.config.appDataDir) {
      return false;
    }
    return true;
  }

  saveStateDebounced(): void {
    if (this.disposed || !this.shouldPersist()) return;
    if (this.saveStateTimer) clearTimeout(this.saveStateTimer);
    this.saveStateTimer = setTimeout(() => {
      this.saveStateNow().catch(() => {});
    }, 300);
    if (this.saveStateTimer && typeof this.saveStateTimer.unref === 'function') {
      this.saveStateTimer.unref();
    }
  }

  async saveStateNow(): Promise<void> {
    if (this.disposed || !this.shouldPersist()) return;
    try {
      const stateFile = this.getStateFilePath();
      const dir = path.dirname(stateFile);
      await fsp.mkdir(dir, { recursive: true });

      const runsObj: Record<string, PersistedRun> = {};
      for (const [id, run] of this.runs.entries()) {
        const callerAgentId =
          run.callerAgentId ??
          run.callerAgent?.id ??
          run.callerAgent?.session?.header?.id ??
          run.callerAgent?.name;

        runsObj[id] = {
          cascadeId: run.cascadeId,
          status: run.status,
          startedAt: run.startedAt,
          baselineStepIndex: run.baselineStepIndex,
          callerAgentId: callerAgentId ? String(callerAgentId) : undefined,
          lastActiveAt: run.lastActiveAt,
          content: run.content,
          error: run.error,
          pendingTool: run.pendingTool,
          approvalNotified: run.approvalNotified,
          resumedNotified: run.resumedNotified,
          lastNotifiedTransition: run.lastNotifiedTransition,
          lastResumedNotifiedTurn: run.lastResumedNotifiedTurn,
          turnSeq: run.turnSeq,
          priorContents: run.priorContents,
          reportPath: run.reportPath,
          reportChars: run.reportChars,
          autoResumeRetries: run.autoResumeRetries,
          autoContinueCount: run.autoContinueCount,
          autoContinueExhausted: run.autoContinueExhausted,
          lastAutoContinueReason: run.lastAutoContinueReason,
          lastBackgroundWarningAt: run.lastBackgroundWarningAt,
          waitingBackgroundStartedAt: run.waitingBackgroundStartedAt,
          settledStepIndex: run.settledStepIndex,
          settledContentHash: run.settledContentHash,
          silencedTasks: run.silencedTasks,
          residualBackgroundTasks: run.residualBackgroundTasks,
        };
      }

      const queuesObj: Record<string, PersistedQueuedMessage[]> = {};
      for (const [id, queue] of this.messageQueues.entries()) {
        if (queue && queue.length > 0) {
          queuesObj[id] = queue.map((q) => ({
            content: q.content,
            wait: q.wait,
            mode: q.mode,
            callerAgentId:
              q.callerAgentId ??
              q.callerAgent?.id ??
              q.callerAgent?.session?.header?.id ??
              q.callerAgent?.name,
            enqueuedAt: q.enqueuedAt ?? Date.now(),
          }));
        }
      }

      const state: PersistedBridgeState = {
        version: 1,
        savedAt: new Date().toISOString(),
        runs: runsObj,
        messageQueues: queuesObj,
        settlementOutbox: this.settlementOutbox,
      };

      const tmpFile = `${stateFile}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
      await fsp.writeFile(tmpFile, JSON.stringify(state, null, 2), 'utf8');
      try {
        await fsp.rename(tmpFile, stateFile);
      } catch {
        await fsp.copyFile(tmpFile, stateFile);
        await fsp.unlink(tmpFile).catch(() => {});
      }
    } catch {
      // Best-effort state persistence
    }
  }

  private async initState(): Promise<void> {
    if (!this.shouldPersist()) return;
    const stateFile = this.getStateFilePath();
    let raw: string;
    try {
      raw = await fsp.readFile(stateFile, 'utf8');
    } catch {
      return;
    }

    let state: PersistedBridgeState;
    try {
      state = JSON.parse(raw);
    } catch (err) {
      console.warn(`[antigravity] Corrupted state file at ${stateFile}, ignoring:`, err);
      return;
    }

    if (Array.isArray(state.settlementOutbox)) {
      this.settlementOutbox = state.settlementOutbox;
    }

    const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
    const brainDir = path.join(appDataDir, 'brain');

    if (state.runs && typeof state.runs === 'object') {
      for (const [id, prun] of Object.entries(state.runs)) {
        let matchedAgent: any;
        if (prun.callerAgentId) {
          matchedAgent = this.findLiveAgent(prun.callerAgentId);
        }

        const run: HubRun = {
          cascadeId: prun.cascadeId || id,
          status: prun.status,
          startedAt: prun.startedAt,
          baselineStepIndex: prun.baselineStepIndex,
          callerAgent: matchedAgent,
          callerAgentId: prun.callerAgentId,
          lastActiveAt: prun.lastActiveAt,
          content: prun.content,
          error: prun.error,
          pendingTool: prun.pendingTool,
          approvalNotified: prun.approvalNotified,
          resumedNotified: prun.resumedNotified,
          lastNotifiedTransition: prun.lastNotifiedTransition,
          lastResumedNotifiedTurn: prun.lastResumedNotifiedTurn,
          turnSeq: prun.turnSeq,
          priorContents: prun.priorContents,
          reportPath: prun.reportPath,
          reportChars: prun.reportChars,
          autoResumeRetries: prun.autoResumeRetries,
          autoContinueCount: prun.autoContinueCount,
          autoContinueExhausted: prun.autoContinueExhausted,
          lastAutoContinueReason: prun.lastAutoContinueReason,
          lastBackgroundWarningAt: prun.lastBackgroundWarningAt,
          waitingBackgroundStartedAt: prun.waitingBackgroundStartedAt,
          settledStepIndex: prun.settledStepIndex,
          settledContentHash: prun.settledContentHash,
          silencedTasks: prun.silencedTasks,
          residualBackgroundTasks: prun.residualBackgroundTasks,
        };
        if (prun.silencedTasks) {
          for (const [tid, entry] of Object.entries(prun.silencedTasks)) {
            this.globalTaskSilences.set(tid, entry);
          }
        }
        this.runs.set(id, run);
      }
    }

    if (state.messageQueues && typeof state.messageQueues === 'object') {
      for (const [id, pqueue] of Object.entries(state.messageQueues)) {
        if (Array.isArray(pqueue) && pqueue.length > 0) {
          const queue: QueuedMessage[] = pqueue.map((item) => ({
            content: item.content,
            wait: item.wait ?? false,
            mode: item.mode,
            callerAgentId: item.callerAgentId,
            enqueuedAt: item.enqueuedAt,
            resolve: (val) => {
              console.log(`[antigravity] Restored queued message for ${id} resolved:`, val);
            },
            reject: (err) => {
              console.warn(`[antigravity] Restored queued message for ${id} rejected:`, err);
            },
          }));
          this.messageQueues.set(id, queue);
        }
      }
    }

    for (const [cascadeId, run] of Array.from(this.runs.entries())) {
      if (run.status === 'running' || run.status === 'awaiting-approval' || run.status === 'waiting-background') {
        try {
          const snap = await readCascadeTranscript(brainDir, cascadeId, run.baselineStepIndex ?? -1);
          const hasActiveTasks = Boolean(
            (snap?.activeBackgroundTasks && snap.activeBackgroundTasks.length > 0) ||
            snap?.hasActiveChildren,
          );

          if (snap && ((snap.isFinished && !hasActiveTasks) || snap.error)) {
            console.log(
              `[antigravity] Cascade ${cascadeId} settled during downtime (isFinished=${snap.isFinished}, error=${!!snap.error})`,
            );
            run.waitingBackgroundStartedAt = undefined;
            if (snap.error) {
              run.status = 'error';
              run.error = snap.error;
            } else {
              run.status = 'done';
              run.settledStepIndex = snap.maxStepIndex;
              if (snap.plannerContents && snap.plannerContents.length > 0) {
                run.content = snap.plannerContents.join('\n\n');
                run.settledContentHash = crypto
                  .createHash('sha256')
                  .update(run.content)
                  .digest('hex');
              }
            }
            await this.landReport(run);
            this.notifySettlementToDsh(run);

            const queue = this.messageQueues.get(cascadeId);
            if (queue && queue.length > 0) {
              if (run.status === 'done') {
                console.log(
                  `[antigravity] Flushing orphan message queue (${queue.length} item(s)) for finished cascade ${cascadeId}`,
                );
                await this.flushMessageQueue(cascadeId);
              } else {
                console.warn(
                  `[antigravity] Cascade ${cascadeId} in error status; marking ${queue.length} orphan queued message(s) as invalid`,
                );
                for (const item of queue) {
                  item.reject(new Error(`Cascade ${cascadeId} failed during restart; queued message cancelled.`));
                }
                this.messageQueues.delete(cascadeId);
              }
            }

            // R1: If settled as done, keep done-resident watcher running if within watchMaxMs window
            if (run.status === 'done') {
              const watchMaxMs = this.config.watchMaxMs ?? DEFAULT_WATCH_MAX_MS;
              const elapsed = Date.now() - run.startedAt;
              if (elapsed < watchMaxMs) {
                this.ensureActiveWatcher(cascadeId, run.callerAgent, run.baselineStepIndex);
              }
            }
          } else if (run.status === 'waiting-background' && !hasActiveTasks) {
            console.log(
              `[antigravity] Cascade ${cascadeId} was waiting-background but has no active tasks on startup; resetting to running`,
            );
            run.status = 'running';
            run.waitingBackgroundStartedAt = undefined;
            this.runs.set(cascadeId, run);
            this.saveStateDebounced();
            this.ensureActiveWatcher(cascadeId, run.callerAgent, run.baselineStepIndex);
          } else if (!snap && run.status === 'waiting-background') {
            console.warn(
              `[antigravity] Cascade ${cascadeId} was waiting-background but transcript is unavailable on startup; resetting to running`,
            );
            run.status = 'running';
            run.waitingBackgroundStartedAt = undefined;
            this.runs.set(cascadeId, run);
            this.saveStateDebounced();
            this.ensureActiveWatcher(cascadeId, run.callerAgent, run.baselineStepIndex);
          } else {
            console.log(`[antigravity] Restoring active watcher for cascade ${cascadeId} (status=${run.status})`);
            this.ensureActiveWatcher(cascadeId, run.callerAgent, run.baselineStepIndex);
          }
        } catch (e) {
          console.warn(`[antigravity] Failed checking transcript for cascade ${cascadeId} on startup:`, e);
          if (run.status === 'waiting-background') {
            run.status = 'running';
            run.waitingBackgroundStartedAt = undefined;
            this.runs.set(cascadeId, run);
            this.saveStateDebounced();
          }
          this.ensureActiveWatcher(cascadeId, run.callerAgent, run.baselineStepIndex);
        }
      } else if (run.status === 'done') {
        // R1: Restart recovery for done runs: check if transcript grew while host was down
        try {
          const snap = await readCascadeTranscript(brainDir, cascadeId, run.baselineStepIndex ?? -1);
          if (snap) {
            const stepGrew = run.settledStepIndex !== undefined && snap.maxStepIndex > run.settledStepIndex;
            const activeGrew = Boolean(
              snap.lastActiveAt &&
              run.lastActiveAt &&
              snap.lastActiveAt > run.lastActiveAt
            );
            if (stepGrew || activeGrew) {
              console.log(
                `[antigravity] Cascade ${cascadeId} grew during restart (settledStepIndex=${run.settledStepIndex}, maxStepIndex=${snap.maxStepIndex}). Reverting status to running and restoring watcher.`
              );
              run.status = 'running';
              run.lastNotifiedTransition = undefined;
              run.settledStepIndex = undefined;
              run.settledContentHash = undefined;
              this.ensureActiveWatcher(cascadeId, run.callerAgent, run.baselineStepIndex);
            } else {
              const watchMaxMs = this.config.watchMaxMs ?? DEFAULT_WATCH_MAX_MS;
              const elapsed = Date.now() - run.startedAt;
              if (elapsed < watchMaxMs) {
                this.ensureActiveWatcher(cascadeId, run.callerAgent, run.baselineStepIndex);
              }
            }
          }
        } catch (e) {
          console.warn(`[antigravity] Failed to check transcript for done cascade ${cascadeId} on init:`, e);
        }
      }
    }

    for (const [cascadeId, queue] of Array.from(this.messageQueues.entries())) {
      if (!this.runs.has(cascadeId)) {
        console.warn(`[antigravity] Dropping orphan message queue (${queue.length} item(s)) for unknown cascade ${cascadeId}`);
        for (const item of queue) {
          item.reject(new Error(`Unknown cascade ${cascadeId}; queued message cancelled on startup.`));
        }
        this.messageQueues.delete(cascadeId);
      }
    }

    this.saveStateDebounced();
  }

  private startOutboxTimer(): void {
    if (this.outboxTimer) return;
    this.outboxTimer = setInterval(() => {
      this.retrySettlementOutbox();
    }, 10_000);
    if (this.outboxTimer && typeof this.outboxTimer.unref === 'function') {
      this.outboxTimer.unref();
    }
  }

  private retrySettlementOutbox(): void {
    if (this.disposed || this.settlementOutbox.length === 0) return;
    const now = Date.now();
    const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes timeout

    const remaining: SettlementOutboxItem[] = [];
    let stateChanged = false;

    for (const item of this.settlementOutbox) {
      if (now - item.enqueuedAt > MAX_AGE_MS) {
        console.warn(
          `[antigravity][outbox] Discarding expired settlement notice for cascade ${item.cascadeId} transitionKey=${item.transitionKey} after 10m`,
        );
        stateChanged = true;
        continue;
      }

      const message = {
        id: item.id || crypto.randomUUID(),
        role: 'user' as const,
        content: [{ type: 'text' as const, text: item.noticeText }],
        source: {
          kind: 'subagent-settled' as const,
          form: 'notice' as const,
          summary: item.summary,
          senderSessionId: item.cascadeId,
        },
      };

      let targetAgent: any;
      if (item.callerAgentId) {
        targetAgent = this.findLiveAgent(item.callerAgentId);
      }
      const run = this.runs.get(item.cascadeId);
      if (!targetAgent) {
        targetAgent = run?.callerAgent || (run?.callerAgentId ? this.findLiveAgent(run.callerAgentId) : undefined);
      }

      const delivered = this.deliverMessageToAgent(targetAgent, message);
      item.attempts = (item.attempts ?? 1) + 1;
      item.lastAttemptAt = now;

      console.log(
        `[antigravity][notify] status=${run?.status ?? 'done'} turnSeq=${item.turnSeq} transitionKey=${item.transitionKey} delivered=${delivered}`,
      );

      if (delivered) {
        if (run) {
          run.lastNotifiedTransition = item.transitionKey;
        }
        (this.ctx as any).emit?.('antigravity/settled', {
          run,
          summary: item.summary,
          noticeText: item.noticeText,
          delivered: true,
        });
        stateChanged = true;
      } else {
        remaining.push(item);
      }
    }

    if (stateChanged || remaining.length !== this.settlementOutbox.length) {
      this.settlementOutbox = remaining;
      this.saveStateDebounced();
    }
  }

  private enqueueSettlementOutbox(item: SettlementOutboxItem): void {
    if (
      item.transitionKey.startsWith('done:') ||
      item.transitionKey.startsWith('error:') ||
      item.transitionKey.startsWith('timeout:')
    ) {
      this.settlementOutbox = this.settlementOutbox.filter(
        (o) => !(o.cascadeId === item.cascadeId && o.transitionKey.startsWith('awaiting-approval:')),
      );
    }

    const idx = this.settlementOutbox.findIndex(
      (o) => o.cascadeId === item.cascadeId && o.transitionKey === item.transitionKey,
    );
    if (idx >= 0) {
      this.settlementOutbox[idx] = {
        ...this.settlementOutbox[idx],
        ...item,
        attempts: (this.settlementOutbox[idx].attempts ?? 1) + 1,
        lastAttemptAt: Date.now(),
      };
    } else {
      this.settlementOutbox.push(item);
    }
  }

  private removeFromSettlementOutbox(cascadeId: string, transitionKey?: string): void {
    if (transitionKey) {
      this.settlementOutbox = this.settlementOutbox.filter(
        (o) => !(o.cascadeId === cascadeId && o.transitionKey === transitionKey),
      );
    } else {
      this.settlementOutbox = this.settlementOutbox.filter((o) => o.cascadeId !== cascadeId);
    }
  }

  /**
   * Hand one settlement/approval notice to a DSH agent.
   *
   * Three properties this method guarantees, because a false "delivered" is
   * unrecoverable silence:
   *
   * 1. **Evidence-based success.** `delivered` is returned true ONLY when a real
   *    callable actually accepted the message. The previous version used
   *    `agent.followup?.(msg)` / `agent.steer?.(msg)` and then unconditionally
   *    `return true`: an optional call on an agent that has neither method
   *    short-circuits silently, so the caller latched
   *    `run.lastNotifiedTransition` (permanently suppressing that notice through
   *    `notifySettlementToDsh`'s idempotency check) and never enqueued the
   *    settlement outbox. That is the "notification never arrives, and is never
   *    retried" failure.
   * 2. **Caller-scoped targeting.** Candidates are the bound agent, the agent
   *    resolved from `callerAgentId`, and only then — as a last resort — any
   *    live agent. The previous version broadcast to the FIRST live agent from
   *    the registry, which can be an unrelated session, and still reported it as
   *    delivered to the caller.
   * 3. **Wake budget.** `steer()`/`followup()` are wakeup-capable
   *    (`Agent.send(..., wakeup: true)`), so an unbounded notice stream can
   *    self-excite: cascade done → wake the model → the model launches another
   *    cascade → done → wake again. Wakes are capped per agent; past the cap a
   *    BUSY caller is served through the non-waking `inject()` seam (its running
   *    turn still claims next-step inbox entries). An IDLE caller is still woken,
   *    loudly, because dropping a settlement notice into an idle agent's inbox is
   *    exactly the unrecoverable silence this method exists to prevent — the
   *    budget throttles, it never silently discards.
   */
  private deliverMessageToAgent(targetAgent: any, message: any): boolean {
    const candidates: any[] = [];
    const pushCandidate = (agent: any) => {
      if (agent && !candidates.includes(agent)) candidates.push(agent);
    };
    pushCandidate(targetAgent);
    pushCandidate(this.findLiveAgent(this.resolveAgentId(targetAgent)));
    try {
      for (const ag of this.getAgentsService()?.list?.() || []) pushCandidate(ag);
    } catch {
      // no registry available — the bound/resolved candidates still apply
    }

    for (const agent of candidates) {
      if (!agent || agent.disposed) continue;
      // `steer` is the single wakeup-capable seam: it targets the next step and
      // wakes the driver, so it covers both the idle and the busy caller. An
      // agent that exposes only `followup` (also wakeup-capable) is still served,
      // but only after `steer` is proven unavailable.
      if (this.wakeBudgetSpent(this.resolveAgentId(agent)) && agent.status !== 'idle') {
        // Over budget and already running: queue without starting a driver. The
        // live turn claims next-step entries, so this still lands this turn.
        if (this.invokeAgentSeam(agent, 'inject', message)) {
          this.finishDelivery(agent, false);
          return true;
        }
      }
      if (this.invokeAgentSeam(agent, 'steer', message)) {
        this.finishDelivery(agent, true);
        return true;
      }
      if (this.invokeAgentSeam(agent, 'followup', message)) {
        this.finishDelivery(agent, true);
        return true;
      }
    }
    return false;
  }

  /**
   * Invoke one agent delivery seam, proving the method exists first.
   * @returns true only when the call actually ran without throwing.
   */
  private invokeAgentSeam(agent: any, seam: 'steer' | 'followup' | 'inject', message: any): boolean {
    const fn = agent?.[seam];
    if (typeof fn !== 'function') return false;
    try {
      fn.call(agent, message);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether this agent has already been woken {@link MAX_CONSECUTIVE_NOTICE_WAKES} times in a row. */
  private wakeBudgetSpent(agentId: string | undefined): boolean {
    if (!agentId) return false;
    return (this.noticeWakeCount.get(agentId) ?? 0) >= MAX_CONSECUTIVE_NOTICE_WAKES;
  }

  /**
   * Account for one delivered notice and checkpoint the session it was queued
   * into. Only a wakeup-capable seam spends budget; a non-waking injection does
   * not, because it cannot start the self-excitation loop it exists to bound.
   */
  private finishDelivery(agent: any, woke: boolean): void {
    const key = this.resolveAgentId(agent);
    if (key) {
      if (woke) {
        const spent = (this.noticeWakeCount.get(key) ?? 0) + 1;
        this.noticeWakeCount.set(key, spent);
        if (spent > MAX_CONSECUTIVE_NOTICE_WAKES) {
          console.warn(
            `[antigravity][notify] wake budget exceeded for agent ${key} (${spent} consecutive notice wakes); `
            + 'an IDLE caller is still being woken because dropping a settlement notice is unrecoverable. '
            + 'A model-authored antigravity_check_run / antigravity_send_message against this lane refunds the budget.',
          );
        }
      }
    }
    try {
      const sessions = (this.ctx as any).sessions;
      if (sessions?.flush && agent?.session) {
        const flushed = sessions.flush(agent.session);
        if (flushed && typeof flushed.catch === 'function') {
          flushed.catch(() => {});
        }
      }
    } catch {
      // flush is a durability optimisation, never a delivery requirement
    }
  }

  /** Best-effort identity for an agent, used to scope fallback delivery. */
  private resolveAgentId(agent: any): string | undefined {
    const id = agent?.id ?? agent?.session?.header?.id ?? agent?.name;
    return id === undefined || id === null ? undefined : String(id);
  }

  /**
   * Refund `callerAgent`'s notice wake budget because the model itself is
   * actively driving this lane.
   *
   * Called ONLY from `antigravity_check_run` and `antigravity_send_message`.
   * `antigravity_delegate` deliberately does NOT refund: "notice woke the model
   * → model launched another cascade → done → notice" is precisely the loop the
   * budget bounds, and refunding on every delegate would defeat it.
   */
  noteModelActivity(callerAgent: any): void {
    const key = this.resolveAgentId(callerAgent);
    if (key) this.noticeWakeCount.delete(key);
  }

  /** Normalize a task id for dictionary matching. */
  normalizeTaskId(taskId: string): string {
    return taskId.trim().toLowerCase();
  }

  /**
   * Silence waiting-background warning notifications for a specific task ID.
   * If durationSeconds is omitted or <= 0, silences indefinitely.
   * Infinitely silenced tasks do not block cascade settlement when idle.
   */
  silenceTask(
    cascadeId: string,
    rawTaskId: string,
    durationSeconds?: number,
  ): {
    success: boolean;
    cascadeId?: string;
    taskId: string;
    infinite: boolean;
    silencedUntil?: string;
    durationSeconds?: number;
    note: string;
  } {
    const norm = this.normalizeTaskId(rawTaskId);
    let resolvedCascadeId = cascadeId;
    let shortTaskId = norm;
    if (norm.includes('/')) {
      const parts = norm.split('/');
      resolvedCascadeId = parts[0];
      shortTaskId = parts[1];
    }

    const isInfinite =
      durationSeconds === undefined ||
      durationSeconds === null ||
      durationSeconds <= 0 ||
      !Number.isFinite(durationSeconds);

    const now = Date.now();
    const until = isInfinite ? undefined : now + durationSeconds! * 1000;

    const entry: TaskSilenceEntry = {
      taskId: shortTaskId,
      infinite: isInfinite,
      until,
      silencedAt: now,
    };

    const strippedId = shortTaskId.replace(/^task[_-]/i, '');
    const prefixedId = `task-${strippedId}`;

    this.globalTaskSilences.set(shortTaskId, entry);
    this.globalTaskSilences.set(strippedId, entry);
    this.globalTaskSilences.set(prefixedId, entry);
    if (norm !== shortTaskId) {
      this.globalTaskSilences.set(norm, entry);
    }

    let targetRun: HubRun | undefined;
    if (resolvedCascadeId) {
      targetRun = this.runs.get(resolvedCascadeId);
    }
    if (!targetRun) {
      for (const [, r] of this.runs) {
        if (r.status === 'running' || r.status === 'waiting-background') {
          targetRun = r;
          resolvedCascadeId = r.cascadeId;
          break;
        }
      }
    }

    if (targetRun) {
      if (!targetRun.silencedTasks) targetRun.silencedTasks = {};
      targetRun.silencedTasks[shortTaskId] = entry;
      targetRun.silencedTasks[strippedId] = entry;
      targetRun.silencedTasks[prefixedId] = entry;
      if (norm !== shortTaskId) {
        targetRun.silencedTasks[norm] = entry;
      }
      this.saveStateDebounced();
    }

    const note = isInfinite
      ? `Task "${shortTaskId}" is indefinitely silenced. It will no longer trigger waiting-background warnings, and will not block cascade settlement when idle.`
      : `Task "${shortTaskId}" is silenced for ${durationSeconds}s (until ${new Date(until!).toISOString()}). Warnings will automatically resume after expiration.`;

    return {
      success: true,
      cascadeId: resolvedCascadeId || undefined,
      taskId: shortTaskId,
      infinite: isInfinite,
      silencedUntil: until ? new Date(until).toISOString() : undefined,
      durationSeconds: isInfinite ? undefined : durationSeconds,
      note,
    };
  }

  /**
   * Checks whether a task is currently silenced.
   * Returns { silenced: boolean, infinite: boolean }.
   */
  isTaskSilenced(
    runOrCascadeId: HubRun | string | undefined,
    taskId: string,
    now = Date.now(),
  ): { silenced: boolean; infinite: boolean } {
    const run = typeof runOrCascadeId === 'string' ? this.runs.get(runOrCascadeId) : runOrCascadeId;
    const norm = this.normalizeTaskId(taskId);
    const shortId = norm.includes('/') ? norm.split('/')[1] : norm;
    const strippedId = shortId.replace(/^task[_-]/i, '');
    const prefixedId = `task-${strippedId}`;

    const candidates = [
      run?.silencedTasks?.[norm],
      run?.silencedTasks?.[shortId],
      run?.silencedTasks?.[strippedId],
      run?.silencedTasks?.[prefixedId],
      this.globalTaskSilences.get(norm),
      this.globalTaskSilences.get(shortId),
      this.globalTaskSilences.get(strippedId),
      this.globalTaskSilences.get(prefixedId),
    ].filter(Boolean) as TaskSilenceEntry[];

    for (const c of candidates) {
      if (c.infinite) {
        return { silenced: true, infinite: true };
      }
      if (c.until && now < c.until) {
        return { silenced: true, infinite: false };
      }
    }

    return { silenced: false, infinite: false };
  }

  /** Hot-swap live config (loader/volatile-update snapshot). All fields are read at use-time. */
  updateConfig(config: AntigravityConfig): void {
    this.config = config;
  }

  /** Proactively push a settlement/approval notice to DSH session (steering / followup) with idempotency. */
  notifySettlementToDsh(run: HubRun, callerAgent?: any): void {
    if (this.disposed) return;
    try {
      const turn = run.turnSeq ?? 1;
      const stepSuffix = run.settledStepIndex !== undefined ? `:step${run.settledStepIndex}` : '';
      const transitionKey = `${run.status}:turn${turn}:${run.pendingTool ? run.pendingTool.name : ''}${stepSuffix}`;
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
          settledStepIndex: run.settledStepIndex,
          activeBackgroundTasks: run.residualBackgroundTasks?.length ?? 0,
          residualTaskIds: run.residualBackgroundTasks ?? [],
        },
      };

      let targetAgent = callerAgent || run.callerAgent;
      if (!targetAgent && run.callerAgentId) {
        targetAgent = this.findLiveAgent(run.callerAgentId);
        if (targetAgent) {
          run.callerAgent = targetAgent;
        }
      }
      const delivered = this.deliverMessageToAgent(targetAgent, message);

      if (delivered) {
        run.lastNotifiedTransition = transitionKey;
        this.removeFromSettlementOutbox(run.cascadeId, transitionKey);
      } else {
        const callerAgentId =
          run.callerAgentId ??
          targetAgent?.id ??
          targetAgent?.session?.header?.id ??
          targetAgent?.name;
        this.enqueueSettlementOutbox({
          id: crypto.randomUUID(),
          cascadeId: run.cascadeId,
          turnSeq: turn,
          transitionKey,
          summary,
          noticeText,
          callerAgentId: callerAgentId ? String(callerAgentId) : undefined,
          enqueuedAt: Date.now(),
          attempts: 1,
          lastAttemptAt: Date.now(),
        });
      }

      console.log(
        `[antigravity][notify] status=${run.status} turnSeq=${turn} transitionKey=${transitionKey} delivered=${delivered}`,
      );

      (this.ctx as any).emit?.('antigravity/settled', { run, summary, noticeText, delivered });
      this.saveStateDebounced();
    } catch {
      // Settlement notices must be safe and never throw
    }
  }

  /** Push a resumption notice when user approvals in IDE are granted. */
  notifyResumedToDsh(run: HubRun, callerAgent?: any): void {
    if (this.disposed) return;
    try {
      const turn = run.turnSeq ?? 1;
      const transitionKey = `resumed:turn${turn}`;
      if (run.lastResumedNotifiedTurn === turn) {
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

      let targetAgent = callerAgent || run.callerAgent;
      if (!targetAgent && run.callerAgentId) {
        targetAgent = this.findLiveAgent(run.callerAgentId);
        if (targetAgent) {
          run.callerAgent = targetAgent;
        }
      }
      const delivered = this.deliverMessageToAgent(targetAgent, message);

      if (delivered) {
        run.lastResumedNotifiedTurn = turn;
      } // else: leave unset so the next watcher tick retries delivery

      console.log(
        `[antigravity][notify] status=${run.status} turnSeq=${turn} transitionKey=${transitionKey} delivered=${delivered}`,
      );

      (this.ctx as any).emit?.('antigravity/resumed', { run, summary, noticeText, delivered });
      this.saveStateDebounced();
    } catch {
      // safe ignore
    }
  }

  /** Push a settlement revocation notice when R1 detects that a settled cascade resumed activity. */
  notifyRevertedFromDoneToDsh(
    run: HubRun,
    details: { oldSettledStep?: number; currentStep?: number; oldActiveAt?: string; currentActiveAt?: string },
    callerAgent?: any,
  ): void {
    if (this.disposed) return;
    try {
      const summary = `⚠️ [Antigravity] ${run.cascadeId.slice(0, 8)} 结算撤回 (Reverted from Done)`;
      const noticeText =
        `### ⚠️ Antigravity Cascade 结算撤回 (Reverted from Done)\n` +
        `- **Cascade ID**: \`${run.cascadeId}\`\n` +
        `- **Status**: \`running\` (原 done 判定已撤销)\n` +
        `- **原因**: 检测到 cascade 在声称完成后产生了新活动 (步骤: ${details.oldSettledStep ?? 'N/A'} -> ${details.currentStep ?? 'N/A'})\n\n` +
        `> ⚠️ 该 Cascade 尚未真正结束，已自动恢复为 running 状态并继续跟踪其生命周期。`;
      const message = {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content: [{ type: 'text' as const, text: noticeText }],
        source: {
          kind: 'subagent-settled' as const,
          form: 'notice' as const,
          summary,
          senderSessionId: run.cascadeId,
          revertedFromDone: true,
          oldSettledStep: details.oldSettledStep,
          currentStep: details.currentStep,
        },
      };

      let targetAgent = callerAgent || run.callerAgent;
      if (!targetAgent && run.callerAgentId) {
        targetAgent = this.findLiveAgent(run.callerAgentId);
        if (targetAgent) {
          run.callerAgent = targetAgent;
        }
      }
      const delivered = this.deliverMessageToAgent(targetAgent, message);
      console.log(
        `[antigravity][notify] status=reverted-from-done cascadeId=${run.cascadeId} delivered=${delivered}`,
      );

      (this.ctx as any).emit?.('antigravity/reverted-from-done', { run, details, summary, noticeText, delivered });
      this.saveStateDebounced();
    } catch {
      // safe ignore
    }
  }

  /**
   * Proactively push a waiting-background warning notice to DSH session.
   * Rate-limited to once every 5 minutes (300,000ms) for the same running background task state.
   */
  notifyWaitingBackgroundToDsh(
    run: HubRun,
    activeTasks: ActiveBackgroundTask[],
    callerAgent?: any,
  ): void {
    if (this.disposed) return;
    try {
      const now = Date.now();
      const unsilencedTasks = activeTasks.filter(
        (t) => !this.isTaskSilenced(run, t.taskId, now).silenced,
      );
      if (unsilencedTasks.length === 0) {
        return; // Suppressed: all active tasks are silenced
      }

      const lastWarn = run.lastBackgroundWarningAt ?? 0;
      if (!run.waitingBackgroundStartedAt) {
        run.waitingBackgroundStartedAt = now;
      }
      const episodeStart = run.waitingBackgroundStartedAt;
      const elapsedEpisodeMs = now - episodeStart;

      // 1. Episode threshold: current waiting episode must have lasted at least 5 minutes
      const episodeThresholdMs = 300_000; // 5 minutes
      if (elapsedEpisodeMs < episodeThresholdMs) {
        return; // Avoid premature noise for short background tasks
      }

      // 2. Global rate limit: at least 2 minutes (120s) between ANY two warnings on the same cascade
      const globalMinIntervalMs = 120_000; // 2 minutes
      if (lastWarn > 0 && now - lastWarn < globalMinIntervalMs) {
        return; // Throttled by global limit
      }

      // 3. Intra-episode rate limit: periodic warnings within the SAME waiting episode must be at least 5 minutes apart
      const sameEpisodeIntervalMs = 300_000; // 5 minutes
      if (lastWarn >= episodeStart && now - lastWarn < sameEpisodeIntervalMs) {
        return; // Throttled within same episode
      }

      run.lastBackgroundWarningAt = now;
      const elapsedSec = Math.max(1, Math.round(elapsedEpisodeMs / 1000));
      const elapsedMin = (elapsedSec / 60).toFixed(1);

      const silencedCount = activeTasks.length - unsilencedTasks.length;
      const silencedNote = silencedCount > 0 ? `\n- (${silencedCount} 个已静默后台任务未列出)` : '';
      const taskLines =
        unsilencedTasks.length > 0
          ? unsilencedTasks.map((t) => `- \`${t.taskId}\`: ${t.description || '执行中'}`).join('\n') + silencedNote
          : '- (未知后台任务)';

      const summary = `⏳ [Antigravity] ${run.cascadeId.slice(0, 8)} 后台任务运行中 (已等待 ${elapsedMin} 分钟)`;
      const noticeText = `### ⏳ Antigravity Cascade 正在等待后台任务\n- **Cascade ID**: \`${run.cascadeId}\`\n- **Status**: \`waiting-background\`\n- **已等待时长**: ${elapsedMin} 分钟 (${elapsedSec}秒)\n- **运行中后台任务 (${activeTasks.length})**:\n${taskLines}\n\n> ⚠️ 后台任务仍在执行中，未到达真正完成状态。后台任务完成后 hub 将自动唤醒会话并继续/结算。`;

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

      let targetAgent = callerAgent || run.callerAgent;
      if (!targetAgent && run.callerAgentId) {
        targetAgent = this.findLiveAgent(run.callerAgentId);
        if (targetAgent) {
          run.callerAgent = targetAgent;
        }
      }
      const delivered = this.deliverMessageToAgent(targetAgent, message);

      console.log(
        `[antigravity][notify] status=waiting-background cascadeId=${run.cascadeId} elapsed=${elapsedMin}m tasks=${activeTasks.length} delivered=${delivered}`,
      );

      (this.ctx as any).emit?.('antigravity/waiting-background', {
        run,
        activeTasks,
        summary,
        noticeText,
        delivered,
      });
      this.saveStateDebounced();
    } catch {
      // Background notifications must never throw
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

  /**
   * Retrieves structured background tasks and subagent child status for a cascade.
   * 1. Checks memory cache with throttling to prevent heavy GetCascadeTrajectory polling on every watcher tick.
   * 2. Attempts HubClient.getCascadeTasks(cascadeId).
   * 3. Falls back to SQLite database (~/.gemini/antigravity/conversations/<cascadeId>.db).
   * 4. Falls back to empty list.
   */
  async getStructuredCascadeTasks(
    cascadeId: string,
    brainDir?: string,
    currentMaxStep = -1,
    forceRefresh = false,
  ): Promise<StructuredCascadeTasksResult> {
    const cached = this.trajectoryTaskCache.get(cascadeId);
    const now = Date.now();
    const THROTTLE_MS = 3000;
    const timeElapsed = now - (cached?.lastFetchedAt ?? 0);
    const stepChanged = currentMaxStep >= 0 && currentMaxStep !== (cached?.lastMaxStepIndex ?? -1);

    if (!forceRefresh && cached && timeElapsed < THROTTLE_MS && !stepChanged) {
      return cached.result;
    }

    // 1. Try HubClient.getCascadeTasks / getCascadeTrajectory
    try {
      const client = await this.getHubClient();
      if (client && typeof (client as any).getCascadeTasks === 'function') {
        const result = await (client as any).getCascadeTasks(cascadeId);
        this.trajectoryTaskCache.set(cascadeId, {
          lastFetchedAt: now,
          lastMaxStepIndex: currentMaxStep,
          result,
        });
        return result;
      } else if (client && typeof (client as any).getCascadeTrajectory === 'function') {
        const resp = await (client as any).getCascadeTrajectory(cascadeId);
        const result = parseStructuredTrajectoryTasks(resp, cascadeId);
        this.trajectoryTaskCache.set(cascadeId, {
          lastFetchedAt: now,
          lastMaxStepIndex: currentMaxStep,
          result,
        });
        return result;
      }
    } catch {
      // Hub unavailable or error, fall through to SQLite fallback
    }

    // 2. Try SQLite conversation fallback
    try {
      const sqliteResult = readStructuredTasksFromSqlite(cascadeId);
      if (sqliteResult) {
        this.trajectoryTaskCache.set(cascadeId, {
          lastFetchedAt: now,
          lastMaxStepIndex: currentMaxStep,
          result: sqliteResult,
        });
        return sqliteResult;
      }
    } catch {
      // SQLite unavailable
    }

    // 3. Fallback to existing cached result if present
    if (cached) {
      return cached.result;
    }

    return { activeTasks: [], allTasks: [], hasActiveChildren: false };
  }

  /**
   * Display-id model chosen for each bridge-started cascade; cascades the bridge
   * did not start fall back to the configured default model.
   */
  private readonly cascadeModelDisplays = new Map<string, string>();

  /**
   * Resolve the MODEL_* enum to attach to SendUserCascadeMessage. Required
   * whenever the hub may construct a fresh executor (idle resume): a send
   * without cascadeConfig resets the cascade's model to None and the turn dies
   * with "neither PlanModel nor RequestedModel specified". Never throws — on
   * resolution failure the caller sends without a model (legacy behavior).
   */
  private async planModelFor(client: HubClient, cascadeId?: string): Promise<string | undefined> {
    const display = (cascadeId !== undefined && this.cascadeModelDisplays.get(cascadeId))
      || this.config.defaultModel
      || DEFAULT_MODEL_ID;
    try {
      return await client.resolveModelCached(display);
    } catch {
      return undefined;
    }
  }

  /** Hub GetAvailableModels, slimmed to the fields a model caller needs. */
  async hubListModels(): Promise<unknown> {
    const client = await this.getHubClient();
    const resp = (await client.getAvailableModels()) as {
      response?: { models?: Record<string, Record<string, unknown>> };
    };
    const models = resp.response?.models;
    if (!models) {
      // Fail loud: after a hub restart a stale endpoint used to decode into an
      // empty message here and surface as an empty model catalog.
      throw new Error(
        'GetAvailableModels returned an unexpected shape (missing response.models): '
        + JSON.stringify(resp).slice(0, 300),
      );
    }
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

  /** Ensure an active background watcher exists and monitors this cascade's lifecycle until final settlement.
   *  Entry points (delegate/send/queue flush) must rearm the run themselves via {@link rearmRun}; this method
   *  only creates a missing run record and starts the single poller. */
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
        turnSeq: 1,
        priorContents: [],
      };
      if (callerAgent) {
        const id = callerAgent.id ?? callerAgent.session?.header?.id ?? callerAgent.name;
        if (id) run.callerAgentId = String(id);
      }
      this.runs.set(cascadeId, run);
    } else {
      if (callerAgent) {
        run.callerAgent = callerAgent;
        const id = callerAgent.id ?? callerAgent.session?.header?.id ?? callerAgent.name;
        if (id) run.callerAgentId = String(id);
      } else if (!run.callerAgent && run.callerAgentId) {
        const resolved = this.findLiveAgent(run.callerAgentId);
        if (resolved) run.callerAgent = resolved;
      }
      if (baselineStepIndex !== undefined) run.baselineStepIndex = baselineStepIndex;
    }

    this.saveStateDebounced();

    if (this.watchers.has(cascadeId)) {
      return;
    }

    const watcher = this.runCascadeWatcher(cascadeId);
    this.watchers.set(cascadeId, watcher);
  }

  /** Archive the previous turn's final text, bump the turn counter, and re-arm the run for a new delegation. */
  private static rearmRun(run: HubRun, baselineStepIndex: number, callerAgent?: any): HubRun {
    const prev = (run.content ?? '').trim();
    if (prev) run.priorContents = [...(run.priorContents ?? []), prev];
    run.turnSeq = (run.turnSeq ?? 1) + 1;
    run.status = 'running';
    run.startedAt = Date.now();
    run.baselineStepIndex = baselineStepIndex;
    run.content = undefined;
    run.error = undefined;
    run.pendingTool = undefined;
    run.approvalNotified = false;
    run.resumedNotified = false;
    run.lastNotifiedTransition = undefined;
    run.lastResumedNotifiedTurn = undefined;
    run.reportPath = undefined;
    run.reportChars = undefined;
    run.autoResumeRetries = 0;
    run.autoContinueCount = 0;
    run.autoContinueExhausted = undefined;
    run.lastAutoContinueReason = undefined;
    run.settledStepIndex = undefined;
    run.settledContentHash = undefined;
    if (callerAgent) {
      run.callerAgent = callerAgent;
      const id = callerAgent.id ?? callerAgent.session?.header?.id ?? callerAgent.name;
      if (id) run.callerAgentId = String(id);
    }
    return run;
  }

  /** Whole-cascade accumulated report text: every settled prior turn plus the current one. */
  private static fullReportText(run: HubRun): string {
    return [...(run.priorContents ?? []), run.content ?? ''].map((part) => part.trim()).filter(Boolean).join('\n\n');
  }

  /**
   * Persist an oversized report so nothing is unreachable from the session. The harness
   * spill seam (`ctx.spillStore`) is preferred when mounted; otherwise a private
   * owner-only file lands under `<appDataDir>/dsh-reports/<cascadeId>/`. Small reports
   * stay inline-only and skip persistence entirely.
   */
  private async landReport(run: HubRun): Promise<void> {
    const full = AntigravityService.fullReportText(run);
    const budget = Math.max(1, this.config.inlineCharBudget ?? 4_000);
    if (!full || full.length <= budget) {
      run.reportPath = undefined;
      run.reportChars = undefined;
      return;
    }
    run.reportChars = full.length;
    run.reportPath = (await this.persistText(run.cascadeId, full, run.turnSeq ?? 1, run.callerAgent)) ?? undefined;
  }

  /** Best-effort full-text persistence: spill seam first, private file fallback. Returns a model-facing locator. */
  private async persistText(cascadeId: string, text: string, turnSeq: number, callerAgent?: any): Promise<string | undefined> {
    // 1) Harness spill seam (optional capability): session-scoped private artifact with retrieval hint.
    try {
      const spillStore = (this.ctx as any).get?.('spillStore');
      const sessionId = callerAgent?.session?.header?.id;
      if (spillStore?.saveText && sessionId) {
        const ref = await spillStore.saveText({
          owner: { sessionId },
          source: { toolName: 'antigravity_delegate', callId: `antigravity-${cascadeId.slice(0, 8)}`, label: 'result' },
          suggestedName: `antigravity-${cascadeId.slice(0, 8)}-turn${turnSeq}.md`,
          content: text,
        });
        if (ref?.locator) return String(ref.locator);
      }
    } catch {
      // fall through to the local-file fallback
    }
    // 2) Private file next to the bridge's own data (exclusive owner-only create).
    try {
      const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
      const dir = `${appDataDir}/dsh-reports/${cascadeId}`;
      await fsp.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = `${dir}/turn-${turnSeq}-${stamp}.md`;
      const handle = await fsp.open(file, 'wx', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
      } finally {
        await handle.close();
      }
      return file;
    } catch {
      return undefined; // best-effort: the inline preview still carries the summary
    }
  }

  /**
   * Bound a report body to the configured inline budget. Oversized bodies are persisted
   * first and returned as head preview + locator line, mirroring DSH's spill policy shape.
   */
  private async shapeResult(
    cascadeId: string,
    rawContent: string | undefined,
    run?: HubRun,
  ): Promise<{ content: string; truncated: boolean; totalChars: number; reportPath?: string }> {
    const trimmed = (rawContent ?? '').trim();
    if (!trimmed) return { content: '', truncated: false, totalChars: 0 };
    const budget = Math.max(1, this.config.inlineCharBudget ?? 4_000);
    if (trimmed.length <= budget) return { content: trimmed, truncated: false, totalChars: trimmed.length };

    const alreadyLanded = run?.reportPath && run.reportChars === trimmed.length ? run.reportPath : undefined;
    const locator = alreadyLanded ?? (await this.persistText(cascadeId, trimmed, run?.turnSeq ?? 1, run?.callerAgent));
    if (locator && run && !alreadyLanded) {
      run.reportPath = locator;
      run.reportChars = trimmed.length;
    }
    const preview = `${trimmed.slice(0, budget)}\n…[truncated, ${trimmed.length - budget} more chars]`;
    const note = locator ? `\nFull report (${trimmed.length} chars): ${locator}` : '\n(full-text persist failed; read the transcript directly)';
    return { content: `${preview}${note}`, truncated: true, totalChars: trimmed.length, reportPath: locator };
  }

  /**
   * Event-driven settlement wait: resolves on the cascade watcher's next state transition
   * (done / error / awaiting-approval), or returns the honest instant snapshot at the
   * deadline. There is deliberately NO self-managed polling loop here — hub idle probes
   * report false idleness during long silent executor steps, which made wait=true return
   * after seconds. The per-cascade watcher is the single poller.
   */
  private async waitForSettlement(conversationId: string, timeoutMs: number, baselineStepIndex: number): Promise<CascadeDetailedResult> {
    const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
    const brainDir = `${appDataDir}/brain`;
    const immediate = await this.classifySnapshot(brainDir, conversationId, baselineStepIndex);
    if (immediate.status !== 'running' && immediate.status !== 'waiting-background') return immediate;

    return new Promise<CascadeDetailedResult>((resolve) => {
      const entry: SettlementWaiter = {
        done: false,
        finish: (result) => {
          if (entry.done) return;
          entry.done = true;
          clearTimeout(timer);
          const list = this.settlementWaiters.get(conversationId);
          if (list) {
            const at = list.indexOf(entry);
            if (at >= 0) list.splice(at, 1);
            if (list.length === 0) this.settlementWaiters.delete(conversationId);
          }
          resolve(result);
        },
      };
      const timer = setTimeout(() => {
        void this.classifySnapshot(brainDir, conversationId, baselineStepIndex).then((snap) => entry.finish(snap));
      }, timeoutMs);
      const waiters = this.settlementWaiters.get(conversationId) ?? [];
      waiters.push(entry);
      this.settlementWaiters.set(conversationId, waiters);
    });
  }

  /** Release every parked settlement waiter for this cascade (watcher transition point). */
  private settleWaiters(conversationId: string, result: CascadeDetailedResult): void {
    const waiters = this.settlementWaiters.get(conversationId);
    if (!waiters?.length) return;
    this.settlementWaiters.delete(conversationId);
    for (const waiter of waiters) waiter.finish(result);
  }

  /**
   * One-shot transcript classification of a cascade; refreshes the run record and returns
   * the same detailed result shape the wait path resolves with. Shared by check_run's
   * instant path and waitForSettlement's deadline path.
   */
  private async classifySnapshot(brainDir: string, conversationId: string, baselineStepIndex: number): Promise<CascadeDetailedResult> {
    const snap = await readCascadeTranscript(brainDir, conversationId, baselineStepIndex);
    const existingRun = this.runs.get(conversationId);
    let status: HubRun['status'] = existingRun?.status ?? 'running';
    const structuredTasks = await this.getStructuredCascadeTasks(
      conversationId,
      brainDir,
      snap?.maxStepIndex ?? -1,
    );
    if (structuredTasks.activeTasks.length > 0 || structuredTasks.allTasks.length > 0 || structuredTasks.hasActiveChildren) {
      if (snap) {
        snap.activeBackgroundTasks = structuredTasks.activeTasks;
        snap.hasActiveChildren = structuredTasks.hasActiveChildren;
      }
    }

    const activeTasks = snap?.activeBackgroundTasks ?? structuredTasks.activeTasks;
    const blockingTasks = activeTasks.filter((t) => {
      const silence = this.isTaskSilenced(conversationId, t.taskId);
      return !silence || !silence.infinite;
    });
    const residualTasks = activeTasks.filter((t) => {
      const silence = this.isTaskSilenced(conversationId, t.taskId);
      return !!silence && silence.infinite;
    });
    const hasActiveChildren = Boolean(snap?.hasActiveChildren || structuredTasks.hasActiveChildren);

    if (snap?.error) {
      const classification = classifyError(snap.error);
      const isTransient = this.config.autoResume?.enabled !== false && classification.retryable;
      const retries = existingRun?.autoResumeRetries ?? 0;
      const maxRetries = this.config.autoResume?.maxRetries ?? 3;
      if (isTransient && (classification.engineInternal || retries < maxRetries)) {
        status = 'running';
      } else {
        status = 'error';
      }
    } else if (snap?.pendingApproval) {
      const client = await this.getHubClient();
      const isReal = await client.isCascadeAwaitingApproval(conversationId);
      status = isReal ? 'awaiting-approval' : 'running';
    } else if (blockingTasks.length > 0 || hasActiveChildren) {
      status = 'waiting-background';
    } else if (snap?.isFinished && snap.plannerContents.length > 0) {
      // Strict done: a bare isFinished (e.g. setup CHECKPOINT with zero planner
      // output) must not classify as done — that poisoned the registry before.
      // v0.2.6 tail guard: when the LAST valid entry is a tool call/tool result,
      // the model has not produced its closing reply for this turn (an earlier
      // final text or CHECKPOINT leaves a stale isFinished behind while late
      // executor steps land). Report running so the single watcher poller can
      // auto-continue instead of settling the cascade prematurely.
      if (snap.tailKind === 'tool-call' || snap.tailKind === 'tool-result') {
        status = 'running';
      } else {
        // Zero-regex settle: isWaitingSpeech is no longer evaluated here!
        status = 'done';
      }
    } else if (!snap && existingRun?.status === 'done') {
      status = 'done'; // transcript unreadable: keep the last known terminal state
    } else if (snap?.engaged) {
      status = 'running';
    }

    const updatedRun: HubRun = {
      cascadeId: conversationId,
      status,
      startedAt: existingRun?.startedAt ?? Date.now(),
      baselineStepIndex,
      callerAgent: existingRun?.callerAgent,
      callerAgentId: existingRun?.callerAgentId,
      turnSeq: existingRun?.turnSeq ?? 1,
      priorContents: existingRun?.priorContents ?? [],
      lastActiveAt: snap?.lastActiveAt ?? existingRun?.lastActiveAt,
      content: snap?.plannerContents.join('\n\n') ?? existingRun?.content,
      error: status === 'error' ? (existingRun?.error ?? snap?.error) : undefined,
      pendingTool: snap?.pendingApproval ?? existingRun?.pendingTool,
      approvalNotified: existingRun?.approvalNotified,
      resumedNotified: existingRun?.resumedNotified,
      lastNotifiedTransition: existingRun?.lastNotifiedTransition,
      lastResumedNotifiedTurn: existingRun?.lastResumedNotifiedTurn,
      reportPath: existingRun?.reportPath,
      reportChars: existingRun?.reportChars,
      autoResumeRetries: existingRun?.autoResumeRetries,
      autoContinueCount: existingRun?.autoContinueCount,
      autoContinueExhausted: existingRun?.autoContinueExhausted,
      lastAutoContinueReason: existingRun?.lastAutoContinueReason,
      lastBackgroundWarningAt: existingRun?.lastBackgroundWarningAt,
      waitingBackgroundStartedAt:
        status === 'waiting-background'
          ? existingRun?.waitingBackgroundStartedAt ?? Date.now()
          : undefined,
      residualBackgroundTasks:
        status === 'done'
          ? (residualTasks.length > 0 ? residualTasks.map((t) => t.taskId) : undefined)
          : existingRun?.residualBackgroundTasks,
      settledStepIndex:
        status === 'done'
          ? (snap?.maxStepIndex ?? existingRun?.settledStepIndex)
          : existingRun?.settledStepIndex,
    };
    this.runs.set(conversationId, updatedRun);
    this.saveStateDebounced();

    return {
      status,
      content: updatedRun.content ?? '',
      lastActiveAt: updatedRun.lastActiveAt,
      pendingTool: updatedRun.pendingTool,
      error: updatedRun.error,
      activeBackgroundTasks: snap?.activeBackgroundTasks,
      residualBackgroundTasks: updatedRun.residualBackgroundTasks,
    };
  }

  /**
   * Evaluates a cascade error: if transient and retry budget remains, archives current content,
   * waits backoff, bumps the baseline, sends the resume message to the hub, and returns { resumed: true }.
   * Otherwise marks terminal error, lands report, notifies DSH, settles waiters, and returns { resumed: false }.
   */
  private async handleCascadeError(
    cascadeId: string,
    run: HubRun,
    errorText: string,
    maxStepIndex?: number,
  ): Promise<{ resumed: boolean }> {
    const autoResume = this.config.autoResume;
    const enabled = autoResume?.enabled !== false;
    const configMaxRetries = autoResume?.maxRetries ?? 3;
    const message = autoResume?.message || '继续。按原计划继续执行当前任务，不要停止。';
    const classification = classifyError(errorText);
    const isTransient = classification.retryable;
    const signature = classification.signature;
    const isEngineInternal = Boolean(classification.engineInternal);
    const maxRetries = getMaxRetriesForSignature(signature, configMaxRetries);
    const currentRetries = run.autoResumeRetries ?? 0;

    if (enabled && isTransient && isEngineInternal) {
      // The IDE/engine is actively retrying internally (e.g. model format error with retries remaining).
      // Bridge must NOT inject '继续' (which disrupts the engine's retry prompt),
      // must NOT latch terminal error, and must NOT stop the watcher.
      run.status = 'running';
      run.error = undefined;
      this.runs.set(cascadeId, run);
      await new Promise((r) => setTimeout(r, 1000));
      return { resumed: true };
    }

    if (enabled && isTransient && currentRetries < maxRetries) {
      const nextRetry = currentRetries + 1;
      run.autoResumeRetries = nextRetry;
      const backoffMs = getAutoResumeBackoffMs(currentRetries, signature);

      // Archive content produced before the error so nothing is lost
      const prev = (run.content ?? '').trim();
      if (prev) {
        run.priorContents = [...(run.priorContents ?? []), prev];
        run.content = undefined;
      }

      // Bump baseline to skip previous error step in future reads
      const newBaseline = maxStepIndex !== undefined && maxStepIndex >= 0 ? maxStepIndex : (run.baselineStepIndex ?? -1);
      run.baselineStepIndex = newBaseline;
      run.status = 'running';
      run.error = undefined;
      run.pendingTool = undefined;
      this.runs.set(cascadeId, run);
      this.saveStateDebounced();

      // Wait backoff delay (1s for auth refresh, 2s/5s/10s for other transient)
      await new Promise((r) => setTimeout(r, backoffMs));
      if (this.disposed) return { resumed: false };

      try {
        const client = await this.getHubClient();
        await client.sendMessage(cascadeId, message, { planModel: await this.planModelFor(client, cascadeId) });
        return { resumed: true };
      } catch (sendErr) {
        const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
        const sendClassification = classifyError(errMsg);
        if (sendClassification.signature === 'auth_token_expired' || /401|unauthenticated/i.test(errMsg)) {
          run.status = 'error';
          run.error = formatAuthExpiredTerminalError(`发送继续指令失败: ${errMsg}`);
        } else {
          run.status = 'error';
          run.error = `已自动重试 ${nextRetry} 次但在发送继续指令时失败: ${errMsg} (原错误: ${errorText})`;
        }
        this.runs.set(cascadeId, run);
        this.saveStateDebounced();
        await this.landReport(run);
        this.notifySettlementToDsh(run);
        this.settleWaiters(cascadeId, {
          status: 'error',
          content: AntigravityService.fullReportText(run),
          error: run.error,
          lastActiveAt: run.lastActiveAt,
        });
        return { resumed: false };
      }
    }

    // Terminal / exhausted / disabled
    run.status = 'error';
    if (enabled && isTransient && currentRetries >= maxRetries) {
      run.error = formatExhaustedRetryError(maxRetries, errorText, signature);
    } else if (classification.reason === 'model_format_retries_exhausted') {
      run.error = formatExhaustedRetryError(0, errorText, 'model_format_error');
    } else if (classification.reason === 'terminal_auth_permanent_failure') {
      run.error = formatAuthExpiredTerminalError(errorText);
    } else {
      run.error = errorText;
    }
    this.runs.set(cascadeId, run);
    this.saveStateDebounced();
    await this.landReport(run);
    this.notifySettlementToDsh(run);
    this.settleWaiters(cascadeId, {
      status: 'error',
      content: AntigravityService.fullReportText(run),
      error: run.error,
      lastActiveAt: run.lastActiveAt,
    });
    return { resumed: false };
  }

  /**
   * Send one tail-guard auto-"Continue" nudge through the existing sendMessage
   * channel and re-arm the run so the pre-nudge transcript is excluded from the
   * next settlement decision (the watcher then judges the model's response TO
   * the nudge, not the stale tail that triggered it). Returns false when the
   * budget is spent or delivery fails — the caller settles with
   * autoContinueExhausted in that case.
   */
  private async sendAutoContinue(
    cascadeId: string,
    run: HubRun,
    snap: TranscriptSnapshot,
    reason: AutoContinueReason,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const max = this.config.autoContinueMax ?? DEFAULT_AUTO_CONTINUE_MAX;
    const count = run.autoContinueCount ?? 0;
    if (count >= max) {
      run.autoContinueExhausted = true;
      this.runs.set(cascadeId, run);
      this.saveStateDebounced();
      return false;
    }
    const message = this.config.autoContinueMessage || DEFAULT_AUTO_CONTINUE_MESSAGE;
    try {
      const client = await this.getHubClient();
      await client.sendMessage(cascadeId, message, { planModel: await this.planModelFor(client, cascadeId) });
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      run.error = `发送续作指令失败: ${errText}`;
      this.runs.set(cascadeId, run);
      this.saveStateDebounced();
      return false;
    }
    // Archive whatever text this turn produced so far (stays reachable in the
    // full report) and re-baseline the observation window.
    const prev = (run.content ?? '').trim();
    if (prev) {
      run.priorContents = [...(run.priorContents ?? []), prev];
      run.content = undefined;
    }
    const newBaseline = snap.maxStepIndex >= 0 ? snap.maxStepIndex : (run.baselineStepIndex ?? -1);
    run.baselineStepIndex = newBaseline;
    run.status = 'running';
    run.error = undefined;
    run.pendingTool = undefined;
    run.autoContinueCount = count + 1;
    run.lastAutoContinueReason = reason;
    this.runs.set(cascadeId, run);
    this.saveStateDebounced();
    return true;
  }

  /** Unified active cascade loop — the SINGLE poller per cascade. Tracks running/approval/error/done
   *  transitions off the local transcript, notifies DSH, releases parked settlement waiters, and lands
   *  oversized reports on disk. WaitForConversationFullyIdle is deliberately NOT used here: the hub
   *  reports false idleness during long silent executor steps, which caused both premature returns and
   *  premature done classifications. */
  private async runCascadeWatcher(cascadeId: string): Promise<void> {
    const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
    const brainDir = `${appDataDir}/brain`;
    const watchMs = this.config.watchMaxMs ?? 43_200_000;
    const deadline = Date.now() + watchMs;
    let lastStepSeen = -2;
    let lastActiveSeen: string | undefined;
    let idleCycles = 0;
    /** Timestamp of the last transcript progress (maxStepIndex change or lastActiveAt bump); anchors the tail-guard quiet windows and stall recovery. */
    let stallSince = Date.now();

    try {
      while (!this.disposed && Date.now() < deadline) {
        let snap: TranscriptSnapshot | undefined;
        try {
          const run = this.runs.get(cascadeId) ?? {
            cascadeId,
            status: 'running' as const,
            startedAt: Date.now(),
            baselineStepIndex: -1,
            turnSeq: 1,
            priorContents: [] as string[],
          };
          const baseline = run.baselineStepIndex ?? -1;
          snap = await readCascadeTranscript(brainDir, cascadeId, baseline);

        const stepNow = snap?.maxStepIndex ?? -1;
        const lastActiveNow = snap?.lastActiveAt;

        // R1: watcher done-驻留: 假 done 实锤检测
        if (run.status === 'done') {
          const stepGrew = run.settledStepIndex !== undefined && stepNow > run.settledStepIndex;
          const activeGrew = Boolean(
            lastActiveNow &&
            run.lastActiveAt &&
            lastActiveNow > run.lastActiveAt
          );

          if (stepGrew || activeGrew) {
            console.log(
              `[antigravity] Cascade ${cascadeId} fake done detected: step grew from ${run.settledStepIndex} to ${stepNow} (active: ${run.lastActiveAt} -> ${lastActiveNow}). Reverting status to running.`
            );
            const oldSettledStep = run.settledStepIndex;
            run.status = 'running';
            run.lastNotifiedTransition = undefined;
            run.settledStepIndex = undefined;
            run.settledContentHash = undefined;
            stallSince = Date.now();
            idleCycles = 0;
            lastStepSeen = stepNow;
            lastActiveSeen = lastActiveNow;
            this.runs.set(cascadeId, run);
            this.saveStateDebounced();
            this.notifyRevertedFromDoneToDsh(run, {
              oldSettledStep,
              currentStep: stepNow,
              oldActiveAt: run.lastActiveAt,
              currentActiveAt: lastActiveNow,
            });
            // Continue below into normal running loop
          } else {
            // Cascade is settled as done and resident; no new activity yet.
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
        }

        if (snap) {
          run.lastActiveAt = snap.lastActiveAt;
          if (snap.plannerContents.length > 0) {
            run.content = snap.plannerContents.join('\n\n');
          }
        }

        // Transcript progress tracking (refreshes stall quiet anchor on any transcript movement or heartbeat).
        if (stepNow !== lastStepSeen || (lastActiveNow && lastActiveNow !== lastActiveSeen)) {
          lastStepSeen = stepNow;
          lastActiveSeen = lastActiveNow;
          stallSince = Date.now();
          if (run.settleCandidateSnapshot) {
            console.log(
              `[antigravity] Cascade ${cascadeId} step/active grew during confirmation window (step: ${run.settleCandidateSnapshot.stepIndex} -> ${stepNow}). Resetting settle gate.`
            );
            run.settleCandidateSnapshot = undefined;
            this.runs.set(cascadeId, run);
          }
        }

        // Window perception anchored to lastActiveAt (any step growth resets stallSince).
        let quietMs = Date.now() - stallSince;
        if (snap?.lastActiveAt) {
          const activeMs = Date.parse(snap.lastActiveAt);
          if (!Number.isNaN(activeMs)) {
            const elapsedSinceActive = Date.now() - activeMs;
            if (elapsedSinceActive >= 0 && elapsedSinceActive < quietMs) {
              quietMs = elapsedSinceActive;
            }
          }
        }

        // 1. Error state
        if (snap?.error) {
          const { resumed } = await this.handleCascadeError(cascadeId, run, snap.error, snap.maxStepIndex);
          if (resumed) {
            idleCycles = 0;
            lastStepSeen = -2;
            stallSince = Date.now();
            continue;
          }
          break;
        }

        // 1.5 Mid-turn stall detection: cascade is in 'running' state, but no new steps
        // or heartbeats have arrived for stallTimeoutMs (indicating a network error, hung stream, or silent freeze).
        // Background tasks are explicitly excluded: long-running tasks like builds/tests/simulations
        // must not trigger stall error auto-resumes.
        const stallTimeoutMs = this.config.stallTimeoutMs ?? 120_000;
        const stalledMs = Date.now() - stallSince;

        // Structured task state query (GetCascadeTrajectory with throttling + caching + SQLite fallback)
        // Requirement 2: Settlement decision path MUST bypass cache (forceRefresh = true).
        // Non-settlement monitoring / notification path uses 3s cache throttling.
        const isSettleCandidate = snap && !snap.error && !snap.pendingApproval && snap.isFinished;
        const structuredTasks = await this.getStructuredCascadeTasks(
          cascadeId,
          brainDir,
          stepNow,
          Boolean(isSettleCandidate),
        );

        if (snap) {
          if (structuredTasks.activeTasks.length > 0 || structuredTasks.allTasks.length > 0 || structuredTasks.hasActiveChildren) {
            snap.activeBackgroundTasks = structuredTasks.activeTasks;
            snap.hasActiveChildren = structuredTasks.hasActiveChildren;
          }
        }

        const activeTasks = snap?.activeBackgroundTasks ?? structuredTasks.activeTasks;
        const blockingTasks = activeTasks.filter((t) => {
          const silence = this.isTaskSilenced(cascadeId, t.taskId);
          return !silence.infinite;
        });
        const residualTasks = activeTasks.filter((t) => {
          const silence = this.isTaskSilenced(cascadeId, t.taskId);
          return silence.infinite;
        });
        const hasBlockingTasks =
          blockingTasks.length > 0 ||
          Boolean(snap?.hasActiveChildren || structuredTasks.hasActiveChildren || structuredTasks.isCascadeActive);
        const hasActiveTasks =
          activeTasks.length > 0 ||
          Boolean(snap?.hasActiveChildren || structuredTasks.hasActiveChildren || structuredTasks.isCascadeActive);
        if (
          run.status === 'running' &&
          !snap?.pendingApproval &&
          !snap?.isFinished &&
          !hasActiveTasks &&
          stalledMs >= stallTimeoutMs
        ) {
          const stalledSec = Math.round(stalledMs / 1000);
          const stallError = `Cascade stalled: no progress or heartbeat for ${stalledSec}s (network error or stream interrupted)`;
          const { resumed } = await this.handleCascadeError(cascadeId, run, stallError, snap?.maxStepIndex);
          if (resumed) {
            idleCycles = 0;
            lastStepSeen = -2;
            stallSince = Date.now();
            continue;
          }
          break;
        }

        // 2. Pending tool approval in IDE vs Tool execution in progress
        if (snap?.pendingApproval) {
          const client = await this.getHubClient();
          const isRealWaiting = await client.isCascadeAwaitingApproval(cascadeId);

          if (!isRealWaiting) {
            // Auto-approved / YOLO or tool is actively executing in the background.
            // Do NOT mark as awaiting-approval; stay purely running with zero notification noise.
            run.status = 'running';
            run.pendingTool = undefined;
            this.runs.set(cascadeId, run);
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }

          const isNewApproval = run.status !== 'awaiting-approval' || !run.approvalNotified;

          if (isNewApproval) {
            // Grace window in case IDE auto-approves within 1-2 seconds
            const graceMs = this.config.approvalGraceMs ?? 3_000;
            const graceDeadline = Date.now() + graceMs;
            let cleared = false;
            while (Date.now() < graceDeadline && !this.disposed) {
              await new Promise((r) => setTimeout(r, 500));
              const stillWaiting = await client.isCascadeAwaitingApproval(cascadeId);
              if (!stillWaiting) {
                cleared = true;
                break;
              }
              const reSnap = await readCascadeTranscript(brainDir, cascadeId, baseline);
              if (reSnap?.error) {
                const { resumed } = await this.handleCascadeError(cascadeId, run, reSnap.error, reSnap.maxStepIndex);
                if (resumed) {
                  idleCycles = 0;
                  lastStepSeen = -2;
                  break;
                }
                return;
              }
            }
            if (cleared) {
              run.status = 'running';
              run.pendingTool = undefined;
              this.runs.set(cascadeId, run);
              continue; // auto-approved during grace: resume quietly without notifying
            }
          }

          run.status = 'awaiting-approval';
          run.pendingTool = snap.pendingApproval;
          this.runs.set(cascadeId, run);
          this.saveStateDebounced();

          if (isNewApproval) {
            run.approvalNotified = true;
            run.resumedNotified = false;
            // Proactively notify caller of approval requirement (after grace)
            this.notifySettlementToDsh(run);
            this.settleWaiters(cascadeId, { status: 'awaiting-approval', content: run.content ?? '', pendingTool: snap.pendingApproval, lastActiveAt: run.lastActiveAt });
          }

          // Cascade is alive but blocked waiting for user approval in IDE
          stallSince = Date.now();
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }

        // 3. Resumed from awaiting-approval back to running (User approved in IDE)
        if (run.status === 'awaiting-approval' && !snap?.pendingApproval) {
          run.status = 'running';
          run.pendingTool = undefined;
          stallSince = Date.now();
          // ONLY notify resumption if an approval notice was actually sent out before!
          if (run.approvalNotified && !run.resumedNotified) {
            run.resumedNotified = true;
            this.notifyResumedToDsh(run);
          }
          run.approvalNotified = false;
          this.runs.set(cascadeId, run);
          this.saveStateDebounced();
        }

        // 3.5 Background task gate: when there are blocking (non-infinite-silenced) background tasks,
        // the turn is NOT finished (even if the model finished its text output or paused).
        // Hub will send a message to AGY session when any background task completes to wake it up.
        // Do NOT settle, do NOT auto-continue, do NOT treat as stalled.
        if (hasBlockingTasks) {
          if (run.settleCandidateSnapshot) {
            run.settleCandidateSnapshot = undefined;
          }
          if (run.status !== 'waiting-background' || !run.waitingBackgroundStartedAt) {
            run.status = 'waiting-background';
            run.waitingBackgroundStartedAt = Date.now();
          }
          stallSince = Date.now(); // reset stall detection while task is active
          this.notifyWaitingBackgroundToDsh(run, blockingTasks);
          this.runs.set(cascadeId, run);
          this.saveStateDebounced();
          if (stepNow === lastStepSeen) {
            idleCycles = Math.min(idleCycles + 1, 5);
          } else {
            idleCycles = 0;
          }
          if (idleCycles > 0) {
            await new Promise((r) => setTimeout(r, idleCycles * 1000));
          }
          continue;
        } else if (run.status === 'waiting-background') {
          // Blocking background tasks have completed or become infinitely silenced;
          // reset status to running and clear episode start timestamp.
          // Retain lastBackgroundWarningAt so global cascade-level throttling remains active across episodes.
          run.status = 'running';
          run.waitingBackgroundStartedAt = undefined;
          stallSince = Date.now();
          idleCycles = 0;
          this.runs.set(cascadeId, run);
          this.saveStateDebounced();
        }

        // 4. Finished naturally. Strict predicate: only a definitive finished step
        //    (final PLANNER_RESPONSE without tool calls, or CHECKPOINT) settles the
        //    turn — intermediate planner narration must never count as done.
        //
        //    v0.2.6 tail guard (early-stop misjudgment fix): before settling, inspect
        //    the transcript tail. (a) A tool call/tool result as the LAST valid entry
        //    (isFinished left stale by an earlier final text or CHECKPOINT) or (b) a
        //    turn without ANY assistant text reply means the model merely paused
        //    mid-work (e.g. launched a background task and is waiting on it). Instead
        //    of settling, nudge the cascade with "Continue" through the existing
        //    sendMessage channel (budget: autoContinueMax, default 5) and keep
        //    polling; once the budget is spent, settle anyway and flag
        //    autoContinueExhausted so callers can verify the outcome.
        if (snap && !snap.error && !snap.pendingApproval && snap.isFinished) {
          // D2 launch hysteresis. `run.startedAt` is the bridge's own record of
          // when this lifecycle (launch, or re-arm on a new turn into the same
          // cascade) was issued. The hub only publishes `taskDetails` for a
          // cascade after its executor has been running for a few seconds, so an
          // empty task list read inside LAUNCH_OBSERVATION_GRACE_MS is
          // "unobserved", not "none". Feeding it to the settle gate as "none"
          // settles a lane that is still running and forces a revert-from-done
          // moments later — the false-idle defect.
          const sinceLifecycleStartMs = Date.now() - (run.startedAt ?? Date.now());
          const decision = decideTailSettle({
            snap,
            tailQuietMs: quietMs,
            autoContinueCount: run.autoContinueCount ?? 0,
            maxAutoContinue: this.config.autoContinueMax ?? DEFAULT_AUTO_CONTINUE_MAX,
            settleStableMs: SETTLE_STABLE_MS,
            autoContinueQuietMs: AUTO_CONTINUE_QUIET_MS,
            blockingBackgroundTasks: blockingTasks,
            hasActiveChildren: snap?.hasActiveChildren || structuredTasks.hasActiveChildren,
            isCascadeActive: structuredTasks.isCascadeActive,
            sinceLifecycleStartMs,
            launchObservationGraceMs: LAUNCH_OBSERVATION_GRACE_MS,
          });

          if (decision.action === 'wait-background') {
            if (run.settleCandidateSnapshot) {
              run.settleCandidateSnapshot = undefined;
            }
            if ((run.status as string) !== 'waiting-background' || !run.waitingBackgroundStartedAt) {
              run.status = 'waiting-background';
              run.waitingBackgroundStartedAt = Date.now();
            }
            stallSince = Date.now();
            this.notifyWaitingBackgroundToDsh(run, decision.activeTasks ?? blockingTasks);
            this.runs.set(cascadeId, run);
            this.saveStateDebounced();
            if (stepNow === lastStepSeen) {
              idleCycles = Math.min(idleCycles + 1, 5);
            } else {
              idleCycles = 0;
            }
            if (idleCycles > 0) {
              await new Promise((r) => setTimeout(r, idleCycles * 1000));
            }
            continue;
          }

          // Narrow the reason explicitly: only the two auto-continue reasons may
          // drive a nudge. ('background-task'/'background-task-unobserved' are
          // only ever paired with wait-background/wait, so they never reach here.)
          const continueReason: AutoContinueReason | undefined =
            decision.reason === 'tool-tail' || decision.reason === 'no-assistant-text'
              ? decision.reason
              : undefined;

          if (decision.action === 'continue' && continueReason) {
            if (run.settleCandidateSnapshot) {
              run.settleCandidateSnapshot = undefined;
            }
            const sent = await this.sendAutoContinue(cascadeId, run, snap, continueReason);
            if (sent) {
              // Fresh observation window: the watcher re-evaluates against the
              // model's response to the nudge, not the stale pre-nudge tail.
              idleCycles = 0;
              lastStepSeen = -2;
              continue;
            }
            // Nudge delivery failed (or the budget raced): stop nudging and settle
            // with the exhausted flag instead of spinning on an unreachable cascade.
            run.autoContinueExhausted = true;
          }

          // If decision is 'wait' but tail is assistant-text without blocking tasks:
          // Record Round 1 snapshot early so the confirmation interval begins!
          if (
            decision.action === 'wait' &&
            snap.tailKind === 'assistant-text' &&
            snap.plannerContents.length > 0 &&
            !hasBlockingTasks
          ) {
            if (!run.settleCandidateSnapshot) {
              run.settleCandidateSnapshot = {
                stepIndex: snap.maxStepIndex,
                transcriptHash: computeTranscriptHash(snap),
                firstSeenAt: Date.now(),
              };
              this.runs.set(cascadeId, run);
            }
          }

          if (decision.action === 'settle' || decision.action === 'settle-exhausted' || run.autoContinueExhausted) {
            const currentHash = computeTranscriptHash(snap);

            // Round 1 check: initialize snapshot if not yet set
            if (!run.settleCandidateSnapshot) {
              run.settleCandidateSnapshot = {
                stepIndex: snap.maxStepIndex,
                transcriptHash: currentHash,
                firstSeenAt: Date.now(),
              };
              this.runs.set(cascadeId, run);
              await new Promise((r) => setTimeout(r, 1000));
              continue;
            }

            // Check if confirmation interval (≥10s) has elapsed
            const confirmationElapsed = Date.now() - run.settleCandidateSnapshot.firstSeenAt;
            if (confirmationElapsed < SETTLE_CONFIRMATION_INTERVAL_MS) {
              await new Promise((r) => setTimeout(r, 1000));
              continue;
            }

            // Round 2: fresh query bypassing cache
            const freshSnap = await readCascadeTranscript(brainDir, cascadeId, baseline);
            const freshTasks = await this.getStructuredCascadeTasks(
              cascadeId,
              brainDir,
              freshSnap?.maxStepIndex ?? -1,
              true /* forceRefresh bypassing cache! */,
            );
            let freshPendingApproval = Boolean(freshSnap?.pendingApproval);
            if (freshPendingApproval) {
              const client = await this.getHubClient();
              freshPendingApproval = await client.isCascadeAwaitingApproval(cascadeId);
            }
            const freshStepNow = freshSnap?.maxStepIndex ?? -1;
            const freshHash = computeTranscriptHash(freshSnap);
            const freshActiveTasks = freshTasks.activeTasks.filter(
              (t) => !this.isTaskSilenced(cascadeId, t.taskId).infinite
            );

            const isConsistent =
              freshSnap &&
              !freshSnap.error &&
              !freshPendingApproval &&
              freshSnap.isFinished &&
              freshStepNow === run.settleCandidateSnapshot.stepIndex &&
              freshHash === run.settleCandidateSnapshot.transcriptHash &&
              freshActiveTasks.length === 0 &&
              !freshTasks.hasActiveChildren &&
              !freshTasks.isCascadeActive &&
              // D2: round 2 must agree that the launch observation window has
              // closed. `freshActiveTasks.length === 0` is only evidence of
              // "no background work" once the hub has had time to publish any.
              Date.now() - (run.startedAt ?? Date.now()) >= LAUNCH_OBSERVATION_GRACE_MS;

            if (!isConsistent) {
              console.log(
                `[antigravity] Cascade ${cascadeId} two-phase settle confirmation rejected: fresh read inconsistent with round 1 snapshot. `
                + `(step: ${run.settleCandidateSnapshot.stepIndex} -> ${freshStepNow}, hashMatch: ${freshHash === run.settleCandidateSnapshot.transcriptHash}, `
                + `tasks: ${freshActiveTasks.length}, activeChildren: ${freshTasks.hasActiveChildren}, cascadeActive: ${freshTasks.isCascadeActive}). Resetting settle gate.`
              );
              run.settleCandidateSnapshot = undefined;
              stallSince = Date.now();
              this.runs.set(cascadeId, run);
              continue;
            }

            // Both rounds verified consistent! Clear candidate snapshot and settle.
            run.settleCandidateSnapshot = undefined;
            const exhausted = decision.action === 'settle-exhausted' || run.autoContinueExhausted === true;
            if (exhausted) run.autoContinueExhausted = true;
            if (snap.plannerContents.length > 0) {
              run.status = 'done';
              run.error = undefined;
              run.settledStepIndex = snap.maxStepIndex;
              run.settledContentHash = crypto
                .createHash('sha256')
                .update(snap.plannerContents.join('\n\n'))
                .digest('hex');
              run.residualBackgroundTasks = residualTasks.length > 0 ? residualTasks.map((t) => t.taskId) : undefined;
              this.runs.set(cascadeId, run);
              this.saveStateDebounced();
              await this.landReport(run);
              this.notifySettlementToDsh(run);
              this.settleWaiters(cascadeId, {
                status: 'done',
                content: AntigravityService.fullReportText(run),
                lastActiveAt: run.lastActiveAt,
                autoContinueCount: run.autoContinueCount,
                autoContinueExhausted: run.autoContinueExhausted,
                activeBackgroundTasks: snap.activeBackgroundTasks,
                residualBackgroundTasks: run.residualBackgroundTasks,
              });
              // R1: watcher done-驻留: 不 break，继续轮询以捕获假 done，直到 watchMaxMs 结束才真正退出
              await new Promise((r) => setTimeout(r, 2000));
              continue;
            } else {
              // Turn ended with zero assistant text and the nudge budget is gone:
              // an honest error beats silently polling until the watcher cap.
              run.status = 'error';
              run.error = run.error ? `${run.error} (auto-continue exhausted)` : `Turn ended without any assistant text reply; auto-continue budget (${this.config.autoContinueMax ?? DEFAULT_AUTO_CONTINUE_MAX}) exhausted after ${run.autoContinueCount ?? 0} nudge(s).`;
              this.runs.set(cascadeId, run);
              this.saveStateDebounced();
              await this.landReport(run);
              this.notifySettlementToDsh(run);
              this.settleWaiters(cascadeId, {
                status: 'error',
                content: AntigravityService.fullReportText(run),
                error: run.error,
                lastActiveAt: run.lastActiveAt,
                autoContinueCount: run.autoContinueCount,
                autoContinueExhausted: true,
              });
            }
            break;
          }
          // decision.action === 'wait': the transcript is still moving (or a
          // turn-setup CHECKPOINT is waiting for the model to start) — keep polling.
        }

        // Idle backoff: poll less aggressively while the cascade makes no progress.
        if (stepNow === lastStepSeen) {
          idleCycles = Math.min(idleCycles + 1, 5);
        } else {
          idleCycles = 0;
        }
        if (idleCycles > 0) {
          await new Promise((r) => setTimeout(r, idleCycles * 1000));
        }
      } catch (loopErr) {
        const run = this.runs.get(cascadeId) ?? {
          cascadeId,
          status: 'running' as const,
          startedAt: Date.now(),
          baselineStepIndex: -1,
          turnSeq: 1,
          priorContents: [] as string[],
        };
        const errText = loopErr instanceof Error ? loopErr.message : String(loopErr);
        const { resumed } = await this.handleCascadeError(cascadeId, run, errText, snap?.maxStepIndex);
        if (resumed) {
          idleCycles = 0;
          lastStepSeen = -2;
          stallSince = Date.now();
          continue;
        }
        break;
      }
    }

      if (Date.now() >= deadline) {
        const run = this.runs.get(cascadeId);
        if (run && (run.status === 'running' || run.status === 'awaiting-approval')) {
          run.status = 'timeout';
          run.error = `Cascade execution timed out after ${Math.round(watchMs / 1000)}s (lifecycle watcher cap)`;
          this.runs.set(cascadeId, run);
          this.saveStateDebounced();
          await this.landReport(run);
          this.notifySettlementToDsh(run);
          this.settleWaiters(cascadeId, { status: 'timeout', content: AntigravityService.fullReportText(run), error: run.error, lastActiveAt: run.lastActiveAt });
        }
      }
    } catch (err) {
      const run = this.runs.get(cascadeId) ?? { cascadeId, status: 'running' as const, startedAt: Date.now(), turnSeq: 1, priorContents: [] };
      const errText = err instanceof Error ? err.message : String(err);
      await this.handleCascadeError(cascadeId, run, errText);
    } finally {
      this.watchers.delete(cascadeId);
      this.saveStateDebounced();
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
      await client.sendMessage(cascadeId, next.content, { planModel: await this.planModelFor(client, cascadeId) });
      const run = this.runs.get(cascadeId) ?? {
        cascadeId,
        status: 'running' as const,
        startedAt: Date.now(),
        baselineStepIndex,
        turnSeq: 1,
        priorContents: [] as string[],
        callerAgent: next.callerAgent,
      };
      AntigravityService.rearmRun(run, baselineStepIndex, next.callerAgent);
      this.runs.set(cascadeId, run);

      // Make sure unified watcher is running
      this.ensureActiveWatcher(cascadeId, next.callerAgent, baselineStepIndex);
      this.saveStateDebounced();

      let delivered = await this.confirmMessageDelivered(brainDir, cascadeId, next.content);
      if (!delivered) {
        try {
          await client.sendMessage(cascadeId, next.content, { planModel: await this.planModelFor(client, cascadeId) });
          delivered = await this.confirmMessageDelivered(brainDir, cascadeId, next.content, 10_000);
        } catch {
          // fall through
        }
      }

      if (!delivered) {
        next.resolve(`DELIVERY FAILED for ${cascadeId}: message not visible in transcript after send + resend.`);
        return;
      }

      if (next.wait) {
        const timeoutMs =
          typeof next.wait === 'number' && next.wait > 0
            ? next.wait * 1000
            : (this.config.pollTimeoutMs ?? 300_000);
        const res = await this.waitForSettlement(cascadeId, timeoutMs, baselineStepIndex);
        if (res.status === 'error') {
          next.reject(new Error(res.error || 'Antigravity execution failed'));
        } else {
          const shaped = await this.shapeResult(cascadeId, res.content, this.runs.get(cascadeId));
          next.resolve(shaped.content || '[Antigravity returned no planner output]');
        }
      } else {
        next.resolve(`Queued message sent to ${cascadeId}`);
      }
    } catch (err) {
      next.reject(err);
    } finally {
      this.saveStateDebounced();
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
    await this.stateInitPromise;
    const client = await this.getHubClient();
    const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
    const brainDir = `${appDataDir}/brain`;

    let baselineStepIndex = -1;
    if (conversationId) {
      const preSnap = await readCascadeTranscript(brainDir, conversationId, -1);
      baselineStepIndex = preSnap?.maxStepIndex ?? -1;
    }

    let planModel: string | undefined;
    if (!conversationId) {
      const targetInput = projectId || this.config.projectId || process.cwd();
      const resolvedProj = await client.resolveOrCreateProject(targetInput);
      const resolvedModel = await client.resolveModel(model || this.config.defaultModel || DEFAULT_MODEL_ID);
      if (!resolvedModel) {
        throw new Error(`Model "${model || this.config.defaultModel}" not found on hub; call antigravity_list_models for valid ids.`);
      }
      planModel = resolvedModel;
      const cascadeId = crypto.randomUUID();
      await client.startCascade({
        cascadeId,
        requestedModel: resolvedModel,
        projectId: resolvedProj.projectId,
        workspaceUri: resolvedProj.workspaceUri,
        sidebarVisible: this.config.sidebarVisible !== false,
      });
      this.cascadeModelDisplays.set(cascadeId, model || this.config.defaultModel || DEFAULT_MODEL_ID);
      conversationId = cascadeId;
      baselineStepIndex = -1;
    }

    const startedAt = Date.now();
    await client.sendMessage(conversationId, task, {
      planModel: planModel ?? await this.planModelFor(client, conversationId),
    });

    // New turn into this cascade: archive the prior turn's text and re-arm the run.
    const existing = this.runs.get(conversationId);
    if (existing) {
      AntigravityService.rearmRun(existing, baselineStepIndex, callerAgent);
      existing.startedAt = startedAt;
      this.runs.set(conversationId, existing);
    } else {
      const run: HubRun = {
        cascadeId: conversationId,
        status: 'running',
        startedAt,
        baselineStepIndex,
        callerAgent,
        turnSeq: 1,
        priorContents: [],
      };
      if (callerAgent) {
        const id = callerAgent.id ?? callerAgent.session?.header?.id ?? callerAgent.name;
        if (id) run.callerAgentId = String(id);
      }
      this.runs.set(conversationId, run);
    }

    // Ensure active watcher is monitoring across entire lifecycle
    this.ensureActiveWatcher(conversationId, callerAgent, baselineStepIndex);
    this.saveStateDebounced();

    if (!background) {
      const result = await this.waitForSettlement(conversationId, this.config.pollTimeoutMs ?? 300_000, baselineStepIndex);
      const run = this.runs.get(conversationId);
      if (result.status === 'awaiting-approval') {
        const tool = result.pendingTool;
        const toolDesc = tool ? `${tool.name} (${tool.action || tool.summary || 'see antigravity_check_run for full args'})` : 'unknown';
        const shapedPartial = await this.shapeResult(conversationId, result.content, run);
        return `[Awaiting Approval in Antigravity IDE]\nTool execution paused waiting for user confirmation: ${toolDesc}\n\nPartial output:\n${shapedPartial.content}`;
      }
      if (result.status === 'error') {
        const partial = result.content ? `\n\nPartial output before error:\n${result.content}` : '';
        throw new Error(`${result.error || 'Antigravity execution failed'}${partial}`);
      }
      const shaped = await this.shapeResult(conversationId, result.content, run);
      const exhaustedNote = result.autoContinueExhausted
        ? `\n\n[autoContinueExhausted] Settled after ${result.autoContinueCount ?? 0} auto-"Continue" nudges without a closing assistant reply; verify the task truly completed via antigravity_check_run.`
        : '';
      return (shaped.content || '[Antigravity returned no planner output]') + exhaustedNote;
    }

    // Short probe (3 seconds) for background runs to detect immediate fast refusal, error, or early completion
    const probeDeadline = Date.now() + 3000;
    while (Date.now() < probeDeadline) {
      await new Promise((r) => setTimeout(r, 250));
      const snap = await readCascadeTranscript(brainDir, conversationId, baselineStepIndex);
      // A CHECKPOINT right after USER_INPUT sets isFinished with zero planner
      // output — that is turn setup, not settlement. Done requires real content.
      // v0.2.6 tail guard: a tool call/result as the LAST valid entry is mid-turn
      // activity (stale isFinished from an earlier final text/CHECKPOINT), never
      // an early-settleable completion — the lifecycle watcher's tail guard
      // handles those with auto-continue instead.
      const probeTailSettleable = snap?.tailKind !== 'tool-call' && snap?.tailKind !== 'tool-result';
      const isCandidate = snap && !snap.error && !snap.pendingApproval && snap.isFinished;
      let structuredTasks: StructuredCascadeTasksResult = { activeTasks: [], allTasks: [], hasActiveChildren: false };
      if (isCandidate) {
        structuredTasks = await this.getStructuredCascadeTasks(
          conversationId,
          brainDir,
          snap.maxStepIndex,
          true,
        );
        if (structuredTasks.activeTasks.length > 0 || structuredTasks.allTasks.length > 0 || structuredTasks.hasActiveChildren) {
          snap.activeBackgroundTasks = structuredTasks.activeTasks;
          snap.hasActiveChildren = structuredTasks.hasActiveChildren;
        }
      }
      const activeTasks = snap?.activeBackgroundTasks ?? structuredTasks.activeTasks;
      const hasBlockingTasks = activeTasks.some((t) => {
        const silence = this.isTaskSilenced(conversationId, t.taskId);
        return !silence.infinite;
      }) || Boolean(snap?.hasActiveChildren || structuredTasks.hasActiveChildren);
      const terminalDone = !!(
        snap?.isFinished &&
        snap.plannerContents.length > 0 &&
        probeTailSettleable &&
        !hasBlockingTasks
      );
      let pendingConfirmed = false;
      if (snap?.pendingApproval) {
        const isReal = await client.isCascadeAwaitingApproval(conversationId);
        if (isReal) {
          await new Promise((r) => setTimeout(r, 1500));
          const stillReal = await client.isCascadeAwaitingApproval(conversationId);
          if (stillReal) {
            pendingConfirmed = true;
          }
        }
      }
      const isAutoResumeCandidate =
        !!snap?.error &&
        this.config.autoResume?.enabled !== false &&
        isTransientRetryableError(snap.error);

      if (snap && (terminalDone || (snap.error && !isAutoResumeCandidate) || pendingConfirmed)) {
        const status = (snap.error && !isAutoResumeCandidate) ? 'error' : pendingConfirmed ? 'awaiting-approval' : 'done';
        const run = this.runs.get(conversationId) ?? {
          cascadeId: conversationId,
          status: 'running' as const,
          startedAt,
          baselineStepIndex,
          callerAgent,
          turnSeq: 1,
          priorContents: [] as string[],
        };
        run.status = status;
        run.content = snap.plannerContents.join('\n\n');
        run.lastActiveAt = snap.lastActiveAt;
        run.pendingTool = snap.pendingApproval;
        run.error = status === 'error' ? snap.error : undefined;
        if (status === 'done') {
          const residualTasks = activeTasks.filter((t) => {
            const silence = this.isTaskSilenced(conversationId, t.taskId);
            return silence.infinite;
          });
          run.residualBackgroundTasks = residualTasks.length > 0 ? residualTasks.map((t) => t.taskId) : undefined;
          run.settledStepIndex = snap.maxStepIndex;
        }
        this.runs.set(conversationId, run);
        await this.landReport(run);

        return JSON.stringify({
          cascadeId: conversationId,
          status,
          earlySettled: true,
          elapsedMs: Date.now() - startedAt,
          content: run.content || null,
          pendingTool: run.pendingTool || null,
          error: run.error || null,
          reportPath: run.reportPath ?? null,
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

  /** Inspect a background run; wait supports boolean or timeout in seconds. With wait>0 the
   *  call parks on the cascade watcher's settlement events (no polling of its own) and, at
   *  the deadline, returns the latest honestly-observed snapshot instead of a fabricated status. */
  async hubCheckRun(runId: string, wait: boolean | number = false, callerAgent?: any): Promise<unknown> {
    await this.stateInitPromise;
    const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
    const brainDir = `${appDataDir}/brain`;
    const existingRun = this.runs.get(runId);
    const startedAt = existingRun?.startedAt ?? Date.now();
    const baselineStepIndex = existingRun?.baselineStepIndex ?? -1;
    if (callerAgent && existingRun) {
      existingRun.callerAgent = callerAgent;
      const id = callerAgent.id ?? callerAgent.session?.header?.id ?? callerAgent.name;
      if (id) existingRun.callerAgentId = String(id);
    }

    const timeoutMs =
      typeof wait === 'number' && wait > 0
        ? wait * 1000
        : wait === true
        ? (this.config.pollTimeoutMs ?? 300_000)
        : 0;

    if (timeoutMs > 0) {
      // The watcher is the only poller; attach one when the cascade is genuinely live but
      // unwatched (e.g. after a plugin reload). Already-finished cascades skip this — the
      // fast path in waitForSettlement classifies them instantly.
      // v0.2.6: the fast path no longer settles tail-guard stalls (tool tail / no
      // assistant text), so attach a watcher for those too — its tail guard
      // auto-continues them instead of leaving the cascade unwatched.
      if (!this.watchers.has(runId)) {
        const probe = await readCascadeTranscript(brainDir, runId, baselineStepIndex);
        if (probe && probe.engaged && !probe.pendingApproval) {
          const toolTail = probe.tailKind === 'tool-call' || probe.tailKind === 'tool-result';
          const stalledNoText = probe.isFinished && probe.plannerContents.length === 0;
          const stalledToolTail = probe.isFinished && probe.plannerContents.length > 0 && toolTail;
          const hasActiveTasks = Boolean(probe.activeBackgroundTasks && probe.activeBackgroundTasks.length > 0);
          if (!probe.isFinished || stalledNoText || stalledToolTail || hasActiveTasks) {
            this.ensureActiveWatcher(runId, callerAgent || existingRun?.callerAgent, baselineStepIndex);
          }
        }
      }

      const detailed = await this.waitForSettlement(runId, timeoutMs, baselineStepIndex);
      const run = this.runs.get(runId);
      const shaped = await this.shapeResult(runId, detailed.content || undefined, run);

      return AntigravityService.lossless({
        cascadeId: runId,
        status: detailed.status,
        pendingTool: detailed.pendingTool ?? null,
        lastActiveAt: detailed.lastActiveAt ?? null,
        elapsedMs: Date.now() - startedAt,
        content: shaped.content || null,
        contentTruncated: shaped.truncated,
        totalChars: shaped.totalChars || null,
        reportPath: shaped.reportPath ?? null,
        error: detailed.error || null,
        autoContinueCount: detailed.autoContinueCount ?? run?.autoContinueCount ?? 0,
        autoContinueExhausted: detailed.autoContinueExhausted ?? run?.autoContinueExhausted ?? false,
        activeBackgroundTasks: detailed.activeBackgroundTasks ?? null,
      });
    }

    // Instant snapshot check
    const detailed = await this.classifySnapshot(brainDir, runId, baselineStepIndex);
    const run = this.runs.get(runId);
    const shaped = await this.shapeResult(runId, detailed.content || undefined, run);

    return AntigravityService.lossless({
      cascadeId: runId,
      status: detailed.status,
      pendingTool: detailed.pendingTool ?? null,
      lastActiveAt: detailed.lastActiveAt ?? null,
      elapsedMs: Date.now() - startedAt,
      content: shaped.content || null,
      contentTruncated: shaped.truncated,
      totalChars: shaped.totalChars || null,
      reportPath: shaped.reportPath ?? null,
      error: detailed.error || null,
      autoContinueCount: detailed.autoContinueCount ?? run?.autoContinueCount ?? 0,
      autoContinueExhausted: detailed.autoContinueExhausted ?? run?.autoContinueExhausted ?? false,
      activeBackgroundTasks: detailed.activeBackgroundTasks ?? null,
    });
  }

  /** Best-effort confirmation that a sent user message materialized in the cascade transcript. */
  private async confirmMessageDelivered(brainDir: string, cascadeId: string, content: string, timeoutMs = 8000): Promise<boolean> {
    // Probe with a run of plain letters/numbers: they appear verbatim in the JSONL
    // (CJK included), unlike quotes/backslashes/whitespace which get JSON-escaped.
    const probe = (content.match(/[\p{L}\p{N}]{8,}/u)?.[0] ?? '').slice(0, 24);
    if (!probe) return true; // nothing distinctive to probe; skip confirmation
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const loaded = await loadTranscriptFile(brainDir, cascadeId);
      if (loaded && loaded.text.includes(probe)) return true;
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
    await this.stateInitPromise;
    const appDataDir = this.config.appDataDir || getDefaultAppDataDir();
    const brainDir = `${appDataDir}/brain`;

    const hasActiveWatcher = this.watchers.has(conversationId);
    const existingRun = this.runs.get(conversationId);
    let isRunning =
      hasActiveWatcher ||
      existingRun?.status === 'running' ||
      existingRun?.status === 'awaiting-approval';

    const isConfirmedDead =
      !hasActiveWatcher &&
      existingRun !== undefined &&
      (existingRun.status === 'done' || existingRun.status === 'error' || existingRun.status === 'timeout');

    if (!isRunning && !isConfirmedDead) {
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

    // D2 launch hysteresis, running/idle half. `existingRun.startedAt` is the
    // bridge's own record of when it issued the launch. Inside
    // LAUNCH_OBSERVATION_GRACE_MS the hub has not necessarily registered the
    // cascade's background tasks yet, so "no active watcher, no running status,
    // nothing in the transcript" is UNKNOWN rather than evidence of idleness.
    // Taking the idle path there re-arms the run and sends into a lane that is
    // still working — the message vanishes hub-side with no error, and any
    // interrupt issued later lands on a cascade that never stopped.
    if (!isRunning && !isConfirmedDead && existingRun?.startedAt !== undefined) {
      if (Date.now() - existingRun.startedAt < LAUNCH_OBSERVATION_GRACE_MS) {
        isRunning = true;
        console.warn(
          `[antigravity] Cascade ${conversationId} launched ${Math.round((Date.now() - existingRun.startedAt) / 1000)}s ago; `
          + 'treating it as running (launch observation window) instead of concluding idleness from an empty task list.',
        );
      }
    }

    if (isRunning) {
      if (mode === 'turn-end') {
        // Ensure active watcher exists so flushMessageQueue will be triggered upon turn completion!
        if (!this.watchers.has(conversationId)) {
          this.ensureActiveWatcher(conversationId, callerAgent);
        }

        // Queue safely until current turn completes naturally
        return new Promise((resolve, reject) => {
          let queue = this.messageQueues.get(conversationId);
          if (!queue) {
            queue = [];
            this.messageQueues.set(conversationId, queue);
          }
          const callerAgentId =
            callerAgent?.id ??
            callerAgent?.session?.header?.id ??
            callerAgent?.name;
          queue.push({
            content,
            wait,
            mode,
            callerAgent,
            callerAgentId: callerAgentId ? String(callerAgentId) : undefined,
            enqueuedAt: Date.now(),
            resolve,
            reject,
          });
          this.saveStateDebounced();
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

      await client.sendMessage(conversationId, content, { planModel: await this.planModelFor(client, conversationId) });
      const runningRun = this.runs.get(conversationId) ?? {
        cascadeId: conversationId,
        status: 'running' as const,
        startedAt: Date.now(),
        baselineStepIndex,
        turnSeq: 1,
        priorContents: [] as string[],
        callerAgent,
      };
      AntigravityService.rearmRun(runningRun, baselineStepIndex, callerAgent);
      this.runs.set(conversationId, runningRun);

      // Ensure active watcher tracks the newly resumed run
      this.ensureActiveWatcher(conversationId, callerAgent, baselineStepIndex);
      this.saveStateDebounced();

      let delivered = await this.confirmMessageDelivered(brainDir, conversationId, content);
      if (!delivered) {
        // The cancel+inject sequence raced the hub; retry once as a plain send.
        try {
          await client.sendMessage(conversationId, content, { planModel: await this.planModelFor(client, conversationId) });
          delivered = await this.confirmMessageDelivered(brainDir, conversationId, content, 10_000);
        } catch {
          // fall through to failure report
        }
      }

      if (!delivered) {
        return `DELIVERY FAILED for ${conversationId}: message not visible in transcript after send + plain resend. The cascade may need a fresh conversation or IDE-side nudge.`;
      }

      if (!wait) {
        return `Message injected into ${conversationId} (${mode}); transcript delivery confirmed.`;
      }

      const timeoutMs =
        typeof wait === 'number' && wait > 0
          ? wait * 1000
          : (this.config.pollTimeoutMs ?? 300_000);
      const result = await this.waitForSettlement(conversationId, timeoutMs, baselineStepIndex);
      if (result.status === 'error') {
        throw new Error(result.error || 'Antigravity execution failed');
      }
      const shaped = await this.shapeResult(conversationId, result.content, this.runs.get(conversationId));
      return shaped.content || '[Antigravity returned no planner output]';
    }

    const preSnap = await readCascadeTranscript(brainDir, conversationId, -1);
    const baselineStepIndex = preSnap?.maxStepIndex ?? -1;

    const client = await this.getHubClient();
    await client.sendMessage(conversationId, content, { planModel: await this.planModelFor(client, conversationId) });
    const idleRun = this.runs.get(conversationId) ?? {
      cascadeId: conversationId,
      status: 'running' as const,
      startedAt: Date.now(),
      baselineStepIndex,
      turnSeq: 1,
      priorContents: [] as string[],
      callerAgent,
    };
    AntigravityService.rearmRun(idleRun, baselineStepIndex, callerAgent);
    this.runs.set(conversationId, idleRun);

    // Ensure active watcher tracks the run
    this.ensureActiveWatcher(conversationId, callerAgent, baselineStepIndex);
    this.saveStateDebounced();

    let delivered = await this.confirmMessageDelivered(brainDir, conversationId, content);
    if (!delivered) {
      // One retry before reporting failure (hub occasionally drops the first send
      // for conversations in odd states).
      try {
        await client.sendMessage(conversationId, content, { planModel: await this.planModelFor(client, conversationId) });
        delivered = await this.confirmMessageDelivered(brainDir, conversationId, content, 10_000);
      } catch {
        // fall through to failure report
      }
    }

    if (!delivered) {
      return `DELIVERY FAILED for ${conversationId}: message not visible in transcript after send + resend. The conversation may be in a hub-side dead state; start a fresh cascade.`;
    }

    if (!wait) {
      return `Message sent to ${conversationId}; transcript delivery confirmed.`;
    }

    const timeoutMs =
      typeof wait === 'number' && wait > 0
        ? wait * 1000
        : (this.config.pollTimeoutMs ?? 300_000);
    const result = await this.waitForSettlement(conversationId, timeoutMs, baselineStepIndex);
    if (result.status === 'error') {
      throw new Error(result.error || 'Antigravity execution failed');
    }
    const shaped = await this.shapeResult(conversationId, result.content, this.runs.get(conversationId));
    return shaped.content || '[Antigravity returned no planner output]';
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

  constructor(ctx: Context, config: LiveAntigravityConfig) {
    // Snapshot the live volatile references into plain values once; refresh on
    // `loader/volatile-update` below. All service fields are read at use-time,
    // so replacing the service reference is sufficient (no remount).
    const current = () => snapshotAntigravityConfig(config);
    ctx.plugin(AntigravityService, current());

    // 0.1.7 settings seam: this instance ships its own Plugins-page card, so it
    // registers `configure({ auto: false })` and refreshes from the live
    // references on `loader/volatile-update` (volatile-only changes; an
    // ordinary-field change remounts instead). Without a settings provider the
    // callback never fires and the composition entry stands as the whole config.
    // dsh-settings is optional; inject waits for the service instead of racing
    // the boot order — a direct ctx.get here can silently miss it and the
    // settings policy never registers.
    ctx.inject(['settings'] as any, (settingsCtx) => {
      // The settings service is an undeclared inject in this plugin's compile
      // env, so the typed Context has no `settings` property — cast once here.
      const settings = (settingsCtx as unknown as {
        settings: {
          configure(presentation: { auto?: boolean }, owner?: unknown): () => void;
        };
      }).settings;
      settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber));
    });
    ctx.on('loader/volatile-update', () => {
      (ctx.get('antigravity') as AntigravityService | undefined)?.updateConfig(current());
    });

    ctx.inject(['agents'] as any, () => {
      (ctx.get('antigravity') as AntigravityService | undefined)?.rebindAgents().catch(() => {});
    });

    if ((ctx as any).systemPrompt?.register) {
      (ctx as any).systemPrompt.register({
        name: 'antigravity-guide',
        order: 118,
        render: () => `## Google Antigravity Agent Tools
Google Antigravity (AGY) is Google's multi-agent coding harness running locally on this machine. The default backend is "hub": sessions run INSIDE the local Antigravity IDE and burn the IDE's own OAuth quota (not Google Cloud billing).
- 'gemini-3.8-flash-high' (default): Gemini quota group (very generous limit), 1M context, fast multimodal; use for general and parallel coding subtasks.
- 'claude-opus-4-6-thinking': non-Gemini quota group (strict limit); deep reasoning for tough challenges.
- 'antigravity_list_models' shows the live model catalog with remaining quota fractions.
- 'antigravity_delegate' runs a task: with conversation_id it continues that conversation; without, it creates a new cascade (needs project_id or config default). Default blocks until the reply stabilizes; background=true returns a run id immediately so you can keep working, then check with 'antigravity_check_run' (wait=true parks on lifecycle events until done/error/awaiting-approval, or returns the latest snapshot at the timeout).
- Large Antigravity reports are persisted to disk: tool results cap inline content and carry reportPath — read that file for the full text.
- Mid-run steering: 'antigravity_send_message' with wait=false injects guidance into a running conversation.
- 'antigravity_create_project' creates a project (returns projectId).
- 'antigravity_silence_task' silences background task warnings (indefinitely or timed); infinitely silenced tasks do not block cascade settlement.
- 'antigravity_list_conversations' and 'antigravity_get_conversation_tree' browse local session history.
`,
      });
    }

    const tools = (ctx as any).tools;
    if (!tools?.register) return;

    if (current().backend === 'localharness') {
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
          + 'project_id accepts a registered project UUID, an absolute folder path (D:\\path\\to\\dir), or a file:/// URI — folder references '
          + 'bind the cascade directly to that workspace via workspaceUris (the robust form: hub-side project creation is not always persisted, '
          + 'and StartCascade silently no-ops for unregistered project ids). '
          + 'Default: waits for the reply by polling the local transcript (timeout 300s). '
          + 'With background=true: returns a run id immediately; poll it with antigravity_check_run.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'The clear, detailed instruction for the Antigravity agent' },
            model: { type: 'string', description: 'Model display id from antigravity_list_models (default: gemini-3.8-flash-high)' },
            project_id: { type: 'string', description: 'Target project for new cascades: registered project UUID, absolute folder path (preferred), or file:/// URI' },
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
          + 'Set wait=true to block until a lifecycle transition (done/error/awaiting-approval) or timeout — at the deadline it returns the latest observed snapshot instead of fabricating a status. Pass a number for custom seconds (e.g. wait=30). '
          + 'Oversized reports are persisted to disk: content is capped inline and reportPath points at the full text.',
        parameters: {
          type: 'object',
          properties: {
            run_id: { type: 'string', description: 'Cascade UUID returned by a background delegate or external conversation' },
            wait: { description: 'Block until done/error/awaiting-approval or timeout. Pass true for default timeout (300s), or a number for custom seconds (e.g. 30).' },
          },
          required: ['run_id'],
        },
        output: { schema: { type: 'object' }, render: renderText },
        execute: async (args: { run_id: string; wait?: boolean | number }, execContext?: any) => {
          const callerAgent = execContext?.agent;
          // Model-authored polling of an existing lane: the model is demonstrably
          // engaged, so refund its notice wake budget.
          (ctx.get('antigravity') as AntigravityService | undefined)?.noteModelActivity(callerAgent);
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
          // Model-authored steering of an existing lane: refund the wake budget.
          (ctx.get('antigravity') as AntigravityService | undefined)?.noteModelActivity(callerAgent);
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
        description: 'Create a new Antigravity project rooted at a local folder and verify the hub persisted it. '
          + 'Returns the generated projectId for use with antigravity_delegate. '
          + 'NOTE: current hub builds accept CreateProject but often never persist the project; this tool then throws, '
          + 'in which case simply pass folder_uri itself as project_id to antigravity_delegate (folder-bound start).',
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

      tools.register({
        name: 'antigravity_silence_task',
        description: 'Silence waiting-background warning notifications for a specific background task ID. '
          + 'If duration_seconds <= 0 or omitted, silences indefinitely. '
          + 'Infinitely silenced tasks do not block cascade settlement when idle; when settled, the settlement notice will carry a residual task warning.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'Background task ID to silence (e.g. "task-123" or "123")' },
            cascade_id: { type: 'string', description: 'Optional cascade UUID. If omitted, applies to the active cascade and globally.' },
            duration_seconds: { type: 'number', description: 'Optional duration in seconds to silence warnings. If omitted or <= 0, silences indefinitely.' },
          },
          required: ['task_id'],
        },
        output: { schema: { type: 'object' }, render: renderText },
        execute: async (args: { task_id: string; cascade_id?: string; duration_seconds?: number }) => {
          return (ctx.get('antigravity') as AntigravityService).silenceTask(
            args.cascade_id || '',
            args.task_id,
            args.duration_seconds,
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
export * from './hub/classifier.js';
