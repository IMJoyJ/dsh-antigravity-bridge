import { getHubRegistry } from './registry.js';
import { grpcWebCall } from './transport.js';
import { discoverHub, clearHubCache } from './discovery.js';
import type { HubInfo } from './discovery.js';

export interface StartCascadeOptions {
  cascadeId: string;
  requestedModel: string;
  projectId: string;
}

export class HubClient {
  private info: HubInfo;
  private registry = getHubRegistry();

  constructor(info: HubInfo) {
    this.info = info;
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
    return this.call('StartCascade', {
      cascadeId: opts.cascadeId,
      source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
      trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
      requestedModel: opts.requestedModel,
      customAgentSpec: {
        codingAgent: { googleMode: true },
        cascadeConfig: {
          plannerConfig: { planModel: opts.requestedModel },
        },
      },
      projectEnvConfig: {
        projectId: opts.projectId,
        defaultProjectEnvironment: {},
      },
    });
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

  /** Creates a project and returns the caller-generated id (hub responds with {}). */
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
    return { projectId };
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
