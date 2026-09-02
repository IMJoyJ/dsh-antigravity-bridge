import { Context, Service } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { ChildProcess } from "node:child_process";
import protobuf from "protobufjs";
import WebSocket from "ws";
import { EventEmitter } from "node:events";
//#region src/engine.d.ts
interface HarnessSessionInfo {
  port: number;
  apiKey: string;
  ws: WebSocket;
  process: ChildProcess;
}
interface EngineConfig {
  binaryPath?: string;
  protoDir?: string;
  env?: Record<string, string>;
  appDataDir?: string;
}
declare class AntigravityEngine {
  private protoRoot?;
  private binaryPath;
  private protoDir;
  constructor(config?: EngineConfig);
  loadProtos(): Promise<protobuf.Root>;
  spawnSession(options?: {
    workspaces?: string[];
    appDataDir?: string;
    env?: Record<string, string>;
  }): Promise<HarnessSessionInfo>;
}
//#endregion
//#region src/media.d.ts
interface MediaInput {
  type?: 'image' | 'audio' | 'video' | 'document' | 'file';
  path?: string;
  mimeType?: string;
  data?: Buffer | Uint8Array | string;
  description?: string;
}
type PromptItem = string | MediaInput;
type PromptContent = PromptItem | PromptItem[];
interface ProtoMediaPart {
  text?: string;
  media?: {
    mimeType: string;
    description?: string;
    data: string;
  };
  slashCommand?: {
    name: string;
  };
}
/**
 * Guesses MIME type from file path extension.
 */
declare function guessMimeType(filePath: string): string;
/**
 * Reads a local file and converts it to a Base64-encoded MediaInput object.
 */
declare function fileToMedia(filePath: string, options?: {
  mimeType?: string;
  description?: string;
}): Promise<MediaInput>;
/**
 * Normalizes dynamic PromptContent (strings, file paths, MediaInputs) into Protobuf-compatible UserInput parts.
 */
declare function normalizePromptParts(content: PromptContent): Promise<ProtoMediaPart[]>;
//#endregion
//#region src/client.d.ts
type SessionContinuationMode = 'resume' | 'create_or_resume' | 'create_only' | number;
interface TokenUsage {
  promptTokens: number;
  candidatesTokens: number;
  thoughtsTokens: number;
  cachedContentTokens: number;
  totalTokens: number;
}
interface AgentInitConfig {
  model?: string;
  conversationId?: string;
  sessionContinuationMode?: SessionContinuationMode;
  systemInstructions?: string;
  workspaces?: string[];
  skillsPaths?: string[];
  appDataDir?: string;
  tools?: Array<{
    name: string;
    description: string;
    parametersJsonSchema: string;
  }>;
}
interface AgentStep {
  status: string;
  source?: string;
  content?: string;
  thought?: string;
  error?: string;
  raw?: any;
}
declare class AntigravityAgent extends EventEmitter {
  private session?;
  private engine;
  private protoRoot?;
  private currentConversationId?;
  private currentModel;
  private usage;
  constructor(engine?: AntigravityEngine);
  get conversationId(): string | undefined;
  get model(): string;
  get latestUsage(): TokenUsage;
  private resolveContinuationMode;
  start(config?: AgentInitConfig): Promise<void>;
  private handleMessage;
  /**
   * Sends dynamic PromptContent (strings, file attachments, MediaInputs).
   */
  sendPrompt(content: PromptContent): Promise<void>;
  sendToolResponse(callId: string, result: string): Promise<void>;
  close(): Promise<void>;
}
//#endregion
//#region src/storage.d.ts
interface ConversationSummary {
  id: string;
  lastModified: string;
  lastModifiedTimestamp: number;
  firstPromptSnippet?: string;
  taskTitle?: string;
  depth: number;
  isSubagent: boolean;
  parentId?: string | null;
  childIds: string[];
  dbPath: string;
  brainPath?: string;
}
interface ConversationTreeNode extends ConversationSummary {
  children: ConversationTreeNode[];
}
interface ListConversationsOptions {
  appDataDir?: string;
  limit?: number;
  onlyRoots?: boolean;
  includeSubagents?: boolean;
  maxDepth?: number;
  parentId?: string;
}
/**
 * Gets default Antigravity app data directory path (~/.gemini/antigravity).
 */
