import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AntigravityService, MAX_CONSECUTIVE_NOTICE_WAKES } from '../src/index.js';
import type { AntigravityConfig } from '../src/index.js';

describe('State persistence and settlement outbox', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-bridge-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('persists runs, messageQueues, and outbox to disk and reloads on startup', async () => {
    const ctx = new Context();
    const config: AntigravityConfig = {
      appDataDir: tmpDir,
    };
    const svc = new AntigravityService(ctx, config);
    await (svc as any).stateInitPromise;

    // Populate runs, queues, outbox
    const runId = 'test-cascade-123';
    (svc as any).runs.set(runId, {
      cascadeId: runId,
      status: 'running',
      startedAt: Date.now() - 5000,
      baselineStepIndex: 10,
      turnSeq: 2,
      priorContents: ['prior step'],
      callerAgentId: 'agent-alice',
    });

    (svc as any).messageQueues.set(runId, [
      {
        content: 'queued follow-up',
        wait: false,
        mode: 'turn-end',
        callerAgentId: 'agent-alice',
        enqueuedAt: Date.now(),
        resolve: () => {},
        reject: () => {},
      },
    ]);

    (svc as any).settlementOutbox.push({
      cascadeId: runId,
      status: 'done',
      summary: 'Task complete',
      callerAgentId: 'agent-alice',
      enqueuedAt: Date.now() - 1000,
      turnSeq: 2,
      transitionKey: 'done:turn2:Task complete',
    });

    // Save now
    await (svc as any).saveStateNow();

    const stateFile = path.join(tmpDir, 'dsh-antigravity-bridge', 'state.json');
    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.runs[runId]).toBeDefined();
    expect(parsed.runs[runId].callerAgentId).toBe('agent-alice');
    expect(parsed.messageQueues[runId]).toHaveLength(1);
    expect(parsed.settlementOutbox[0].summary).toBe('Task complete');

    // Create a new Context and new service instance to reload state
    const ctx2 = new Context();
    const mockAgent = { id: 'agent-alice', followup: vi.fn() };
    (ctx2 as any).agents = {
      list: () => [mockAgent],
    };

    const newSvc = new AntigravityService(ctx2, config);
    // Mock getHubClient and watcher to avoid real network
    (newSvc as any).getHubClient = async () => ({
      sendMessage: vi.fn(async () => {}),
    });
    (newSvc as any).ensureActiveWatcher = vi.fn();

    await (newSvc as any).stateInitPromise;

    // Verify restored state
    const restoredRun = (newSvc as any).runs.get(runId);
    expect(restoredRun).toBeDefined();
    expect(restoredRun.callerAgent).toBe(mockAgent);
    expect(restoredRun.callerAgentId).toBe('agent-alice');

    const restoredOutbox = (newSvc as any).settlementOutbox;
    expect(restoredOutbox).toHaveLength(1);
    expect(restoredOutbox[0].summary).toBe('Task complete');

    // Verify watcher reconstruction was called for active run
    expect((newSvc as any).ensureActiveWatcher).toHaveBeenCalledWith(runId, mockAgent, 10);

    // Clean up
    (svc as any).disposed = true;
    (newSvc as any).disposed = true;
    clearInterval((svc as any).outboxTimer);
    clearInterval((newSvc as any).outboxTimer);
    clearTimeout((svc as any).saveStateTimer);
    clearTimeout((newSvc as any).saveStateTimer);
  });

  it('retries failed settlement delivery via outbox timer and respects TTL', async () => {
    const ctx = new Context();
    const config: AntigravityConfig = {
      appDataDir: tmpDir,
    };
    const svc = new AntigravityService(ctx, config);
    await (svc as any).stateInitPromise;

    let agentAvailable = false;
    const mockAgent = {
      id: 'agent-bob',
      status: 'idle',
      followup: vi.fn(() => {
        if (!agentAvailable) throw new Error('Agent busy or offline');
      }),
      steer: vi.fn(() => {
        if (!agentAvailable) throw new Error('Agent busy or offline');
      }),
    };
    (ctx as any).agents = {
      list: () => [mockAgent],
    };

    const runId = 'test-cascade-outbox';
    const run = {
      cascadeId: runId,
      status: 'done' as const,
      startedAt: Date.now(),
      turnSeq: 1,
      priorContents: [],
      callerAgent: mockAgent,
      callerAgentId: 'agent-bob',
    };

    // notifySettlementToDsh should fail delivery and enqueue into outbox
    (svc as any).notifySettlementToDsh(run);
    expect((svc as any).settlementOutbox.some((item: any) => item.cascadeId === runId)).toBe(true);

    // Retry while agent is still failing
    await (svc as any).retrySettlementOutbox();
    expect((svc as any).settlementOutbox.some((item: any) => item.cascadeId === runId)).toBe(true);

    // Now agent becomes available
    agentAvailable = true;
    await (svc as any).retrySettlementOutbox();
    expect((svc as any).settlementOutbox.some((item: any) => item.cascadeId === runId)).toBe(false);

    // Test TTL expiry: item older than 10m is dropped
    const expiredId = 'expired-run';
    (svc as any).settlementOutbox.push({
      cascadeId: expiredId,
      status: 'done',
      summary: 'Old result',
      enqueuedAt: Date.now() - 11 * 60 * 1000, // 11 mins old
    });

    await (svc as any).retrySettlementOutbox();
    expect((svc as any).settlementOutbox.some((item: any) => item.cascadeId === expiredId)).toBe(false);

    (svc as any).disposed = true;
    clearInterval((svc as any).outboxTimer);
    clearTimeout((svc as any).saveStateTimer);
  });

  // -------------------------------------------------------------------------
  // D1 — delivery must be evidence-based, never optimistic
  // -------------------------------------------------------------------------
  describe('D1 settlement-notice delivery honesty', () => {
    const newSvc = (dir: string) => {
      const ctx = new Context();
      const svc = new AntigravityService(ctx, { appDataDir: dir });
      (svc as any).getHubClient = async () => ({ sendMessage: vi.fn(async () => {}) });
      (svc as any).ensureActiveWatcher = vi.fn();
      return { ctx, svc };
    };

    it('reports NOT delivered when the target agent exposes no injection seam at all', async () => {
      const { ctx, svc } = newSvc(tmpDir);
      await (svc as any).stateInitPromise;

      // An agent object with neither steer/followup/inject: the old code ran
      // `agent.steer?.(msg)`, silently no-op'd, and still returned true, which
      // latched lastNotifiedTransition and permanently dropped the notice.
      const seamlessAgent = { id: 'agent-seamless', status: 'idle' };
      (ctx as any).agents = { list: () => [seamlessAgent] };

      const runId = 'cid-seamless';
      const run: any = {
        cascadeId: runId,
        status: 'done',
        startedAt: Date.now(),
        turnSeq: 1,
        priorContents: [],
        content: 'done text',
        callerAgent: seamlessAgent,
        callerAgentId: 'agent-seamless',
      };
      (svc as any).runs.set(runId, run);

      (svc as any).notifySettlementToDsh(run);

      expect(run.lastNotifiedTransition).toBeUndefined();
      expect((svc as any).settlementOutbox.some((i: any) => i.cascadeId === runId)).toBe(true);

      (svc as any).disposed = true;
      clearInterval((svc as any).outboxTimer);
      clearTimeout((svc as any).saveStateTimer);
    });

    it('falls back to followup only when steer is proven unavailable', async () => {
      const { ctx, svc } = newSvc(tmpDir);
      await (svc as any).stateInitPromise;

      const followupOnly = { id: 'agent-followup-only', status: 'idle', followup: vi.fn() };
      (ctx as any).agents = { list: () => [followupOnly] };
      const delivered = (svc as any).deliverMessageToAgent(followupOnly, { id: 'm1' });

      expect(delivered).toBe(true);
      expect(followupOnly.followup).toHaveBeenCalledTimes(1);

      (svc as any).disposed = true;
      clearInterval((svc as any).outboxTimer);
      clearTimeout((svc as any).saveStateTimer);
    });

    it('prefers the bound caller agent over an unrelated live agent in the registry', async () => {
      const { ctx, svc } = newSvc(tmpDir);
      await (svc as any).stateInitPromise;

      const stranger = { id: 'agent-stranger', status: 'idle', steer: vi.fn(), followup: vi.fn() };
      const caller = { id: 'agent-caller', status: 'idle', steer: vi.fn(), followup: vi.fn() };
      // Registry order puts the stranger FIRST — the old code broadcast to it.
      (ctx as any).agents = { list: () => [stranger, caller] };

      const delivered = (svc as any).deliverMessageToAgent(caller, { id: 'm1' });

      expect(delivered).toBe(true);
      expect(caller.steer).toHaveBeenCalledTimes(1);
      expect(stranger.steer).not.toHaveBeenCalled();
      expect(stranger.followup).not.toHaveBeenCalled();

      (svc as any).disposed = true;
      clearInterval((svc as any).outboxTimer);
      clearTimeout((svc as any).saveStateTimer);
    });

    it('bounds self-excitation: a BUSY caller past the wake budget is queued without a wake', async () => {
      const { ctx, svc } = newSvc(tmpDir);
      await (svc as any).stateInitPromise;

      const busy = { id: 'agent-busy', status: 'running', steer: vi.fn(), followup: vi.fn(), inject: vi.fn() };
      (ctx as any).agents = { list: () => [busy] };

      for (let i = 0; i < MAX_CONSECUTIVE_NOTICE_WAKES; i++) {
        expect((svc as any).deliverMessageToAgent(busy, { id: `m${i}` })).toBe(true);
      }
      expect(busy.steer).toHaveBeenCalledTimes(MAX_CONSECUTIVE_NOTICE_WAKES);

      // Budget spent: the next notice must not start a driver...
      expect((svc as any).deliverMessageToAgent(busy, { id: 'over-budget' })).toBe(true);
      expect(busy.steer).toHaveBeenCalledTimes(MAX_CONSECUTIVE_NOTICE_WAKES);
      expect(busy.inject).toHaveBeenCalledTimes(1);

      // ...but a model-authored tool call against the lane refunds the budget.
      (svc as any).noteModelActivity(busy);
      expect((svc as any).deliverMessageToAgent(busy, { id: 'after-refund' })).toBe(true);
      expect(busy.steer).toHaveBeenCalledTimes(MAX_CONSECUTIVE_NOTICE_WAKES + 1);

      (svc as any).disposed = true;
      clearInterval((svc as any).outboxTimer);
      clearTimeout((svc as any).saveStateTimer);
    });

    it('never silently drops a notice for an IDLE caller past the wake budget', async () => {
      const { ctx, svc } = newSvc(tmpDir);
      await (svc as any).stateInitPromise;

      const idle = { id: 'agent-idle-budget', status: 'idle', steer: vi.fn(), followup: vi.fn(), inject: vi.fn() };
      (ctx as any).agents = { list: () => [idle] };

      for (let i = 0; i <= MAX_CONSECUTIVE_NOTICE_WAKES; i++) {
        expect((svc as any).deliverMessageToAgent(idle, { id: `m${i}` })).toBe(true);
      }
      // An idle agent's non-waking inbox entry would never be claimed, so the
      // budget is overridden rather than losing the settlement notice.
      expect(idle.inject).not.toHaveBeenCalled();
      expect(idle.steer).toHaveBeenCalledTimes(MAX_CONSECUTIVE_NOTICE_WAKES + 1);

      (svc as any).disposed = true;
      clearInterval((svc as any).outboxTimer);
      clearTimeout((svc as any).saveStateTimer);
    });
  });

  it('ensures active watcher on turn-end queue to prevent orphan queue', async () => {
    const ctx = new Context();
    const config: AntigravityConfig = {
      appDataDir: tmpDir,
    };
    const svc = new AntigravityService(ctx, config);
    await (svc as any).stateInitPromise;

    const runId = 'cascade-turn-end-test';
    // Cascade is running
    (svc as any).runs.set(runId, {
      cascadeId: runId,
      status: 'running',
      startedAt: Date.now(),
      baselineStepIndex: 5,
      turnSeq: 1,
      priorContents: [],
    });

    const ensureWatcherSpy = vi.spyOn(svc as any, 'ensureActiveWatcher');

    const result = await (svc as any).hubSendMessage(runId, 'wait for turn to end', false, 'turn-end');
    expect(result).toContain('Message queued for cascade-turn-end-test (turn-end)');
    expect(ensureWatcherSpy).toHaveBeenCalledWith(runId, undefined);

    (svc as any).disposed = true;
    clearInterval((svc as any).outboxTimer);
    clearTimeout((svc as any).saveStateTimer);
  });

  it('bypasses recentlyActive fallback when run is confirmed dead', async () => {
    const ctx = new Context();
    const config: AntigravityConfig = {
      appDataDir: tmpDir,
    };
    const svc = new AntigravityService(ctx, config);
    await (svc as any).stateInitPromise;

    const runId = 'cascade-dead-test';
    // Run is marked done and has no active watcher
    (svc as any).runs.set(runId, {
      cascadeId: runId,
      status: 'done',
      startedAt: Date.now() - 10000,
      baselineStepIndex: 5,
      turnSeq: 1,
      priorContents: [],
    });

    // Mock client send and confirm message
    const sendMock = vi.fn(async () => {});
    (svc as any).getHubClient = async () => ({
      sendMessage: sendMock,
    });
    (svc as any).confirmMessageDelivered = vi.fn(async () => true);

    // Call hubSendMessage with wait=false
    const res = await (svc as any).hubSendMessage(runId, 'new prompt for idle cascade', false);
    expect(res).toContain('Message sent to cascade-dead-test; transcript delivery confirmed.');
    expect(sendMock).toHaveBeenCalledWith(runId, 'new prompt for idle cascade', { planModel: undefined });

    (svc as any).disposed = true;
    clearInterval((svc as any).outboxTimer);
    clearTimeout((svc as any).saveStateTimer);
  });

  it('fails immediately on wait=true when delivery confirmation fails', async () => {
    const ctx = new Context();
    const config: AntigravityConfig = {
      appDataDir: tmpDir,
    };
    const svc = new AntigravityService(ctx, config);
    await (svc as any).stateInitPromise;

    const runId = 'cascade-delivery-fail';
    (svc as any).getHubClient = async () => ({
      sendMessage: vi.fn(async () => {}),
    });
    (svc as any).confirmMessageDelivered = vi.fn(async () => false);
    const waitSettlementSpy = vi.spyOn(svc as any, 'waitForSettlement');

    const res = await (svc as any).hubSendMessage(runId, 'test unconfirmed message', true);
    expect(res).toContain(`DELIVERY FAILED for ${runId}`);
    // Must NOT enter waitForSettlement!
    expect(waitSettlementSpy).not.toHaveBeenCalled();

    (svc as any).disposed = true;
    clearInterval((svc as any).outboxTimer);
    clearTimeout((svc as any).saveStateTimer);
  });

  it('handles Cordis context throwing "cannot get property agents without inject" on startup without crashing, and rebinds later', async () => {
    // 1. Create a state file with a saved run
    const stateFile = path.join(tmpDir, 'dsh-antigravity-bridge', 'state.json');
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const runId = 'cascade-uninjected-agents';
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        runs: {
          [runId]: {
            cascadeId: runId,
            status: 'running',
            startedAt: Date.now() - 2000,
            baselineStepIndex: 5,
            callerAgentId: 'agent-bob',
          },
        },
        messageQueues: {},
        settlementOutbox: [],
      }),
      'utf8',
    );

    // 2. Create a mock Context whose .agents property throws the exact Cordis inject error
    const rawCtx = new Context();
    let agentsAvailable = false;
    const mockAgentBob = { id: 'agent-bob', followup: vi.fn(), steer: vi.fn(), status: 'idle' };

    const ctxProxy = new Proxy(rawCtx, {
      get(target, prop, receiver) {
        if (prop === 'agents') {
          if (!agentsAvailable) {
            throw new Error('cannot get property "agents" without inject');
          }
          return {
            list: () => [mockAgentBob],
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const config: AntigravityConfig = {
      appDataDir: tmpDir,
    };

    // 3. Instantiate AntigravityService - initState MUST NOT throw or fail
    const svc = new AntigravityService(ctxProxy as any, config);
    (svc as any).getHubClient = async () => ({
      sendMessage: vi.fn(async () => {}),
    });
    (svc as any).ensureActiveWatcher = vi.fn();

    // Must resolve cleanly without throwing
    await expect((svc as any).stateInitPromise).resolves.toBeUndefined();

    // Run was restored successfully
    const restoredRun = (svc as any).runs.get(runId);
    expect(restoredRun).toBeDefined();
    expect(restoredRun.callerAgentId).toBe('agent-bob');
    // Initially undefined because agents was not injected yet
    expect(restoredRun.callerAgent).toBeUndefined();

    // 4. Now simulate agents service becoming available
    agentsAvailable = true;

    // Trigger rebindAgents
    await (svc as any).rebindAgents();

    // Verify callerAgent was rebound successfully!
    expect(restoredRun.callerAgent).toBe(mockAgentBob);

    // 5. Verify lazy binding in notifySettlementToDsh if another run was not bound yet
    const runId2 = 'cascade-uninjected-agents-2';
    const run2 = {
      cascadeId: runId2,
      status: 'done' as const,
      startedAt: Date.now(),
      turnSeq: 1,
      callerAgentId: 'agent-bob',
      callerAgent: undefined,
    };
    (svc as any).runs.set(runId2, run2);

    (svc as any).notifySettlementToDsh(run2);
    expect(run2.callerAgent).toBe(mockAgentBob);
    // D1: delivery is unified on the single wakeup-capable `steer` seam
    // (next-step target + wakeup=true), which covers idle and busy callers with
    // one code path. `followup` is only a proven-method fallback.
    expect(mockAgentBob.steer).toHaveBeenCalled();
    expect(mockAgentBob.followup).not.toHaveBeenCalled();

    (svc as any).disposed = true;
    clearInterval((svc as any).outboxTimer);
    clearTimeout((svc as any).saveStateTimer);
  });
});

