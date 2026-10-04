import { Context, Service, Volatile } from "@deepseek-ai/cordis";
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
//#region src/hub/trajectory.d.ts
/**
 * CortexStepStatus code mappings:
 * PENDING=1, RUNNING=2, WAITING=9, GENERATING=8, QUEUED=11 (Active)
 * DONE=3, CLEARED=5, CANCELED=6, ERROR=7, INTERRUPTED=12 (Terminal)
 */
declare const CORTEX_ACTIVE_STATUS_CODES: Set<number>;
declare const CORTEX_TERMINAL_STATUS_CODES: Set<number>;
declare const CORTEX_ACTIVE_STATUS_NAMES: Set<string>;
declare const CORTEX_TERMINAL_STATUS_NAMES: Set<string>;
interface StatusTransition {
  updatedStatus?: string | number;
  timestamp?: string;
}
interface TrajectoryStepDetail {
  id?: string;
  logUri?: string;
  log_uri?: string;
  description?: string;
  summary?: string;
  toolSummary?: string;
  tool_summary?: string;
}
interface TrajectoryStepMetadata {
  createdAt?: string;
  created_at?: string;
  internalMetadata?: {
    statusTransitions?: StatusTransition[];
  };
  internal_metadata?: {
    status_transitions?: StatusTransition[];
  };
  hasActiveChildren?: boolean;
  has_active_children?: boolean;
}
interface TrajectoryStep {
  stepIndex?: number;
  step_index?: number;
  type?: string | number;
  status?: string | number;
  taskDetails?: TrajectoryStepDetail;
  task_details?: TrajectoryStepDetail;
  metadata?: TrajectoryStepMetadata;
  hasSubtrajectory?: boolean;
  has_subtrajectory?: boolean;
  [key: string]: unknown;
}
interface TrajectoryResponse {
  trajectory?: {
    cascadeId?: string;
    steps?: TrajectoryStep[];
    metadata?: Record<string, unknown>;
    hasActiveChildren?: boolean;
    has_active_children?: boolean;
  };
  status?: string | number;
  hasActiveChildren?: boolean;
  has_active_children?: boolean;
}
interface StructuredCascadeTasksResult {
  activeTasks: ActiveBackgroundTask[];
  allTasks: ActiveBackgroundTask[];
  hasActiveChildren: boolean;
  isCascadeActive?: boolean;
  /** Whether the cascade has been explicitly canceled or interrupted. */
  isCanceled?: boolean;
  /** Whether any step in the trajectory has status CANCELED (6) or INTERRUPTED (12). */
  hasCanceledStep?: boolean;
  /** Parent conversation ID if this cascade is a child subagent. */
  parentConversationId?: string;
  /** Indicates whether this result comes from an authoritative query (Hub or SQLite) */
  authoritative?: boolean;
}
/**
 * CascadeRunStatus mappings (from protobuf exa.cortex_pb.CascadeRunStatus):
 * UNSPECIFIED=0, IDLE=1
 * RUNNING=2, CANCELING=3, BUSY=4 (Active)
 */
declare const CASCADE_RUN_ACTIVE_CODES: Set<number>;
declare const CASCADE_RUN_ACTIVE_NAMES: Set<string>;
declare function isCascadeRunStatusActive(status: unknown): boolean;
declare function isCortexStatusActive(status: unknown): boolean;
declare function isCortexStatusTerminal(status: unknown): boolean;
/**
 * Resolves the effective status of a trajectory step, taking into account both
 * the top-level status and the latest transition in metadata.internalMetadata.statusTransitions.
 */
declare function getStepEffectiveStatus(step: TrajectoryStep): {
  isActive: boolean;
  isTerminal: boolean;
  status: string | number;
};
/**
 * Parses full GetCascadeTrajectory response into structured tasks and active child session flag.
 *
 * 活跃任务判定（零正则）：
 * taskDetails != null 且最新状态 ∈ 活跃集合 (PENDING=1, RUNNING=2, WAITING=9, GENERATING=8, QUEUED=11)
 *
 * 残余盲区①：
 * subagent 子会话：父帧/轨迹中 has_active_children 布尔或 INVOKE_SUBAGENT 处于活跃状态时，hasActiveChildren 为 true。
 */
declare function parseStructuredTrajectoryTasks(trajectoryResp: unknown, targetCascadeId?: string): StructuredCascadeTasksResult;
/**
 * Decodes a protobuf serialized task_details blob from SQLite steps table.
 * Wire format:
 * Field 1: string id
 * Field 2: string log_uri
 * Field 4: string description
 */
declare function decodeProtobufTaskDetails(buf: Buffer): {
  id?: string;
  logUri?: string;
  log_uri?: string;
  description?: string;
};
/**
 * Reads background tasks directly from SQLite conversation database as a reliable fallback.
 * Path: ~/.gemini/antigravity/conversations/<cascadeId>.db
 */
