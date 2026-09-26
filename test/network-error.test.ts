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
});
