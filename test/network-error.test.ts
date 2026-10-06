import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  type TranscriptSnapshot,
} from '../src/hub/transcript.js';
import { AntigravityService } from '../src/index.js';
import type { AntigravityConfig, HubRun } from '../src/index.js';

// readCascadeTranscript is the single disk touchpoint of the watcher; it is scripted per test.
vi.mock('../src/hub/transcript.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hub/transcript.js')>();
  return {
    ...actual,
    readCascadeTranscript: vi.fn(async () => undefined),
  };
});

import { readCascadeTranscript } from '../src/hub/transcript.js';
const mockRead = vi.mocked(readCascadeTranscript);

function snap(partial: Partial<TranscriptSnapshot>): TranscriptSnapshot {
  return {
    maxStepIndex: 0,
    engaged: true,
    plannerContents: [],
    isFinished: false,
    tailKind: 'none',
    ...partial,
  };
}

function makeService(config: Partial<AntigravityConfig> = {}): {
  svc: AntigravityService;
  ctx: Context;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const ctx = new Context();
  const svc = new AntigravityService(ctx, config as AntigravityConfig);
  const sendMessage = vi.fn(async () => ({}));
  (svc as unknown as { getHubClient: () => Promise<unknown> }).getHubClient = async () => ({ sendMessage });
  vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
    authoritative: true,
    activeTasks: [],
    allTasks: [],
    hasActiveChildren: false,
    isCascadeActive: false,
  });
  return { svc, ctx, sendMessage };
}

async function driveUntilSettled(svc: AntigravityService, cascadeId: string, maxSeconds = 200): Promise<void> {
  const watchers = (svc as unknown as { watchers: Map<string, Promise<void>> }).watchers;
  const watcherPromise = watchers.get(cascadeId);
  for (let i = 0; i < maxSeconds; i++) {
    const run = runOf(svc, cascadeId);
    if (!watchers.has(cascadeId) || (run && (run.status === 'done' || run.status === 'error'))) break;
    await vi.advanceTimersByTimeAsync(1000);
  }
  if (!watchers.has(cascadeId) && watcherPromise) await watcherPromise;
}

function runOf(svc: AntigravityService, cascadeId: string): HubRun {
  return (svc as unknown as { runs: Map<string, HubRun> }).runs.get(cascadeId)!;
}