declare function readStructuredTasksFromSqlite(cascadeId: string, customDbDir?: string): StructuredCascadeTasksResult | undefined;
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
/**
 * Classification of the LAST valid entry inside the current turn window.
 * Drives the tail guard that distinguishes a genuinely finished turn from a
 * model that merely paused mid-work (e.g. launched a background task and is
 * waiting on it).
 */
type TranscriptTailKind = 'none' | 'assistant-text' | 'tool-call' | 'tool-result' | 'checkpoint' | 'other';
interface ActiveBackgroundTask {
  taskId: string;
  description?: string;
  startedAt?: string;
  startStepIndex: number;
  durationSeconds?: number;
  isSchedule?: boolean;
  logUri?: string;
  lastProgressAt?: string;
  isStalled?: boolean;
  stalledDurationMs?: number;
}
/**
 * 默认后台任务静默上限 (ms)：15分钟。
 * 任务超过该时长无任何日志写入或进展，在通知和状态中上报为「疑似停滞 (Suspected Stalled)」，
 * 但绝不粗暴误杀合法长时任务。
 */
declare const DEFAULT_BACKGROUND_TASK_STALL_THRESHOLD_MS: number;
/**
 * 迟滞窗口 (ms)：后台任务的「迟滞性」观测窗口。
 *
 * The hub does NOT register a cascade's background tasks at StartCascade /
 * SendUserCascadeMessage time. The executor has to run for a few seconds before
 * GetCascadeTrajectory starts carrying `taskDetails` for it, so a probe issued
 * right after launch legitimately reads `activeBackgroundTasks: []`.
 *
 * An empty task list inside this window therefore means "not observed yet", NOT
 * "there is no background work". Reading it as "none" settles a lane that is
 * still running and forces a later revert-from-done — the false-idle defect.
 *
 * Size rationale (latency-neutral by construction): the settle path already
 * requires `settleStableMs` (15s) of transcript stillness before it even records
 * a candidate, plus `SETTLE_CONFIRMATION_INTERVAL_MS` (10s) of two-phase
 * confirmation. The last transcript movement can never predate the launch, so
 * the earliest possible settle is launch + ~25s. A 20s window therefore sits
 * strictly inside waiting that already happens and adds no settle latency.
 */
declare const LAUNCH_OBSERVATION_GRACE_MS = 20000;
interface TranscriptSnapshot {
  maxStepIndex: number;
  engaged: boolean;
  plannerContents: string[];
  lastActiveAt?: string;
  pendingApproval?: PendingToolApproval;
  isFinished?: boolean;
  error?: string;
  /** Kind of the last valid entry in the turn window (settlement tail guard). */
  tailKind: TranscriptTailKind;
  /** Active (uncompleted) background tasks discovered in the transcript. */
  activeBackgroundTasks?: ActiveBackgroundTask[];
  /** 残余盲区①：whether subagent child sessions are currently active. */
  hasActiveChildren?: boolean;
  /** First created_at timestamp in transcript (anchors cascade start time). */
  firstCreatedAt?: string;
  /** Whether any step in the transcript carries explicit cancellation status. */
  hasCanceledStep?: boolean;
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
  /** Kind of the last valid entry in the turn window. */
  tailKind: TranscriptTailKind;
  /** short_error from the first ERROR_MESSAGE step, if any. */
  error?: string;
  /** Active (uncompleted) background tasks discovered in the transcript. */
  activeBackgroundTasks: ActiveBackgroundTask[];
  /** 残余盲区①：whether subagent child sessions are currently active. */
  hasActiveChildren?: boolean;
  /** First created_at timestamp in transcript (anchors cascade start time). */
  firstCreatedAt?: string;
  /** Whether any step in the transcript carries explicit cancellation status. */
  hasCanceledStep?: boolean;
}
/**
 * Pure observational tools that do not constitute substantive foreground work.
 * Invoking these tools does not imply that previous background tasks have finished.
 */
declare const OBSERVATIONAL_TOOL_NAMES: Set<string>;
/**
 * R2 等待话术门:
 * Inspects whether the planner's final text output conveys waiting on a background task,
 * timer, or background execution without genuine completion semantics.
 */
declare function isWaitingSpeech(text: string | undefined | null): boolean;
declare function isTaskIdMatch(a: string, b: string): boolean;
/**
 * 残余盲区②：结构化不可得的唯一例外。
 * IDE 层定时调度任务（如 schedule 工具创建的计时器），其触发完成通知仅以 SYSTEM_MESSAGE 注入，
 * 不产生独立的 tool execution step 状态变更。因此保留且仅保留这一条窄正则识别该通知，提取完成的任务 ID。
 */
