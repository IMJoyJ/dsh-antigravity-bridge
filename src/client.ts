import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { AntigravityEngine, HarnessSessionInfo } from './engine.js';
import protobuf from 'protobufjs';
import { PromptContent, normalizePromptParts } from './media.js';
import { normalizeModelName, DEFAULT_MODEL_ID } from './models.js';
import { getDefaultAppDataDir } from './storage.js';

export type SessionContinuationMode = 'resume' | 'create_or_resume' | 'create_only' | number;

export interface TokenUsage {
  promptTokens: number;
  candidatesTokens: number;
  thoughtsTokens: number;
  cachedContentTokens: number;
  totalTokens: number;
}

export interface AgentInitConfig {
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

export interface AgentStep {
  status: string;
  source?: string;
  content?: string;
  thought?: string;
  error?: string;
  raw?: any;
}

export class AntigravityAgent extends EventEmitter {
  private session?: HarnessSessionInfo;
  private engine: AntigravityEngine;
  private protoRoot?: protobuf.Root;
  private currentConversationId?: string;
  private currentModel: string = DEFAULT_MODEL_ID;
  private usage: TokenUsage = {
    promptTokens: 0,
    candidatesTokens: 0,
    thoughtsTokens: 0,
    cachedContentTokens: 0,
    totalTokens: 0
  };

  constructor(engine?: AntigravityEngine) {
    super();
    this.engine = engine || new AntigravityEngine();
  }

  get conversationId(): string | undefined {
    return this.currentConversationId;
  }

  get model(): string {
    return this.currentModel;
  }

  get latestUsage(): TokenUsage {
    return { ...this.usage };
  }

  private resolveContinuationMode(mode?: SessionContinuationMode): number {
    if (typeof mode === 'number') return mode;
    switch (mode?.toLowerCase()) {
      case 'resume':
        return 1; // RESUME
      case 'create_or_resume':
        return 2; // CREATE_OR_RESUME
      case 'create_only':
        return 3; // CREATE_ONLY
      default:
        return 0; // UNSPECIFIED
    }
  }

  async start(config: AgentInitConfig = {}): Promise<void> {
    this.protoRoot = await this.engine.loadProtos();
    this.currentConversationId = config.conversationId;
    this.currentModel = normalizeModelName(config.model);

    this.session = await this.engine.spawnSession({
      workspaces: config.workspaces,
      appDataDir: config.appDataDir
    });

    const ws = this.session.ws;

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const text = data.toString('utf8');
        const json = JSON.parse(text);
        this.handleMessage(json);
      } catch (err) {
        this.emit('error', err);
      }
    });

    // Send InitializeConversationEvent
    const continuationMode = this.resolveContinuationMode(
      config.sessionContinuationMode || (config.conversationId ? 'resume' : undefined)
    );

    const initEvent = {
      config: {
        cascadeId: config.conversationId || '',
        sessionContinuationMode: continuationMode,
        systemInstructions: config.systemInstructions ? {
          custom: {
            part: [{ text: config.systemInstructions }]
          }
        } : undefined,
        models: [{
          name: this.currentModel,
          types: [1] // ModelType.TEXT
        }],
        workspaces: (config.workspaces || []).map(wsPath => ({
          filesystemWorkspace: { directory: wsPath }
        })),
        skillsPaths: config.skillsPaths || [],
        tools: config.tools || [],
        appDataDir: config.appDataDir || getDefaultAppDataDir(),
        agentBehavior: 1 // AUTONOMOUS
      }
    };

    ws.send(JSON.stringify(initEvent));
  }

  private handleMessage(event: any) {
    this.emit('rawEvent', event);

    if (event.initializeConversationResponse) {
      const resp = event.initializeConversationResponse;
      if (resp.cascadeId) {
        this.currentConversationId = resp.cascadeId;
      }
      this.emit('initialized', resp);
    }

    // Handle UsageUpdate
    if (event.usageUpdate) {
      const u = event.usageUpdate.total || event.usageUpdate;
      this.usage = {
        promptTokens: Number(u.promptTokenCount || u.prompt_token_count || 0),
        candidatesTokens: Number(u.candidatesTokenCount || u.candidates_token_count || 0),
        thoughtsTokens: Number(u.thoughtsTokenCount || u.thoughts_token_count || 0),
        cachedContentTokens: Number(u.cachedContentTokenCount || u.cached_content_token_count || 0),
        totalTokens: Number(u.totalTokenCount || u.total_token_count || 0)
      };
      this.emit('usage', this.latestUsage);
    }

    if (event.stepUpdate) {
      const su = event.stepUpdate;
      if (su.cascadeId) {
        this.currentConversationId = su.cascadeId;
      }

      // Check stop reason for quota exhaustion
      if (su.stopReason === 6 || su.stop_reason === 6 || su.stopReason === 'STOP_REASON_QUOTA_EXHAUSTED') {
        const quotaErr = new Error(`[Antigravity Quota Limit] Model "${this.currentModel}" has exhausted its usage quota. Please wait for quota reset or switch to Gemini 3.7 Flash.`);
        this.emit('error', quotaErr);
      }

      const step: AgentStep = {
        status: su.status || 'UNSPECIFIED',
        source: su.source || 'MODEL',
        content: su.content?.text || su.text || '',
        thought: su.thought?.text || su.thinking || '',
        error: su.error || su.errorMessage || '',
        raw: su
      };
      this.emit('step', step);
    }

    if (event.toolCall) {
      this.emit('toolCall', event.toolCall);
    }

    if (event.interactionRequest) {
      this.emit('interactionRequest', event.interactionRequest);
    }

    if (event.isIdle) {
      this.emit('idle');
    }
  }

  /**
   * Sends dynamic PromptContent (strings, file attachments, MediaInputs).
   */
  async sendPrompt(content: PromptContent): Promise<void> {
    if (!this.session?.ws) {
      throw new Error('AntigravityAgent session is not active');
    }

    const parts = await normalizePromptParts(content);

    const inputEvent = {
      userInput: {
        parts
      }
    };

    this.session.ws.send(JSON.stringify(inputEvent));
  }

  async sendToolResponse(callId: string, result: string): Promise<void> {
    if (!this.session?.ws) {
      throw new Error('AntigravityAgent session is not active');
    }

    const inputEvent = {
      toolResponse: {
        callId,
        result
      }
    };

    this.session.ws.send(JSON.stringify(inputEvent));
  }

  async close(): Promise<void> {
    if (this.session) {
      try {
        this.session.ws.close();
      } catch {}
      try {
        this.session.process.kill();
      } catch {}
      this.session = undefined;
    }
  }
}