describe('Network Error and In-flight Stall Handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRead.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should detect mid-turn inactivity stall, classify as retryable network_error, and send resume nudge', async () => {
    const { svc, sendMessage } = makeService({
      stallTimeoutMs: 5_000,
      autoResume: { enabled: true, maxRetries: 3, message: '继续。按原计划继续执行当前任务，不要停止。' },
    });

    let currentStep = 10;
    mockRead.mockImplementation(async () => {
      return snap({
        maxStepIndex: currentStep,
        isFinished: false,
        plannerContents: ['Working on step 10...'],
      });
    });

    svc.ensureActiveWatcher('cid-stall-1', undefined, -1);

    // Advance enough time to exceed stallTimeoutMs (5s) + backoff delay (2s)
    await vi.advanceTimersByTimeAsync(10000);

    expect(sendMessage).toHaveBeenCalledWith('cid-stall-1', '继续。按原计划继续执行当前任务，不要停止。', { planModel: undefined });
    const run = runOf(svc, 'cid-stall-1');
    expect(run.autoResumeRetries).toBe(1);
    expect(run.baselineStepIndex).toBe(10);
    expect(run.status).toBe('running');

    // Simulate cascade resuming and finishing
    mockRead.mockImplementation(async () => {
      return snap({
        maxStepIndex: 12,
        isFinished: true,
        plannerContents: ['All steps completed successfully.'],
        tailKind: 'checkpoint',
      });
    });

    await driveUntilSettled(svc, 'cid-stall-1');
    expect(run.status).toBe('done');
    expect(run.content).toBe('All steps completed successfully.');
  });

  it('should escalate to error when retries are exhausted on persistent network error stall', async () => {
    const { svc, sendMessage } = makeService({
      stallTimeoutMs: 3_000,
      autoResume: { enabled: true, maxRetries: 2, message: '继续。按原计划继续执行当前任务，不要停止。' },
    });

    // Transcript never advances and never finishes (silent freeze / network drop)
    mockRead.mockImplementation(async () => {
      return snap({
        maxStepIndex: 5,
        isFinished: false,
        plannerContents: [],
      });
    });

    const waiter = (svc as unknown as {
      waitForSettlement: (id: string, timeoutMs: number, baseline: number) => Promise<{ status: string; error?: string }>;
    }).waitForSettlement('cid-stall-exhausted', 120_000, -1);

    svc.ensureActiveWatcher('cid-stall-exhausted', undefined, -1);

    await driveUntilSettled(svc, 'cid-stall-exhausted', 50);

    expect(sendMessage).toHaveBeenCalledTimes(2);

    const result = await waiter;
    expect(result.status).toBe('error');
    expect(result.error).toContain('网络异常 (network error)');
    expect(result.error).toContain('已自动重试 2 次仍失败');

    const run = runOf(svc, 'cid-stall-exhausted');
    expect(run.status).toBe('error');
    expect(run.error).toContain('网络异常 (network error)');
  });

  it('should handle explicit network error (e.g. fetch failed) from transcript and auto-resume', async () => {
    const { svc, sendMessage } = makeService({
      autoResume: { enabled: true, maxRetries: 2, message: '继续。按原计划继续执行当前任务，不要停止。' },
    });

    mockRead.mockImplementation(async (_brainDir, _cascadeId, baseline) => {
      if (baseline < 8) {
        return snap({
          maxStepIndex: 8,
          isFinished: false,
          error: 'TypeError: fetch failed (ECONNRESET)',
        });
      }
      return snap({
        maxStepIndex: 10,
        isFinished: true,
        plannerContents: ['Recovered from fetch failure and completed.'],
        tailKind: 'checkpoint',
      });
    });

    svc.ensureActiveWatcher('cid-fetch-fail', undefined, -1);

    // 2s backoff + idle poll
    await vi.advanceTimersByTimeAsync(4000);

    expect(sendMessage).toHaveBeenCalledWith('cid-fetch-fail', '继续。按原计划继续执行当前任务，不要停止。', { planModel: undefined });
    expect(runOf(svc, 'cid-fetch-fail').autoResumeRetries).toBe(1);

    // Let it settle to completion
    await driveUntilSettled(svc, 'cid-fetch-fail');
    const run = runOf(svc, 'cid-fetch-fail');
    expect(run.status).toBe('done');
    expect(run.content).toBe('Recovered from fetch failure and completed.');
  });

  it('should reset stall timer when lastActiveAt advances even if maxStepIndex stays the same', async () => {
    const { svc, sendMessage } = makeService({
      stallTimeoutMs: 5_000,
    });

    let time = 0;
    mockRead.mockImplementation(async () => {
      time += 2;
      return snap({
        maxStepIndex: 20,
        isFinished: false,
        lastActiveAt: new Date(1700000000000 + time * 1000).toISOString(),
        plannerContents: ['Long running tool execution...'],
      });
    });

    svc.ensureActiveWatcher('cid-heartbeat', undefined, -1);

    // Advance 6 seconds, but with heartbeats arriving every 2 seconds:
    // stall timer should NOT fire because lastActiveAt updates stallSince
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(runOf(svc, 'cid-heartbeat').status).toBe('running');
  });

  it('should escalate immediately when sending auto-resume message throws network error', async () => {
    const { svc } = makeService();
    (svc as unknown as { getHubClient: () => Promise<unknown> }).getHubClient = async () => ({
      sendMessage: vi.fn(async () => {
        throw new Error('read ECONNRESET at socket');
      }),
    });

    mockRead.mockImplementation(async () => {
      return snap({
        maxStepIndex: 1,
        isFinished: false,
        error: 'stream disconnected',
      });
    });

    const waiter = (svc as unknown as {
      waitForSettlement: (id: string, timeoutMs: number, baseline: number) => Promise<{ status: string; error?: string }>;
    }).waitForSettlement('cid-send-fail', 120_000, -1);

    svc.ensureActiveWatcher('cid-send-fail', undefined, -1);

    await driveUntilSettled(svc, 'cid-send-fail', 10);

    const result = await waiter;
    expect(result.status).toBe('error');
    expect(result.error).toContain('ECONNRESET');

    const run = runOf(svc, 'cid-send-fail');
    expect(run.status).toBe('error');
  });

  describe('Defect D3: Model Format Error and In-flight Retry Lifecycle', () => {
    it('should not latch error on transient model format error (Retries remaining: 3), keep watcher running without injecting message, and deliver done when cascade finishes', async () => {
      const { svc, sendMessage } = makeService({
        autoResume: { enabled: true, maxRetries: 3 },
      });

      const caller = {
        id: 'agent-caller-d3',
        status: 'idle',
        steer: vi.fn(() => true),
        followup: vi.fn(),
        inject: vi.fn(),
      };
      (svc as any).ctx.agents = { list: () => [caller] };

      const formatErrorMsg =
        'Your previous response contained an improperly formatted function call: Malformed function call: Failed to parse function call: Function call is empty - no input to parse. Please retry with a properly formatted function call\nRetries remaining: 3';

      let currentPhase = 'error';
      mockRead.mockImplementation(async () => {
        if (currentPhase === 'error') {
          return snap({
            maxStepIndex: 377,
            isFinished: false,
            error: formatErrorMsg,
          });
        }
        return snap({
          maxStepIndex: 400,
          isFinished: true,
          plannerContents: ['# W14 · BatchC012 升级验收交付报告\n\n验收全绿通过，提交 Hash 71b71ba'],
          tailKind: 'checkpoint',
        });
      });

      svc.ensureActiveWatcher('cid-d3-test', caller, -1);

      // Advance timers by 4s during the transient error phase
      await vi.advanceTimersByTimeAsync(4000);

      // Assert: Bridge did NOT send a '继续' nudge (IDE handles retry internally)
      expect(sendMessage).not.toHaveBeenCalled();

      // Assert: Run status is NOT latched to error
      const run = runOf(svc, 'cid-d3-test');
      expect(run.status).toBe('running');
      expect(run.error).toBeUndefined();

      // Assert: Watcher is still active in watchers map
      const watchers = (svc as any).watchers;
      expect(watchers.has('cid-d3-test')).toBe(true);

      // Assert: check_run returns status running with no error
      const checkMid = (await svc.hubCheckRun('cid-d3-test', false, caller)) as any;
      expect(checkMid.status).toBe('running');
      expect(checkMid.error).toBeNull();

      // Now IDE recovers and completes the cascade
      currentPhase = 'done';

      // Drive watcher to settlement
      await driveUntilSettled(svc, 'cid-d3-test');

      // Assert: Succeeded and transitioned to done
      const settledRun = runOf(svc, 'cid-d3-test');
      expect(settledRun.status).toBe('done');
      expect(settledRun.error).toBeUndefined();

      // Assert: Caller received the settlement notice with done status
      expect(caller.steer).toHaveBeenCalledTimes(1);
      const noticeArg = caller.steer.mock.calls[0][0];
      expect(noticeArg.source.kind).toBe('subagent-settled');
      expect(noticeArg.source.senderSessionId).toBe('cid-d3-test');

      // Assert: check_run reflects status done with delivery report content
      const checkFinal = (await svc.hubCheckRun('cid-d3-test', false, caller)) as any;
      expect(checkFinal.status).toBe('done');
      expect(checkFinal.error).toBeNull();
      expect(checkFinal.content).toContain('W14 · BatchC012 升级验收交付报告');
    });

    it('should escalate to terminal error when Retries remaining is 0, terminate watcher, and not relay further', async () => {
      const { svc, sendMessage } = makeService();

      const caller = {
        id: 'agent-caller-exhausted',
        status: 'idle',
        steer: vi.fn(() => true),
        followup: vi.fn(),
        inject: vi.fn(),
      };
      (svc as any).ctx.agents = { list: () => [caller] };

      const exhaustedErrorMsg =
        'Your previous response contained an improperly formatted function call: Malformed function call: Failed to parse function call: Function call is empty - no input to parse. Please retry with a properly formatted function call\nRetries remaining: 0';

      mockRead.mockImplementation(async () => {
        return snap({
          maxStepIndex: 377,
          isFinished: false,
          error: exhaustedErrorMsg,
        });
      });

      svc.ensureActiveWatcher('cid-d3-exhausted', caller, -1);

      await driveUntilSettled(svc, 'cid-d3-exhausted', 20);

      // Watcher must have broken out and deleted itself
      expect((svc as any).watchers.has('cid-d3-exhausted')).toBe(false);

      const run = runOf(svc, 'cid-d3-exhausted');
      expect(run.status).toBe('error');
      expect(run.error).toContain('模型输出格式错误重试耗尽');

      // Settled notice pushed with error status
      expect(caller.steer).toHaveBeenCalledTimes(1);

      // check_run returns error
      const checkRes = (await svc.hubCheckRun('cid-d3-exhausted', false, caller)) as any;
      expect(checkRes.status).toBe('error');
      expect(checkRes.error).toContain('模型输出格式错误重试耗尽');
    });

    it('should handle error -> recovery -> awaiting-approval without dropping notice or bypassing b40b3ec delivery honesty', async () => {
      const { svc, sendMessage } = makeService();

      const caller = {
        id: 'agent-approval-caller',
        status: 'idle',
        steer: vi.fn(() => true),
        followup: vi.fn(),
        inject: vi.fn(),
      };
      (svc as any).ctx.agents = { list: () => [caller] };

      (svc as any).getHubClient = async () => ({
        sendMessage,
        isCascadeAwaitingApproval: async () => true,
      });

      let phase = 'error';
      mockRead.mockImplementation(async () => {
        if (phase === 'error') {
          return snap({
            maxStepIndex: 377,
            isFinished: false,
            error: 'Malformed function call\nRetries remaining: 3',
          });
        }
        return snap({
          maxStepIndex: 380,
          isFinished: false,
          pendingApproval: {
            name: 'run_command',
            action: 'Execute build command',
            summary: 'Run msbuild on project',
            requestedAt: '2026-10-03T02:25:00Z',
          },
        });
      });

      svc.ensureActiveWatcher('cid-d3-approval', caller, -1);

      // 2s in error phase: stays running
      await vi.advanceTimersByTimeAsync(2000);
      expect(runOf(svc, 'cid-d3-approval').status).toBe('running');
      expect(caller.steer).not.toHaveBeenCalled();

      // Recovers into awaiting-approval
      phase = 'approval';
      await driveUntilSettled(svc, 'cid-d3-approval', 20);

      const run = runOf(svc, 'cid-d3-approval');
      expect(run.status).toBe('awaiting-approval');
      expect(caller.steer).toHaveBeenCalledTimes(1);

      const checkRes = (await svc.hubCheckRun('cid-d3-approval', false, caller)) as any;
      expect(checkRes.status).toBe('awaiting-approval');
      expect(checkRes.pendingTool?.name).toBe('run_command');
      expect(checkRes.pendingTool?.summary).toBe('Run msbuild on project');
    });
  });
});