declare const IDE_TIMER_SYSTEM_MESSAGE_REGEX: RegExp;
/**
 * Parses raw JSON lines from a cascade transcript into a structured snapshot.
 *
 * @param lines Raw lines read from transcript_full.jsonl or transcript.jsonl
 * @param baselineStepIndex If >= 0, only steps with step_index > baselineStepIndex
 *        are inspected for user input and completion signals.
 * @param cascadeId Target cascade ID for task isolation. Tasks belonging to a
 *        different cascade prefix are discarded.
 */
declare function parseTranscript(lines: string[], baselineStepIndex?: number, cascadeId?: string): ParsedTranscript;
type AutoContinueReason = 'tool-tail' | 'no-assistant-text';
type SettleGuardReason = AutoContinueReason | 'background-task' | 'background-task-unobserved';
type SettleGuardAction = 'settle' | 'settle-exhausted' | 'continue' | 'wait' | 'wait-background';
interface SettleGuardInput {
  snap: Pick<TranscriptSnapshot, 'isFinished' | 'plannerContents' | 'tailKind' | 'engaged' | 'pendingApproval' | 'error' | 'activeBackgroundTasks' | 'hasActiveChildren' | 'hasCanceledStep'>;
  /** Optional active background tasks that block settlement (non-infinite-silenced). If omitted, defaults to snap.activeBackgroundTasks. */
  blockingBackgroundTasks?: ActiveBackgroundTask[];
  /** 残余盲区①：Optional flag indicating active subagent child sessions. If omitted, defaults to snap.hasActiveChildren. */
  hasActiveChildren?: boolean;
  /** Turn-level active status from GetCascadeTrajectory (CascadeRunStatus RUNNING/BUSY/CANCELING). */
  isCascadeActive?: boolean;
  /** Whether the cascade has been explicitly stopped or canceled by user. */
  isCanceled?: boolean;
  /**
   * How long ago the bridge recorded this cascade lifecycle (launch / re-arm)
   * — i.e. `now - HubRun.startedAt`. Optional: omitted means "no launch
   * information available" and disables the {@link LAUNCH_OBSERVATION_GRACE_MS}
   * hysteresis, preserving the pre-fix behaviour for callers that cannot supply it.
   */
  sinceLifecycleStartMs?: number;
  /** Override for the launch-hysteresis window (tests / tuning). Defaults to {@link LAUNCH_OBSERVATION_GRACE_MS}. */
  launchObservationGraceMs?: number;
  /** How long the transcript has produced no new steps (ms). */
  tailQuietMs: number;
  /** Auto-continue nudges already spent on the current turn. */
  autoContinueCount: number;
  /** Auto-continue nudge budget per turn. */
  maxAutoContinue: number;
  /** Required stillness before a clean final reply may settle (ms). */
  settleStableMs: number;
  /** Required stillness before a stalled turn may be nudged (ms). */
  autoContinueQuietMs: number;
}
interface SettleGuardDecision {
  action: SettleGuardAction;
  reason?: SettleGuardReason;
  activeTasks?: ActiveBackgroundTask[];
}
/**
 * Decides whether a "finished-looking" cascade snapshot may settle as done, or
 * whether the transcript tail proves the model merely paused mid-work and the
 * bridge should nudge it with a "Continue" message instead.
 *
 * Guard conditions (checked at every done-settlement exit):
 * - (0) `background-task`: active background tasks are still running in the
 *   session. Any background task completion sends a message to AGY session from
 *   the hub, waking it up. The turn is NOT complete; do not settle or continue.
 * - (0.5) `background-task-unobserved`: launch hysteresis. The hub only
 *   registers a cascade's background tasks after its executor has run for a few
 *   seconds, so a task list read shortly after launch is empty *because it was
 *   not populated yet*, not because there is no background work. Inside
 *   {@link LAUNCH_OBSERVATION_GRACE_MS} an empty observation is UNKNOWN, so the
 *   honest answer is "keep polling" instead of settling a lane that is still
 *   running (which the done-residency watcher would later have to revert).
 * - (a) `tool-tail`: the LAST valid entry is a tool call or tool result with no
 *   assistant text after it. `isFinished` is then stale state left behind by an
 *   earlier final text or CHECKPOINT (executor DONE steps never reset it) — the
 *   classic false summary "I am waiting for the background test run to
 *   complete." that the transcript carries while the model is actually stalled.
 * - (b) `no-assistant-text`: the whole turn ended without ANY assistant text
 *   reply (e.g. the model launched a background task and yielded silently).
 *
 * Both conditions keep the run unsettled and trigger one capped auto-continue;
 * once the budget (`maxAutoContinue`) is spent the caller settles anyway and
 * flags `autoContinueExhausted` so callers can verify the outcome.
 */