declare function getDefaultAppDataDir(): string;
/**
 * Builds the complete conversation hierarchy graph from local storage.
 */
declare function buildConversationGraph(options?: {
  appDataDir?: string;
}): Promise<Map<string, ConversationSummary>>;
/**
 * Lists existing Antigravity conversations with filtering options for root vs subagent sessions.
 */
declare function listConversations(options?: ListConversationsOptions): Promise<ConversationSummary[]>;
/**
 * Renders conversation tree into a readable ASCII diagram.
 */
declare function renderAsciiTree(node: ConversationTreeNode, prefix?: string): string;
/**
 * Gets conversation hierarchy trees (JSON structured and ASCII rendered).
 */
declare function getConversationTree(options?: {
  appDataDir?: string;
  conversationId?: string;
  limit?: number;
}): Promise<{
  trees: ConversationTreeNode[];
  ascii: string;
}>;
//#endregion
//#region src/models.d.ts
interface AntigravityModelInfo {
  id: string;
  name: string;
  group: 'gemini' | 'non-gemini';
  aliases: string[];
  recommended: boolean;
  contextWindow: string;
  description: string;
}
declare const ANTIGRAVITY_MODELS: AntigravityModelInfo[];
declare const DEFAULT_MODEL_ID = "gemini-3.8-flash";
/**
 * Normalizes input model name or alias to canonical Antigravity model ID.
 */
