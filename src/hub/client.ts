import { getHubRegistry } from './registry.js';
import { grpcWebCall, HubTransportError } from './transport.js';
import { discoverHub, clearHubCache } from './discovery.js';
import type { HubInfo } from './discovery.js';
import { ProjectResolver } from './projects.js';
import type { ResolvedProject } from './projects.js';
import { parseStructuredTrajectoryTasks } from './trajectory.js';
import type { StructuredCascadeTasksResult } from './trajectory.js';

export interface StartCascadeOptions {
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

export interface HubCallOptions {
  /** Passed through to grpcWebCall: 'reject' makes a frame-less 200 body throw
   *  HubTransportError (data-returning methods), 'allow' decodes it as an
   *  empty message (methods whose empty response is legitimate). */
  emptyResponse?: 'allow' | 'reject';
}

const STALE_HUB_ERROR_PATTERN =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|401|Unauthenticated/i;

/**
 * Decides whether an error from a hub call means the cached hub endpoint is
 * stale and one rediscovery + retry could still succeed. Covers:
 * - {@link HubTransportError} (HTTP-level failure or rejected frame-less body);
 * - Node fetch network failures, whose ECONNREFUSED and friends live in
 *   `err.cause` — the outer message is just "fetch failed" — including
 *   AggregateError causes with multiple inner errors;
 * - the pre-existing message conventions "401" / "Unauthenticated".
 */
export function isStaleHubError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof HubTransportError) return true;
  const parts: unknown[] = [err.message];
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    parts.push(cause.message, (cause as NodeJS.ErrnoException).code);
    const aggregate = (cause as { errors?: unknown[] }).errors;
    if (Array.isArray(aggregate)) {
      for (const inner of aggregate) {
        if (inner instanceof Error) parts.push(inner.message, (inner as NodeJS.ErrnoException).code);
      }
    }
  }
  return parts.some((p) => typeof p === 'string' && STALE_HUB_ERROR_PATTERN.test(p));
}

export class HubClient {
  private info: HubInfo;
  /** Config from {@link HubClient.create}; the self-heal retry re-discovers
   *  with it so config-pinned setups stay pinned (and just get one transparent
   *  retry) while dynamic setups get real rediscovery. */
  private readonly createConfig?: { address?: string; csrfToken?: string };
  private registry = getHubRegistry();
  private projectResolver = new ProjectResolver(this);

  constructor(info: HubInfo, createConfig?: { address?: string; csrfToken?: string }) {
    this.info = info;
    this.createConfig = createConfig;
  }

  /** Resolves a folder path or project UUID to a registered project UUID and workspace URI,
   *  automatically creating a new project on the hub if no existing project matches. */
  async resolveOrCreateProject(folderOrId?: string): Promise<ResolvedProject> {
    return this.projectResolver.resolveOrCreateProject(folderOrId, this.info);
  }

  static async create(config?: { address?: string; csrfToken?: string }): Promise<HubClient> {
    const info = await discoverHub(config);
    return new HubClient(info, config);
  }

  async getAvailableModels(): Promise<unknown> {
    return this.call('GetAvailableModels', {}, { emptyResponse: 'reject' });
  }

  /** Maps a display id (e.g. "gemini-3.8-flash-high") to the hub's
   *  MODEL_* enum name. Response shape: { response: { models: { id: {...} } } }. */
  async resolveModel(displayId: string): Promise<string | undefined> {
    const resp = (await this.getAvailableModels()) as {
      response?: { models?: Record<string, { model?: string }> };
    };
    return resp.response?.models?.[displayId]?.model;
  }

  private readonly modelEnumCache = new Map<string, string | undefined>();

  /** resolveModel with a per-client cache: one GetAvailableModels RPC per display id. */
  async resolveModelCached(displayId: string): Promise<string | undefined> {
    if (!this.modelEnumCache.has(displayId)) {
      this.modelEnumCache.set(displayId, await this.resolveModel(displayId));
    }
    return this.modelEnumCache.get(displayId);
  }