declare function decideTailSettle(input: SettleGuardInput): SettleGuardDecision;
interface LoadedTranscript {
  path: string;
  text: string;
  mtimeMs: number;
}
interface PruneStaleTasksOptions {
  nowMs?: number;
  lastActiveAtMs?: number;
}
/**
 * Prunes stale orphan background tasks that have exceeded their expected lifetime
 * AND whose transcript has ceased growing for at least 15 minutes.
 *
 * Counter-example protection:
 * If the transcript is actively growing (nowMs - lastActiveAtMs < 15 minutes),
 * long-running processes (e.g. `node ygopro-server.js`) MUST NEVER be pruned.
 */
declare function pruneStaleBackgroundTasks(tasks: ActiveBackgroundTask[] | undefined, options?: PruneStaleTasksOptions): {
  activeTasks: ActiveBackgroundTask[];
  prunedTasks: ActiveBackgroundTask[];
};
interface BackgroundTaskProgress {
  isStalled: boolean;
  stalledDurationMs: number;
  lastProgressAt?: string;
  logMtimeMs?: number;
}
/**
 * 评估后台任务进展与停滞状态：
 * 探测任务专属日志文件（task-XXX.log）修改时间（最精确活动心跳）、启动时间与会话最后活跃时间。
 * 当且仅当静默时长 >= stallThresholdMs 时标记为 isStalled（疑似停滞），
 * 但绝不以此为依据强制判死，保障合法长时无输出任务的执行权。
 */
declare function assessBackgroundTaskProgress(task: ActiveBackgroundTask, options?: {
  brainDir?: string;
  cascadeId?: string;
  nowMs?: number;
  stallThresholdMs?: number;
  transcriptLastActiveAt?: string;
}): BackgroundTaskProgress;
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
  /** Registered project UUID. Undefined when a freshly created project failed
   *  the hub persistence check — callers must then bind via {@link workspaceUri}. */
  projectId?: string;
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
  private readonly modelEnumCache;
  /** resolveModel with a per-client cache: one GetAvailableModels RPC per display id. */
  resolveModelCached(displayId: string): Promise<string | undefined>;
  startCascade(opts: StartCascadeOptions): Promise<unknown>;
  /**
   * planModel is REQUIRED whenever the hub may construct a fresh executor for
   * the cascade (idle/hibernated resume): a send without cascadeConfig resets
   * the cascade's model selection to None, and the turn then dies with
   * "neither PlanModel nor RequestedModel specified".
   */
  sendMessage(cascadeId: string, text: string, opts?: {
    planModel?: string;
  }): Promise<unknown>;
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
  /**
   * Fetches and parses structured background tasks directly from GetCascadeTrajectory.
   * 活跃任务判定（零正则）：taskDetails != null 且最新状态 ∈ 活跃集合。
   * 残余盲区①：subagent 子会话 has_active_children 阻塞。
   */
  getCascadeTasks(cascadeId: string): Promise<StructuredCascadeTasksResult>;
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
type TransientErrorSignature = 'model_output_empty' | 'stream_interrupted' | 'auth_token_expired' | 'network_error' | 'model_format_error';
interface ErrorClassification {
  /** Whether this error is a transient error eligible for auto-resume. */
  retryable: boolean;
  /** Transient error signature identifier if retryable. */
  signature?: TransientErrorSignature;
  /** Explanatory reason if terminal / non-retryable. */
  reason?: string;
  /** Normalized raw error message text. */
  rawError: string;
  /** Whether the retry is handled internally by the engine/IDE (bridge should not inject '继续'). */
  engineInternal?: boolean;
  /** Remaining retries reported by the engine/model, if applicable. */
  retriesRemaining?: number;
}
/** Pattern recognizing model format and malformed function call errors. */
declare const MODEL_FORMAT_ERROR_PATTERN: RegExp;
/** Common network, transport, server unavailable, and connection error pattern. */
declare const NETWORK_ERROR_PATTERN: RegExp;
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
 * Checks if the error string matches a network error, connection drop, fetch failure, or socket timeout.
 */
declare function isNetworkError(rawError: string): boolean;
/**
 * Extracts remaining retries count from error messages containing "Retries remaining: N" or similar phrases.
 */
declare function parseRetriesRemaining(rawError: string): number | undefined;
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
/**
 * Check if the error is handled internally by the IDE engine (e.g. model format retry).
 */