declare function normalizeModelName(input?: string): string;
//#endregion
//#region src/hub/transcript.d.ts
interface TranscriptStep {
  step_index: number;
  source: string;
  type: string;
  status: string;
  content?: string;
  created_at?: string;
  tool_calls?: Array<{
    name: string;
    args?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
}
interface PendingToolApproval {
  name: string;
  args?: Record<string, unknown>;
  action?: string;
  summary?: string;
  requestedAt?: string;
}
interface PollResult {
  done: boolean;
  content: string;
  status?: 'done' | 'awaiting-approval' | 'running' | 'timeout' | 'error';
  pendingTool?: PendingToolApproval;
  lastActiveAt?: string;
  error?: string;
}
interface TranscriptSnapshot {
  maxStepIndex: number;
  engaged: boolean;
  plannerContents: string[];
  lastActiveAt?: string;
  pendingApproval?: PendingToolApproval;
  isFinished?: boolean;
  error?: string;
}
interface ParsedTranscript {
  maxStepIndex: number;
  /** step_index of the latest completed USER_INPUT (our prompt). */
  userInputIndex: number;
  /** PLANNER_RESPONSE contents after userInputIndex, in order. */
  plannerContents: string[];
  /** Any MODEL step exists after userInputIndex (agent engaged). */
  engagedAfterInput: boolean;
  /** CHECKPOINT seen after userInputIndex. */
  checkpointAfterInput: boolean;
  /** Latest timestamp seen in the transcript. */
  lastActiveAt?: string;
  /** If the cascade is currently suspended on a pending tool call awaiting approval/completion. */
  pendingApproval?: PendingToolApproval;
  /** Whether the trajectory reached a definitive finished state (e.g. final text reply or checkpoint). */
  isFinished: boolean;
  /** short_error from the first ERROR_MESSAGE step, if any. */
  error?: string;
}
declare function parseTranscript(lines: string[], baselineStepIndex?: number): ParsedTranscript;
interface LoadedTranscript {
  path: string;
  text: string;
  mtimeMs: number;
}
/**
 * Loads the cascade transcript from disk, preferring the full fidelity transcript
 * (`transcript_full.jsonl`) over the compact/truncated view (`transcript.jsonl`).
 * Evaluated dynamically per read so callers cleanly handle files appearing at different times.
 */
declare function loadTranscriptFile(brainDir: string, cascadeId: string): Promise<LoadedTranscript | undefined>;
/** One-shot read+parse of a cascade transcript; undefined when the file does not exist yet. */
declare function readCascadeTranscript(brainDir: string, cascadeId: string, baselineStepIndex?: number): Promise<TranscriptSnapshot | undefined>;
/**
 * Polls a cascade's transcript until the planner answered (file stable
 * for `stableMs` or a CHECKPOINT follows the reply), an approval is needed,
 * an error step appears, or the timeout elapses.
 */
declare function pollTranscript(brainDir: string, cascadeId: string, timeoutMs?: number, pollIntervalMs?: number, stableMs?: number, baselineStepIndex?: number): Promise<PollResult>;
//#endregion
//#region src/hub/discovery.d.ts
interface HubInfo {
  address: string;
  csrfToken: string;
}
declare function discoverHub(config?: {
  address?: string;
  csrfToken?: string;
}): Promise<HubInfo>;
declare function clearHubCache(): void;
//#endregion
//#region src/hub/projects.d.ts
interface ResolvedProject {
  projectId: string;
  workspaceUri: string;
  projectName: string;
  created: boolean;
}
//#endregion
//#region src/hub/client.d.ts
interface StartCascadeOptions {
  cascadeId: string;
  requestedModel: string;
  /** Registered project UUID. */
  projectId?: string;
  /** Folder URI (file:///...) to bind the cascade to directly. */
  workspaceUri?: string;
  /** true (default): trajectory source JETBOX so the cascade shows in the IDE
   *  sidebar (agy ≥ 2.9.1 routes CASCADE_CLIENT to externalSummaries; the hub
   *  REJECTS UNSPECIFIED/omitted source on StartCascade — JETBOX is the only
   *  accepted source the frontend classifies as local); false: keep
   *  CASCADE_CLIENT (external, hidden from sidebar). */
  sidebarVisible?: boolean;
}
interface HubCallOptions {
  /** Passed through to grpcWebCall: 'reject' makes a frame-less 200 body throw
   *  HubTransportError (data-returning methods), 'allow' decodes it as an
   *  empty message (methods whose empty response is legitimate). */
  emptyResponse?: 'allow' | 'reject';
}
/**
 * Decides whether an error from a hub call means the cached hub endpoint is
 * stale and one rediscovery + retry could still succeed. Covers:
 * - {@link HubTransportError} (HTTP-level failure or rejected frame-less body);
 * - Node fetch network failures, whose ECONNREFUSED and friends live in
 *   `err.cause` — the outer message is just "fetch failed" — including
 *   AggregateError causes with multiple inner errors;
 * - the pre-existing message conventions "401" / "Unauthenticated".
 */
declare function isStaleHubError(err: unknown): boolean;
declare class HubClient {
  private info;
  /** Config from {@link HubClient.create}; the self-heal retry re-discovers
   *  with it so config-pinned setups stay pinned (and just get one transparent
   *  retry) while dynamic setups get real rediscovery. */
  private readonly createConfig?;
  private registry;
  private projectResolver;
  constructor(info: HubInfo, createConfig?: {
    address?: string;
    csrfToken?: string;
  });
  /** Resolves a folder path or project UUID to a registered project UUID and workspace URI,
   *  automatically creating a new project on the hub if no existing project matches. */
  resolveOrCreateProject(folderOrId?: string): Promise<ResolvedProject>;
  static create(config?: {
    address?: string;
    csrfToken?: string;
  }): Promise<HubClient>;
  getAvailableModels(): Promise<unknown>;
  /** Maps a display id (e.g. "gemini-3.8-flash-high") to the hub's
   *  MODEL_* enum name. Response shape: { response: { models: { id: {...} } } }. */
  resolveModel(displayId: string): Promise<string | undefined>;
  startCascade(opts: StartCascadeOptions): Promise<unknown>;
  sendMessage(cascadeId: string, text: string): Promise<unknown>;
  /** Server-side wait until the conversation is fully idle. Returns
   *  { timedOut?: boolean } — an empty object means the idle state was reached. */
  waitForIdle(conversationId: string, inactivityTimeoutSeconds: number, stabilizationDurationSeconds: number): Promise<{
    timedOut?: boolean;
  }>;
  getConversationMetadata(conversationId: string): Promise<unknown>;
  /** Creates a project and returns the caller-generated id (hub responds with {}).
   *  The hub accepts CreateProject with grpc status 0 but may never persist the
   *  project (ReadProject then reports notFoundOnDisk). Verify persistence and
   *  throw an honest error so callers can fall back to folder-bound starts. */
  createProject(name: string, folderUri: string): Promise<{
    projectId: string;
  }>;
  readProject(id: string): Promise<unknown>;
  deleteProject(id: string): Promise<unknown>;
  searchConversations(query: string, limit?: number): Promise<unknown>;
  /** Cancel an ongoing cascade invocation in a clean manner. */
  cancelCascade(cascadeId: string, killBackgroundTasks?: boolean): Promise<unknown>;
  /** Fetch the full cascade trajectory (steps carry requestedInteraction when awaiting approval). */
  getCascadeTrajectory(cascadeId: string): Promise<unknown>;
  /** Answer a pending cascade user interaction (the IDE approval dialog's RPC). */
  handleCascadeUserInteraction(cascadeId: string, interaction: Record<string, unknown>): Promise<unknown>;
  /**
   * Accurately checks whether the cascade is genuinely blocked waiting for interactive user approval in the IDE.
   * Distinguishes between auto-approved/running tools (which take seconds to execute) and actual modal prompts.
   */
  isCascadeAwaitingApproval(cascadeId: string): Promise<boolean>;
  call(method: string, json: Record<string, unknown>, options?: HubCallOptions): Promise<unknown>;
  private rawCall;
}
//#endregion
//#region src/hub/classifier.d.ts
/**
 * Error signature classifier for transient vs terminal cascade errors in Google Antigravity.
 *
 * Transient retryable errors:
 * 1. Empty model output ('model_output_empty')
 * 2. Interrupted stream ('stream_interrupted')
 * 3. Expired OAuth access token ('auth_token_expired') - HTTP 401 with invalid_token / UNAUTHENTICATED
 *
 * Terminal non-retryable errors:
 * - DELIVERY FAILED / hub-side dead state
 * - 403 / PERMISSION_DENIED (permission issues)
 * - Persistent OAuth failure ("OAuth 凭据已失效，请重新登录 Antigravity", invalid_grant, revoked refresh token)
 */
type TransientErrorSignature = 'model_output_empty' | 'stream_interrupted' | 'auth_token_expired';
interface ErrorClassification {
  /** Whether this error is a transient error eligible for auto-resume. */
  retryable: boolean;
  /** Transient error signature identifier if retryable. */
  signature?: TransientErrorSignature;
  /** Explanatory reason if terminal / non-retryable. */
  reason?: string;
  /** Normalized raw error message text. */
  rawError: string;
}
/** Default exponential backoff delay schedule for auto-resume: 2s, 5s, 10s. */
declare const BACKOFF_SCHEDULE_MS: readonly [2000, 5000, 10000];
/**
 * Checks if the error string matches an expired/invalid OAuth access token (HTTP 401 invalid_token / UNAUTHENTICATED).
 */
declare function isAuthTokenExpiredError(rawError: string): boolean;
/**
 * Get backoff delay in ms for a given 0-based retry index.
 * For auth_token_expired, returns 1000ms (1s) to allow hub-side token refresh.
 * For other transient errors: 0 -> 2000ms, 1 -> 5000ms, 2+ -> 10000ms.
 */
declare function getAutoResumeBackoffMs(retryIndex: number, signature?: TransientErrorSignature): number;
/**
 * Get maximum allowed retries for a given error signature.
 * auth_token_expired is capped at 2 retries; standard transient errors use config (default 3).
 */
declare function getMaxRetriesForSignature(signature?: TransientErrorSignature, configMaxRetries?: number): number;
/**
 * Format terminal error for expired/invalid OAuth credentials.
 */
declare function formatAuthExpiredTerminalError(details?: string): string;
/**
 * Format error message when auto-resume retries are exhausted.
 */
declare function formatExhaustedRetryError(retries: number, originalError: string, signature?: TransientErrorSignature): string;
/**
 * Extracts the error string from various error containers (Error object, step, snapshot, string, HTTP response object).
 */
declare function extractErrorMessage(input: unknown): string;
/**
 * Classifies an error input into transient retryable vs terminal.
 */
declare function classifyError(error: unknown): ErrorClassification;
/**
 * Fast boolean check if an error is a transient retryable cascade error.
 */
declare function isTransientRetryableError(error: unknown): boolean;
//#endregion
//#region src/index.d.ts
interface AutoResumeConfig {
  /** Automatically resume cascade on transient errors (default true). */
  enabled?: boolean;
  /** Maximum consecutive auto-resume retries per cascade (default 3). */
  maxRetries?: number;
  /** Instruction sent to the cascade when resuming (default "继续。按原计划继续执行当前任务，不要停止。"). */
  message?: string;
}
interface AntigravityConfig {
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
}
declare const Config: Schema<AntigravityConfig>;
declare module '@deepseek-ai/cordis' {
  interface Context {
    antigravity: AntigravityService;
  }
}
interface RunOneShotOptions extends AgentInitConfig {
  attachments?: string[];
}
/** Live state of one background hub delegation, keyed by cascade id. */
interface HubRun {
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
}
interface CascadeDetailedResult {
  status: 'done' | 'awaiting-approval' | 'running' | 'timeout' | 'error';
  content: string;
  lastActiveAt?: string;
  pendingTool?: PendingToolApproval;
  error?: string;
}
interface SettlementNoticePayload {
  summary: string;
  noticeText: string;
  isRefusalOrEarlyDeath: boolean;
}
declare function buildSettlementNotice(run: HubRun): SettlementNoticePayload;
declare class AntigravityService extends Service {
  private engine;
  private config;
  private hubClient?;
  private runs;
  private watchers;
  private messageQueues;
  /** Callers parked inside waitForSettlement, keyed by cascade id; resolved by the watcher's transitions. */
  private settlementWaiters;
  private disposed;
  constructor(ctx: Context, config: AntigravityConfig);
  /** Hot-swap live config (settings namespace onChange). All fields are read at use-time. */
  updateConfig(config: AntigravityConfig): void;
  /** Proactively push a settlement/approval notice to DSH session (steering / followup) with idempotency. */
  notifySettlementToDsh(run: HubRun, callerAgent?: any): void;
  /** Push a resumption notice when user approvals in IDE are granted. */
  notifyResumedToDsh(run: HubRun, callerAgent?: any): void;
  createAgent(initConfig?: AgentInitConfig): AntigravityAgent;
  listModels(): AntigravityModelInfo[];
  /** Coalesce undefined leaves to null so tool output stays lossless JSON. */
  private static lossless;
  listConversations(options?: ListConversationsOptions): Promise<ConversationSummary[]>;
  getConversationTree(options?: {
    conversationId?: string;
    limit?: number;
  }): Promise<{
    trees: ConversationTreeNode[];
    ascii: string;
  }>;
  runOneShot(prompt: PromptContent, options?: RunOneShotOptions): Promise<string>;
  private getHubClient;
  /** Hub GetAvailableModels, slimmed to the fields a model caller needs. */
  hubListModels(): Promise<unknown>;
  /** Ensure an active background watcher exists and monitors this cascade's lifecycle until final settlement.
   *  Entry points (delegate/send/queue flush) must rearm the run themselves via {@link rearmRun}; this method
   *  only creates a missing run record and starts the single poller. */
  ensureActiveWatcher(cascadeId: string, callerAgent?: any, baselineStepIndex?: number): void;
  /** Archive the previous turn's final text, bump the turn counter, and re-arm the run for a new delegation. */
  private static rearmRun;
  /** Whole-cascade accumulated report text: every settled prior turn plus the current one. */
  private static fullReportText;
  /**
   * Persist an oversized report so nothing is unreachable from the session. The harness
   * spill seam (`ctx.spillStore`) is preferred when mounted; otherwise a private
   * owner-only file lands under `<appDataDir>/dsh-reports/<cascadeId>/`. Small reports
   * stay inline-only and skip persistence entirely.
   */
  private landReport;
  /** Best-effort full-text persistence: spill seam first, private file fallback. Returns a model-facing locator. */
  private persistText;
  /**
   * Bound a report body to the configured inline budget. Oversized bodies are persisted
   * first and returned as head preview + locator line, mirroring DSH's spill policy shape.
   */
  private shapeResult;
  /**
   * Event-driven settlement wait: resolves on the cascade watcher's next state transition
   * (done / error / awaiting-approval), or returns the honest instant snapshot at the
   * deadline. There is deliberately NO self-managed polling loop here — hub idle probes
   * report false idleness during long silent executor steps, which made wait=true return
   * after seconds. The per-cascade watcher is the single poller.
   */
  private waitForSettlement;
  /** Release every parked settlement waiter for this cascade (watcher transition point). */
  private settleWaiters;
  /**
   * One-shot transcript classification of a cascade; refreshes the run record and returns
   * the same detailed result shape the wait path resolves with. Shared by check_run's
   * instant path and waitForSettlement's deadline path.
   */
  private classifySnapshot;
  /**
   * Evaluates a cascade error: if transient and retry budget remains, archives current content,
   * waits backoff, bumps the baseline, sends the resume message to the hub, and returns { resumed: true }.
   * Otherwise marks terminal error, lands report, notifies DSH, settles waiters, and returns { resumed: false }.
   */
  private handleCascadeError;
  /** Unified active cascade loop — the SINGLE poller per cascade. Tracks running/approval/error/done
   *  transitions off the local transcript, notifies DSH, releases parked settlement waiters, and lands
   *  oversized reports on disk. WaitForConversationFullyIdle is deliberately NOT used here: the hub
   *  reports false idleness during long silent executor steps, which caused both premature returns and
   *  premature done classifications. */
  private runCascadeWatcher;
  /** Flush any messages that were queued while the cascade was actively generating or running. */
  private flushMessageQueue;
  hubDelegate(task: string, model?: string, projectId?: string, conversationId?: string, background?: boolean, callerAgent?: any): Promise<string>;
  /** Inspect a background run; wait supports boolean or timeout in seconds. With wait>0 the
   *  call parks on the cascade watcher's settlement events (no polling of its own) and, at
   *  the deadline, returns the latest honestly-observed snapshot instead of a fabricated status. */
  hubCheckRun(runId: string, wait?: boolean | number, callerAgent?: any): Promise<unknown>;
  /** Best-effort confirmation that a sent user message materialized in the cascade transcript. */
  private confirmMessageDelivered;
  hubSendMessage(conversationId: string, content: string, wait?: boolean | number, mode?: 'step-end' | 'turn-end' | 'interrupt', callerAgent?: any): Promise<unknown>;
  /**
   * Answer a pending approval in the IDE programmatically (YOLO leaves network/permission
   * prompts blocking; this is the orchestrator-side approval channel).
   * Reads the pending interaction from the live trajectory and answers it via
   * HandleCascadeUserInteraction. confirm=false rejects.
   */
  hubRespondApproval(cascadeId: string, confirm: boolean, scope?: string): Promise<unknown>;
  hubCreateProject(name: string, folderUri: string): Promise<unknown>;
}
declare class AntigravityBridgePlugin {
  static name: string;
  static Config: Schema<AntigravityConfig>;
  static inject: string[];
  constructor(ctx: Context, config: AntigravityConfig);
}
//#endregion
export { ANTIGRAVITY_MODELS, AgentInitConfig, AgentStep, AntigravityAgent, AntigravityConfig, AntigravityEngine, AntigravityModelInfo, AntigravityService, AutoResumeConfig, BACKOFF_SCHEDULE_MS, CascadeDetailedResult, Config, ConversationSummary, ConversationTreeNode, DEFAULT_MODEL_ID, EngineConfig, ErrorClassification, HarnessSessionInfo, HubCallOptions, HubClient, HubInfo, HubRun, ListConversationsOptions, LoadedTranscript, MediaInput, PendingToolApproval, PollResult, PromptContent, PromptItem, ProtoMediaPart, RunOneShotOptions, SessionContinuationMode, SettlementNoticePayload, StartCascadeOptions, TokenUsage, TranscriptSnapshot, TranscriptStep, TransientErrorSignature, buildConversationGraph, buildSettlementNotice, classifyError, clearHubCache, AntigravityBridgePlugin as default, discoverHub, extractErrorMessage, fileToMedia, formatAuthExpiredTerminalError, formatExhaustedRetryError, getAutoResumeBackoffMs, getConversationTree, getDefaultAppDataDir, getMaxRetriesForSignature, guessMimeType, isAuthTokenExpiredError, isStaleHubError, isTransientRetryableError, listConversations, loadTranscriptFile, normalizeModelName, normalizePromptParts, parseTranscript, pollTranscript, readCascadeTranscript, renderAsciiTree };
//# sourceMappingURL=index.d.mts.map