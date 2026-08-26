import { getHubRegistry } from './registry.js';
import { grpcWebCall } from './transport.js';
import { discoverHub, clearHubCache } from './discovery.js';
import type { HubInfo } from './discovery.js';
import { ProjectResolver } from './projects.js';
import type { ResolvedProject } from './projects.js';

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

export class HubClient {
  private info: HubInfo;
  private registry = getHubRegistry();
  private projectResolver = new ProjectResolver(this);

  constructor(info: HubInfo) {
    this.info = info;
  }

  /** Resolves a folder path or project UUID to a registered project UUID and workspace URI,
   *  automatically creating a new project on the hub if no existing project matches. */
  async resolveOrCreateProject(folderOrId?: string): Promise<ResolvedProject> {
    return this.projectResolver.resolveOrCreateProject(folderOrId, this.info);
  }

  static async create(config?: { address?: string; csrfToken?: string }): Promise<HubClient> {
    const info = await discoverHub(config);
    return new HubClient(info);
  }

  async getAvailableModels(): Promise<unknown> {
    return this.call('GetAvailableModels', {});
  }

  /** Maps a display id (e.g. "gemini-3.7-flash-tiered") to the hub's
   *  MODEL_* enum name. Response shape: { response: { models: { id: {...} } } }. */
  async resolveModel(displayId: string): Promise<string | undefined> {
    const resp = (await this.getAvailableModels()) as {
      response?: { models?: Record<string, { model?: string }> };
    };
    return resp.response?.models?.[displayId]?.model;
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
    if (opts.projectId) {
      body.projectEnvConfig = {
        projectId: opts.projectId,
        defaultProjectEnvironment: {},
      };
    } else if (opts.workspaceUri) {
      body.workspaceUris = [opts.workspaceUri];
    }
    const resp = await this.call('StartCascade', body);
    // The hub silently no-ops (grpc status 0, empty message) when the given
    // projectId is not registered. A real start echoes the cascadeId.
    if (!resp || typeof resp !== 'object' || !('cascadeId' in resp)) {
      throw new Error(
        'StartCascade was silently rejected by the hub (empty response): the projectId is not registered. '
        + 'Pass an absolute folder path or file:/// URI as project_id instead — the bridge will bind the cascade '
        + 'directly to that workspace via workspaceUris.',
      );
    }
    return resp;
  }

  async sendMessage(cascadeId: string, text: string): Promise<unknown> {
    return this.call('SendUserCascadeMessage', {
      cascadeId,
      items: [{ text }],
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
    return this.call('GetConversationMetadata', { conversationId });
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
    return this.call('ReadProject', { id });
  }

  async deleteProject(id: string): Promise<unknown> {
    return this.call('DeleteProject', { id });
  }

  async searchConversations(query: string, limit = 20): Promise<unknown> {
    return this.call('SearchConversations', { query, limit });
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
    return this.call('GetCascadeTrajectory', { cascadeId });
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


  async call(method: string, json: Record<string, unknown>): Promise<unknown> {
    try {
      return await grpcWebCall(
        this.registry,
        this.info.address,
        this.info.csrfToken,
        'exa.language_server_pb.LanguageServerService',
        method,
        json,
      );
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('ECONNREFUSED') || err.message.includes('401') || err.message.includes('Unauthenticated'))
      ) {
        clearHubCache();
        const fresh = await discoverHub({});
        this.info = fresh;
        return grpcWebCall(
          this.registry,
          this.info.address,
          this.info.csrfToken,
          'exa.language_server_pb.LanguageServerService',
          method,
          json,
        );
      }
      throw err;
    }
  }
}