declare function isInternalEngineRetryError(error: unknown): boolean;
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
/** Default budget of tail-guard auto-"Continue" nudges per turn. */
declare const DEFAULT_AUTO_CONTINUE_MAX = 5;
/** Default message sent by the tail-guard auto-continue. */
declare const DEFAULT_AUTO_CONTINUE_MESSAGE = "Continue";
/** Stillness (ms) required before a stalled tail may be nudged with "Continue". */
declare const AUTO_CONTINUE_QUIET_MS = 10000;
/** Stillness (ms) required before a final-looking assistant reply may enter two-phase settle confirmation (minimum 15s). */
declare const SETTLE_STABLE_MS = 15000;
/** Minimum interval (ms) required between first-round settle candidate snapshot and second-round fresh confirmation query (10s). */
declare const SETTLE_CONFIRMATION_INTERVAL_MS = 10000;
/** Default absolute cap on background lifecycle watcher in ms (12h). */
declare const DEFAULT_WATCH_MAX_MS = 43200000;
/**
 * Max consecutive settlement/approval notices that may WAKE one agent without
 * an intervening model-authored tool call against an existing lane. Bounds the
 * self-excitation loop "cascade done → wake → model delegates again → done →
 * wake". An idle caller is still woken past the cap (see
 * `AntigravityService.deliverMessageToAgent`): the budget throttles, it never
 * silently discards an undelivered notice.
 */