  async startCascade(opts: StartCascadeOptions): Promise<unknown> {
    const body: Record<string, unknown> = {
      cascadeId: opts.cascadeId,
      // agy ≥ 2.9.1 sidebar classifies by trajectory source: only UNSPECIFIED/JETBOX
      // land in the local sidebar; CASCADE_CLIENT is routed to externalSummaries
      // (search-only). The hub REJECTS UNSPECIFIED/omitted source on StartCascade,
      // so JETBOX is the only accepted value the frontend treats as local.
      source: opts.sidebarVisible === false
        ? 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT'
        : 'CORTEX_TRAJECTORY_SOURCE_JETBOX',
      trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
      requestedModel: opts.requestedModel,
      customAgentSpec: {
        codingAgent: { googleMode: true },
        cascadeConfig: {
          plannerConfig: { planModel: opts.requestedModel },
        },
      },
    };
    // agy ≥ 2.15.1 sidebar rendering relies on indexes.projectAssociated, which filters:
    // a => koa(a) && !!a.trajectoryMetadata?.projectId
    // Passing projectEnvConfig tells the hub to bind the registered project and record
    // its projectId in trajectoryMetadata & conversation_summaries.db.
    // NOTE: The hub REJECTS sending BOTH workspaceUris and projectEnvConfig (returns empty {}).
    // Therefore, if projectId is provided, send projectEnvConfig first.
    // If projectId is rejected (unpersisted/stale) and workspaceUri is available,
    // fallback gracefully to direct workspaceUris binding.
    if (opts.projectId) {
      body.projectEnvConfig = {
        projectId: opts.projectId,
        defaultProjectEnvironment: {},
      };
    } else if (opts.workspaceUri) {
      body.workspaceUris = [opts.workspaceUri];
    }

    let resp = await this.call('StartCascade', body);

    if ((!resp || typeof resp !== 'object' || !('cascadeId' in resp)) && opts.projectId && opts.workspaceUri) {
      // Fallback: If projectEnvConfig was rejected (e.g. stale or unpersisted project ID),
      // invalidate project cache and retry with direct workspaceUri binding.
      this.projectResolver.invalidate();
      const fallbackBody = { ...body };
      delete fallbackBody.projectEnvConfig;
      fallbackBody.workspaceUris = [opts.workspaceUri];
      resp = await this.call('StartCascade', fallbackBody);
    }

    // The hub silently no-ops (grpc status 0, empty message) when the given
    // projectId is not registered or payload was rejected. A real start echoes the cascadeId.
    if (!resp || typeof resp !== 'object' || !('cascadeId' in resp)) {
      throw new Error(
        'StartCascade was silently rejected by the hub (empty response): the projectId is not registered. '
        + 'Pass an absolute folder path or file:/// URI as project_id instead — the bridge will bind the cascade '
        + 'directly to that workspace via workspaceUris.',
      );
    }
    return resp;
  }

  /**
   * planModel is REQUIRED whenever the hub may construct a fresh executor for
   * the cascade (idle/hibernated resume): a send without cascadeConfig resets
   * the cascade's model selection to None, and the turn then dies with
   * "neither PlanModel nor RequestedModel specified".
   */
  async sendMessage(cascadeId: string, text: string, opts?: { planModel?: string }): Promise<unknown> {
    return this.call('SendUserCascadeMessage', {
      cascadeId,
      items: [{ text }],
      ...(opts?.planModel === undefined ? {} : {
        cascadeConfig: { plannerConfig: { planModel: opts.planModel } },
      }),
    });
  }

  /** Server-side wait until the conversation is fully idle. Returns
   *  { timedOut?: boolean } — an empty object means the idle state was reached. */
  async waitForIdle(
    conversationId: string,
    inactivityTimeoutSeconds: number,
    stabilizationDurationSeconds: number,
  ): Promise<{ timedOut?: boolean }> {
    return (await this.call('WaitForConversationFullyIdle', {
      conversationId,
      inactivityTimeoutSeconds,
      stabilizationDurationSeconds,
      returnOnExecutorError: true,
    })) as { timedOut?: boolean };
  }

  async getConversationMetadata(conversationId: string): Promise<unknown> {
    return this.call('GetConversationMetadata', { conversationId }, { emptyResponse: 'reject' });
  }

