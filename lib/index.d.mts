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
declare const DEFAULT_MODEL_ID = "gemini-3.7-flash";
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
/** One-shot read+parse of a cascade transcript; undefined when the file does not exist yet. */
declare function readCascadeTranscript(brainDir: string, cascadeId: string, baselineStepIndex?: number): Promise<TranscriptSnapshot | undefined>;
/**
 * Polls a cascade's transcript.jsonl until the planner answered (file stable
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
//#region src/hub/client.d.ts
interface StartCascadeOptions {
  cascadeId: string;
  requestedModel: string;
  projectId: string;
}
declare class HubClient {
  private info;
  private registry;
  constructor(info: HubInfo);
  static create(config?: {
    address?: string;
    csrfToken?: string;
  }): Promise<HubClient>;
  getAvailableModels(): Promise<unknown>;
  /** Maps a display id (e.g. "gemini-3.7-flash-tiered") to the hub's
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
  /** Creates a project and returns the caller-generated id (hub responds with {}). */
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
  call(method: string, json: Record<string, unknown>): Promise<unknown>;
}
//#endregion
//#region src/index.d.ts
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
  private disposed;
  constructor(ctx: Context, config: AntigravityConfig);
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
  /** Ensure an active background watcher exists and monitors this cascade's lifecycle until final settlement. */
  ensureActiveWatcher(cascadeId: string, callerAgent?: any, baselineStepIndex?: number): void;
  /** Unified active cascade loop: continuously tracks running/approval/done transitions and notifies DSH. */
  private runCascadeWatcher;
  /** Flush any messages that were queued while the cascade was actively generating or running. */
  private flushMessageQueue;
  hubDelegate(task: string, model?: string, projectId?: string, conversationId?: string, background?: boolean, callerAgent?: any): Promise<string>;
  /** Inspect a background run; wait supports boolean or timeout in seconds. */
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
  private waitCascadeDetailed;
  hubCreateProject(name: string, folderUri: string): Promise<unknown>;
}
declare class AntigravityBridgePlugin {
  static name: string;
  static Config: Schema<AntigravityConfig>;
  static inject: string[];
  constructor(ctx: Context, config: AntigravityConfig);
}
//#endregion
export { ANTIGRAVITY_MODELS, AgentInitConfig, AgentStep, AntigravityAgent, AntigravityConfig, AntigravityEngine, AntigravityModelInfo, AntigravityService, CascadeDetailedResult, Config, ConversationSummary, ConversationTreeNode, DEFAULT_MODEL_ID, EngineConfig, HarnessSessionInfo, HubClient, HubInfo, HubRun, ListConversationsOptions, MediaInput, PendingToolApproval, PollResult, PromptContent, PromptItem, ProtoMediaPart, RunOneShotOptions, SessionContinuationMode, SettlementNoticePayload, StartCascadeOptions, TokenUsage, TranscriptSnapshot, TranscriptStep, buildConversationGraph, buildSettlementNotice, clearHubCache, AntigravityBridgePlugin as default, discoverHub, fileToMedia, getConversationTree, getDefaultAppDataDir, guessMimeType, listConversations, normalizeModelName, normalizePromptParts, parseTranscript, pollTranscript, readCascadeTranscript, renderAsciiTree };
//# sourceMappingURL=index.d.mts.map