declare const MAX_CONSECUTIVE_NOTICE_WAKES = 5;
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
  /** Inactivity threshold (ms) of zero log/transcript output before a background task is flagged as suspected-stalled in waiting-background notifications (default 15m, 900,000ms). */
  backgroundTaskStallThresholdMs?: number;
}
declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
  backend: Schema<"hub" | "localharness", "hub" | "localharness", "volatile-defined">;
  binaryPath: Schema<string, string, "volatile">;
  protoDir: Schema<string, string, "volatile">;
  defaultModel: Schema<string, string, "volatile-defined">;
  appDataDir: Schema<string, string, "volatile">;
  projectId: Schema<string, string, "volatile">;
  hubAddress: Schema<string, string, "volatile">;
  hubCsrfToken: Schema<string, string, "volatile">;
  pollTimeoutMs: Schema<number, number, "volatile-defined">;
  watchMaxMs: Schema<number, number, "volatile-defined">;
  inlineCharBudget: Schema<number, number, "volatile-defined">;
  sidebarVisible: Schema<boolean, boolean, "volatile-defined">;
  approvalGraceMs: Schema<number, number, "volatile-defined">;
  autoResume: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: Schema<boolean, boolean, "defined">;
    maxRetries: Schema<number, number, "defined">;
    message: Schema<string, string, "defined">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: Schema<boolean, boolean, "defined">;
    maxRetries: Schema<number, number, "defined">;
    message: Schema<string, string, "defined">;
  }>>>, "volatile-defined">;
  autoContinueMax: Schema<number, number, "volatile-defined">;
  autoContinueMessage: Schema<string, string, "volatile-defined">;
  stallTimeoutMs: Schema<number, number, "volatile-defined">;
  backgroundTaskStallThresholdMs: Schema<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  backend: Schema<"hub" | "localharness", "hub" | "localharness", "volatile-defined">;
  binaryPath: Schema<string, string, "volatile">;
  protoDir: Schema<string, string, "volatile">;
  defaultModel: Schema<string, string, "volatile-defined">;
  appDataDir: Schema<string, string, "volatile">;
  projectId: Schema<string, string, "volatile">;
  hubAddress: Schema<string, string, "volatile">;
  hubCsrfToken: Schema<string, string, "volatile">;
  pollTimeoutMs: Schema<number, number, "volatile-defined">;
  watchMaxMs: Schema<number, number, "volatile-defined">;
  inlineCharBudget: Schema<number, number, "volatile-defined">;
  sidebarVisible: Schema<boolean, boolean, "volatile-defined">;
  approvalGraceMs: Schema<number, number, "volatile-defined">;
  autoResume: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: Schema<boolean, boolean, "defined">;
    maxRetries: Schema<number, number, "defined">;
    message: Schema<string, string, "defined">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: Schema<boolean, boolean, "defined">;
    maxRetries: Schema<number, number, "defined">;
    message: Schema<string, string, "defined">;
  }>>>, "volatile-defined">;
  autoContinueMax: Schema<number, number, "volatile-defined">;
  autoContinueMessage: Schema<string, string, "volatile-defined">;
  stallTimeoutMs: Schema<number, number, "volatile-defined">;
  backgroundTaskStallThresholdMs: Schema<number, number, "volatile-defined">;
}>>, "plain">;
/** Live volatile references delivered by the Loader; snapshot into {@link AntigravityConfig} to read. */
interface LiveAntigravityConfig {
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
  backgroundTaskStallThresholdMs: Volatile<number>;
}
/** Snapshot the live volatile references into plain values. The Loader commits Settings form edits into the running references and emits `loader/volatile-update`; `get()` reads the just-committed value. */
declare function snapshotAntigravityConfig(live: LiveAntigravityConfig): AntigravityConfig;
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
interface RunOneShotOptions extends AgentInitConfig {
  attachments?: string[];
}
/** Live state of one background hub delegation, keyed by cascade id. */
interface HubRun {
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
  /** Whether one or more active background tasks are suspected to be stalled (exceeded stall threshold with zero log/transcript output). */
  hasStalledBackgroundTasks?: boolean;
}
declare function computeTranscriptHash(snap: TranscriptSnapshot | undefined): string;
interface TaskSilenceEntry {
  taskId: string;
  infinite: boolean;
  until?: number;
  silencedAt: number;
}
interface SettlementOutboxItem {
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
interface PersistedRun {
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
  hasStalledBackgroundTasks?: boolean;
}
interface PersistedQueuedMessage {
  content: string;
  wait?: boolean | number;
  mode?: 'step-end' | 'turn-end' | 'interrupt';
  callerAgentId?: string;
  enqueuedAt: number;
}
interface PersistedBridgeState {
  version: 1;
  savedAt: string;
  runs: Record<string, PersistedRun>;
  messageQueues: Record<string, PersistedQueuedMessage[]>;
  settlementOutbox: SettlementOutboxItem[];
}
interface CascadeDetailedResult {
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
  /** Whether one or more active background tasks are suspected to be stalled. */
  hasStalledBackgroundTasks?: boolean;
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
  private settlementOutbox;
  private outboxTimer?;
  private saveStateTimer?;
  stateInitPromise?: Promise<void>;
  private globalTaskSilences;
  /**
   * Consecutive notice-driven wakes per caller agent id. Bounds the
   * self-excitation loop "cascade done → wake the model → model launches another
   * cascade → done → wake again". Refunded by {@link noteModelActivity} when the
   * model itself drives an existing lane.
   */
  private noticeWakeCount;
  private trajectoryTaskCache;
  private disposed;
  constructor(ctx: Context, config: AntigravityConfig);
  getAgentsService(): any;
  findLiveAgent(agentId?: string): any;
  rebindAgents(): Promise<void>;
  private getStateFilePath;
  private shouldPersist;
  saveStateDebounced(): void;
  saveStateNow(): Promise<void>;
  private initState;
  private startOutboxTimer;
  private retrySettlementOutbox;
  private enqueueSettlementOutbox;
  private removeFromSettlementOutbox;
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
  private deliverMessageToAgent;
  /**
   * Invoke one agent delivery seam, proving the method exists first.
   * @returns true only when the call actually ran without throwing.
   */
  private invokeAgentSeam;
  /** Whether this agent has already been woken {@link MAX_CONSECUTIVE_NOTICE_WAKES} times in a row. */
  private wakeBudgetSpent;
  /**
   * Account for one delivered notice and checkpoint the session it was queued
   * into. Only a wakeup-capable seam spends budget; a non-waking injection does
   * not, because it cannot start the self-excitation loop it exists to bound.
   */
  private finishDelivery;
  /** Best-effort identity for an agent, used to scope fallback delivery. */
  private resolveAgentId;
  /**
   * Refund `callerAgent`'s notice wake budget because the model itself is
   * actively driving this lane.
   *
   * Called ONLY from `antigravity_check_run` and `antigravity_send_message`.
   * `antigravity_delegate` deliberately does NOT refund: "notice woke the model
   * → model launched another cascade → done → notice" is precisely the loop the
   * budget bounds, and refunding on every delegate would defeat it.
   */
  noteModelActivity(callerAgent: any): void;
  /** Normalize a task id for dictionary matching. */
  normalizeTaskId(taskId: string): string;
  /**
   * Silence waiting-background warning notifications for a specific task ID.
   * If durationSeconds is omitted or <= 0, silences indefinitely.
   * Infinitely silenced tasks do not block cascade settlement when idle.
   */
  silenceTask(cascadeId: string, rawTaskId: string, durationSeconds?: number): {
    success: boolean;
    cascadeId?: string;
    taskId: string;
    infinite: boolean;
    silencedUntil?: string;
    durationSeconds?: number;
    note: string;
  };
  /**
   * Checks whether a task is currently silenced.
   * Returns { silenced: boolean, infinite: boolean }.
   */
  isTaskSilenced(runOrCascadeId: HubRun | string | undefined, taskId: string, now?: number): {
    silenced: boolean;
    infinite: boolean;
  };
  /** Hot-swap live config (loader/volatile-update snapshot). All fields are read at use-time. */
  updateConfig(config: AntigravityConfig): void;
  /** Proactively push a settlement/approval notice to DSH session (steering / followup) with idempotency. */
  notifySettlementToDsh(run: HubRun, callerAgent?: any): void;
  /** Push a resumption notice when user approvals in IDE are granted. */
  notifyResumedToDsh(run: HubRun, callerAgent?: any): void;
  /** Push a settlement revocation notice when R1 detects that a settled cascade resumed activity. */
  notifyRevertedFromDoneToDsh(run: HubRun, details: {
    oldSettledStep?: number;
    currentStep?: number;
    oldActiveAt?: string;
    currentActiveAt?: string;
  }, callerAgent?: any): void;
  /**
   * Proactively push a waiting-background warning notice to DSH session.
   * Rate-limited to once every 5 minutes (300,000ms) for the same running background task state.
   */
  notifyWaitingBackgroundToDsh(run: HubRun, activeTasks: ActiveBackgroundTask[], callerAgent?: any): void;
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
  /**
   * Retrieves structured background tasks and subagent child status for a cascade.
   * 1. Checks memory cache with throttling to prevent heavy GetCascadeTrajectory polling on every watcher tick.
   * 2. Attempts HubClient.getCascadeTasks(cascadeId).
   * 3. Falls back to SQLite database (~/.gemini/antigravity/conversations/<cascadeId>.db).
   * 4. Falls back to empty list.
   */
  getStructuredCascadeTasks(cascadeId: string, brainDir?: string, currentMaxStep?: number, forceRefresh?: boolean): Promise<StructuredCascadeTasksResult>;
  /**
   * Display-id model chosen for each bridge-started cascade; cascades the bridge
   * did not start fall back to the configured default model.
   */
  private readonly cascadeModelDisplays;
  /**
   * Resolve the MODEL_* enum to attach to SendUserCascadeMessage. Required
   * whenever the hub may construct a fresh executor (idle resume): a send
   * without cascadeConfig resets the cascade's model to None and the turn dies
   * with "neither PlanModel nor RequestedModel specified". Never throws — on
   * resolution failure the caller sends without a model (legacy behavior).
   */
  private planModelFor;
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
  /**
   * Send one tail-guard auto-"Continue" nudge through the existing sendMessage
   * channel and re-arm the run so the pre-nudge transcript is excluded from the
   * next settlement decision (the watcher then judges the model's response TO
   * the nudge, not the stale tail that triggered it). Returns false when the
   * budget is spent or delivery fails — the caller settles with
   * autoContinueExhausted in that case.
   */
  private sendAutoContinue;
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
  static Config: Schema<Schemastery.ObjectS<NoInfer<{
    backend: Schema<"hub" | "localharness", "hub" | "localharness", "volatile-defined">;
    binaryPath: Schema<string, string, "volatile">;
    protoDir: Schema<string, string, "volatile">;
    defaultModel: Schema<string, string, "volatile-defined">;
    appDataDir: Schema<string, string, "volatile">;
    projectId: Schema<string, string, "volatile">;
    hubAddress: Schema<string, string, "volatile">;
    hubCsrfToken: Schema<string, string, "volatile">;
    pollTimeoutMs: Schema<number, number, "volatile-defined">;
    watchMaxMs: Schema<number, number, "volatile-defined">;
    inlineCharBudget: Schema<number, number, "volatile-defined">;
    sidebarVisible: Schema<boolean, boolean, "volatile-defined">;
    approvalGraceMs: Schema<number, number, "volatile-defined">;
    autoResume: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
      enabled: Schema<boolean, boolean, "defined">;
      maxRetries: Schema<number, number, "defined">;
      message: Schema<string, string, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
      enabled: Schema<boolean, boolean, "defined">;
      maxRetries: Schema<number, number, "defined">;
      message: Schema<string, string, "defined">;
    }>>>, "volatile-defined">;
    autoContinueMax: Schema<number, number, "volatile-defined">;
    autoContinueMessage: Schema<string, string, "volatile-defined">;
    stallTimeoutMs: Schema<number, number, "volatile-defined">;
    backgroundTaskStallThresholdMs: Schema<number, number, "volatile-defined">;
  }>>, Schemastery.ObjectT<NoInfer<{
    backend: Schema<"hub" | "localharness", "hub" | "localharness", "volatile-defined">;
    binaryPath: Schema<string, string, "volatile">;
    protoDir: Schema<string, string, "volatile">;
    defaultModel: Schema<string, string, "volatile-defined">;
    appDataDir: Schema<string, string, "volatile">;
    projectId: Schema<string, string, "volatile">;
    hubAddress: Schema<string, string, "volatile">;
    hubCsrfToken: Schema<string, string, "volatile">;
    pollTimeoutMs: Schema<number, number, "volatile-defined">;
    watchMaxMs: Schema<number, number, "volatile-defined">;
    inlineCharBudget: Schema<number, number, "volatile-defined">;
    sidebarVisible: Schema<boolean, boolean, "volatile-defined">;
    approvalGraceMs: Schema<number, number, "volatile-defined">;
    autoResume: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
      enabled: Schema<boolean, boolean, "defined">;
      maxRetries: Schema<number, number, "defined">;
      message: Schema<string, string, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
      enabled: Schema<boolean, boolean, "defined">;
      maxRetries: Schema<number, number, "defined">;
      message: Schema<string, string, "defined">;
    }>>>, "volatile-defined">;
    autoContinueMax: Schema<number, number, "volatile-defined">;
    autoContinueMessage: Schema<string, string, "volatile-defined">;
    stallTimeoutMs: Schema<number, number, "volatile-defined">;
    backgroundTaskStallThresholdMs: Schema<number, number, "volatile-defined">;
  }>>, "plain">;
  static inject: string[];
  constructor(ctx: Context, config: LiveAntigravityConfig);
}
//#endregion
export { ANTIGRAVITY_MODELS, AUTO_CONTINUE_QUIET_MS, ActiveBackgroundTask, AgentInitConfig, AgentStep, AntigravityAgent, AntigravityConfig, AntigravityEngine, AntigravityModelInfo, AntigravityService, AutoContinueReason, AutoResumeConfig, BACKOFF_SCHEDULE_MS, BackgroundTaskProgress, CASCADE_RUN_ACTIVE_CODES, CASCADE_RUN_ACTIVE_NAMES, CORTEX_ACTIVE_STATUS_CODES, CORTEX_ACTIVE_STATUS_NAMES, CORTEX_TERMINAL_STATUS_CODES, CORTEX_TERMINAL_STATUS_NAMES, CascadeDetailedResult, Config, ConversationSummary, ConversationTreeNode, DEFAULT_AUTO_CONTINUE_MAX, DEFAULT_AUTO_CONTINUE_MESSAGE, DEFAULT_BACKGROUND_TASK_STALL_THRESHOLD_MS, DEFAULT_MODEL_ID, DEFAULT_WATCH_MAX_MS, EngineConfig, ErrorClassification, HarnessSessionInfo, HubCallOptions, HubClient, HubInfo, HubRun, IDE_TIMER_SYSTEM_MESSAGE_REGEX, LAUNCH_OBSERVATION_GRACE_MS, ListConversationsOptions, LiveAntigravityConfig, LoadedTranscript, MAX_CONSECUTIVE_NOTICE_WAKES, MODEL_FORMAT_ERROR_PATTERN, MediaInput, NETWORK_ERROR_PATTERN, OBSERVATIONAL_TOOL_NAMES, PendingToolApproval, PersistedBridgeState, PersistedQueuedMessage, PersistedRun, PollResult, PromptContent, PromptItem, ProtoMediaPart, PruneStaleTasksOptions, RunOneShotOptions, SETTLE_CONFIRMATION_INTERVAL_MS, SETTLE_STABLE_MS, SessionContinuationMode, SettleGuardAction, SettleGuardDecision, SettleGuardInput, SettleGuardReason, SettlementNoticePayload, SettlementOutboxItem, StartCascadeOptions, StatusTransition, StructuredCascadeTasksResult, TaskSilenceEntry, TokenUsage, TrajectoryResponse, TrajectoryStep, TrajectoryStepDetail, TrajectoryStepMetadata, TranscriptSnapshot, TranscriptStep, TranscriptTailKind, TransientErrorSignature, assessBackgroundTaskProgress, buildConversationGraph, buildSettlementNotice, classifyError, clearHubCache, computeTranscriptHash, decideTailSettle, decodeProtobufTaskDetails, AntigravityBridgePlugin as default, discoverHub, extractErrorMessage, fileToMedia, formatAuthExpiredTerminalError, formatExhaustedRetryError, getAutoResumeBackoffMs, getConversationTree, getDefaultAppDataDir, getMaxRetriesForSignature, getStepEffectiveStatus, guessMimeType, isAuthTokenExpiredError, isCascadeRunStatusActive, isCortexStatusActive, isCortexStatusTerminal, isInternalEngineRetryError, isNetworkError, isStaleHubError, isTaskIdMatch, isTransientRetryableError, isWaitingSpeech, listConversations, loadTranscriptFile, normalizeModelName, normalizePromptParts, parseRetriesRemaining, parseStructuredTrajectoryTasks, parseTranscript, pollTranscript, pruneStaleBackgroundTasks, readCascadeTranscript, readStructuredTasksFromSqlite, renderAsciiTree, snapshotAntigravityConfig };
//# sourceMappingURL=index.d.mts.map