  /** Creates a project and returns the caller-generated id (hub responds with {}).
   *  The hub accepts CreateProject with grpc status 0 but may never persist the
   *  project (ReadProject then reports notFoundOnDisk). Verify persistence and
   *  throw an honest error so callers can fall back to folder-bound starts. */
  async createProject(name: string, folderUri: string): Promise<{ projectId: string }> {
    const projectId = crypto.randomUUID();
    await this.call('CreateProject', {
      project: {
        id: projectId,
        name,
        projectResources: {
          resources: [{ folderUri }],
        },
      },
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      const resp = (await this.readProject(projectId)) as { notFoundOnDisk?: boolean; project?: unknown };
      if (resp && typeof resp === 'object' && resp.project) {
        return { projectId };
      }
    }
    throw new Error(
      `CreateProject was accepted by the hub but the project "${name}" (${projectId}) was not persisted `
      + '(ReadProject: notFoundOnDisk). Instead of a project UUID, pass the folder path or file:/// URI '
      + 'directly as project_id to antigravity_delegate — the cascade will be bound to that workspace.',
    );
  }

  async readProject(id: string): Promise<unknown> {
    return this.call('ReadProject', { id }, { emptyResponse: 'reject' });
  }

  async deleteProject(id: string): Promise<unknown> {
    return this.call('DeleteProject', { id });
  }

  async searchConversations(query: string, limit = 20): Promise<unknown> {
    return this.call('SearchConversations', { query, limit }, { emptyResponse: 'reject' });
  }

  /** Cancel an ongoing cascade invocation in a clean manner. */
  async cancelCascade(cascadeId: string, killBackgroundTasks = false): Promise<unknown> {
    return this.call('CancelCascadeInvocation', {
      cascadeId,
      killBackgroundTasks,
    });
  }

  /** Fetch the full cascade trajectory (steps carry requestedInteraction when awaiting approval). */
  async getCascadeTrajectory(cascadeId: string): Promise<unknown> {
    return this.call('GetCascadeTrajectory', { cascadeId }, { emptyResponse: 'reject' });
  }

  /**
   * Fetches and parses structured background tasks directly from GetCascadeTrajectory.
   * 活跃任务判定（零正则）：taskDetails != null 且最新状态 ∈ 活跃集合。
   * 残余盲区①：subagent 子会话 has_active_children 阻塞。
   */
  async getCascadeTasks(cascadeId: string): Promise<StructuredCascadeTasksResult> {
    const resp = await this.getCascadeTrajectory(cascadeId);
    return parseStructuredTrajectoryTasks(resp, cascadeId);
  }

  /** Answer a pending cascade user interaction (the IDE approval dialog's RPC). */
  async handleCascadeUserInteraction(cascadeId: string, interaction: Record<string, unknown>): Promise<unknown> {
    return this.call('HandleCascadeUserInteraction', { cascadeId, interaction });
  }

  /**
   * Accurately checks whether the cascade is genuinely blocked waiting for interactive user approval in the IDE.
   * Distinguishes between auto-approved/running tools (which take seconds to execute) and actual modal prompts.
   */
  async isCascadeAwaitingApproval(cascadeId: string): Promise<boolean> {
    try {
      const resp = (await this.getCascadeTrajectory(cascadeId)) as {
        trajectory?: {
          steps?: Array<{
            status?: string | number;
            type?: string;
            metadata?: {
              startedAt?: string;
              preToolHookResults?: Array<{ decision?: string; allowTool?: boolean }>;
              requestedInteraction?: unknown;
            };
            requestedInteraction?: unknown;
            codeAction?: { filePermissionRequest?: unknown };
          }>;
        };
      };

      const steps = resp?.trajectory?.steps;
      if (!steps || steps.length === 0) return false;

      const lastStep = steps[steps.length - 1];
      const status = lastStep.status;
      const meta = lastStep.metadata || {};
      const preHooks = meta.preToolHookResults || [];
      const isAllowed = preHooks.some((h) => h.decision === 'allow' || h.allowTool === true);
      const hasStarted = !!meta.startedAt;
      const isRunning = status === 'CORTEX_STEP_STATUS_RUNNING' || status === 2;
      const isWaiting = status === 'CORTEX_STEP_STATUS_WAITING' || status === 9;
      const hasRequestedInteraction = !!(
        meta.requestedInteraction ||
        lastStep.requestedInteraction ||
        lastStep.codeAction?.filePermissionRequest
      );

      // If the tool has been allowed or is actively running, it is NOT awaiting approval.
      if (isRunning && (isAllowed || hasStarted)) {
        return false;
      }

      // If it is explicitly waiting or has an active unapproved requestedInteraction:
      if (isWaiting || (hasRequestedInteraction && !isAllowed)) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }


  async call(method: string, json: Record<string, unknown>, options: HubCallOptions = {}): Promise<unknown> {
    try {
      return await this.rawCall(method, json, options);
    } catch (err) {
      if (!isStaleHubError(err)) throw err;
      // The cached endpoint is stale (hub restarted: new port and/or CSRF
      // token). Rediscover once and retry the same call; if the retry fails
      // too, the error propagates — no second rediscovery loop.
      clearHubCache();
      this.info = await discoverHub(this.createConfig);
      return await this.rawCall(method, json, options);
    }
  }

  private rawCall(method: string, json: Record<string, unknown>, options: HubCallOptions): Promise<unknown> {
    return grpcWebCall(
      this.registry,
      this.info.address,
      this.info.csrfToken,
      'exa.language_server_pb.LanguageServerService',
      method,
      json,
      options,
    );
  }
}
