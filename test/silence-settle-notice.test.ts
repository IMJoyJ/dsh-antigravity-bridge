import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { TranscriptSnapshot, ActiveBackgroundTask } from '../src/hub/transcript.js';
import { AntigravityService } from '../src/index.js';
import type { AntigravityConfig, HubRun } from '../src/index.js';

// ---------------------------------------------------------------------------
// Mocks (same shape as tail-guard.test.ts: readCascadeTranscript is scripted)
// ---------------------------------------------------------------------------

vi.mock('../src/hub/transcript.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hub/transcript.js')>();
  return {
    ...actual,
    readCascadeTranscript: vi.fn(async () => undefined),
  };
});

import { readCascadeTranscript } from '../src/hub/transcript.js';
const mockRead = vi.mocked(readCascadeTranscript);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function runOf(svc: AntigravityService, cascadeId: string): HubRun {
  return (svc as unknown as { runs: Map<string, HubRun> }).runs.get(cascadeId)!;
}

/** Text of every message actually handed to a delivery seam, newest last. */
function deliveredTexts(deliverSpy: ReturnType<typeof vi.spyOn>): string[] {
  return deliverSpy.mock.calls
    .map((c: any[]) => c[1])
    .map((m: any) => (m?.content ?? []).map((b: any) => b?.text ?? '').join('\n'));
}

/** Whether any delivered message is a settlement notice (done/error/timeout/awaiting-approval). */
function settlementNotices(deliverSpy: ReturnType<typeof vi.spyOn>): string[] {
  return deliveredTexts(deliverSpy).filter((t) => t.includes('Antigravity Cascade'));
}

function waitingNotices(deliverSpy: ReturnType<typeof vi.spyOn>): string[] {
  return deliveredTexts(deliverSpy).filter(
    (t) => t.includes('正在等待后台任务') || t.includes('后台任务疑似停滞'),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mockRead.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// silence_task 只应拦截 waiting-background 周期提示，不得拦截交卷/结算/错误通知
// ---------------------------------------------------------------------------

describe('silence_task scope: only waiting-background warnings are suppressed', () => {
  const task: ActiveBackgroundTask = {
    taskId: 'task-100',
    description: 'cargo test --workspace',
    command: 'cargo test --workspace',
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    startStepIndex: 10,
  };

  /** Boot a watcher that is parked in waiting-background on `task`. */
  async function parkInWaitingBackground(svc: AntigravityService, cid: string): Promise<void> {
    (svc as any).runs.set(cid, {
      cascadeId: cid,
      status: 'running',
      startedAt: Date.now() - 600_000,
      baselineStepIndex: -1,
      turnSeq: 1,
    } satisfies HubRun);

    mockRead.mockImplementation(async () =>
      snap({
        maxStepIndex: 12,
        isFinished: true,
        engaged: true,
        tailKind: 'assistant-text',
        plannerContents: ['Build dispatched to background.'],
        activeBackgroundTasks: [task],
      }),
    );
    (svc as any).getStructuredCascadeTasks = async () => ({
      authoritative: true,
      activeTasks: [task],
      allTasks: [task],
      hasActiveChildren: false,
      isCascadeActive: false,
    });

    svc.ensureActiveWatcher(cid, undefined, -1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(runOf(svc, cid).status).toBe('waiting-background');
  }

  it('timed silence: suppresses waiting warnings, but the done settlement notice still fires after the task completes', async () => {
    const { svc } = makeService();
    const deliverSpy = vi.spyOn(svc as any, 'deliverMessageToAgent').mockReturnValue(true);
    const notifySpy = vi.spyOn(svc as any, 'notifySettlementToDsh');
    const cid = 'cid-silence-timed';

    await parkInWaitingBackground(svc, cid);

    // The user's repro call shape: cascade_id + task_id + duration.
    const res = svc.silenceTask(cid, 'task-100', 3600);
    expect(res.success).toBe(true);
    expect(res.infinite).toBe(false);

    // Cross the episode (5min) + global (2min) + intra-episode (5min) warning
    // windows: with the task silenced, NO waiting-background warning may leak.
    await vi.advanceTimersByTimeAsync(700_000);
    expect(waitingNotices(deliverSpy)).toHaveLength(0);
    expect(settlementNotices(deliverSpy)).toHaveLength(0);

    // The background task completes → the cascade settles as done.
    mockRead.mockImplementation(async () =>
      snap({
        maxStepIndex: 13,
        isFinished: true,
        engaged: true,
        tailKind: 'assistant-text',
        plannerContents: ['All 42 tests passed.'],
        activeBackgroundTasks: [],
      }),
    );
    (svc as any).getStructuredCascadeTasks = async () => ({
      authoritative: true,
      activeTasks: [],
      allTasks: [],
      hasActiveChildren: false,
      isCascadeActive: false,
    });

    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      if (runOf(svc, cid).status === 'done') break;
    }

    expect(runOf(svc, cid).status).toBe('done');
    // 交卷/结算通知不得被 silence 吞掉：
    expect(notifySpy).toHaveBeenCalled();
    const settled = settlementNotices(deliverSpy);
    expect(settled.length).toBeGreaterThan(0);
    expect(settled[settled.length - 1]).toContain('Completed Successfully');
  });

  it('infinite silence: the done settlement notice still fires (with the residual task warning)', async () => {
    const { svc } = makeService();
    const deliverSpy = vi.spyOn(svc as any, 'deliverMessageToAgent').mockReturnValue(true);
    const notifySpy = vi.spyOn(svc as any, 'notifySettlementToDsh');
    const cid = 'cid-silence-infinite';

    await parkInWaitingBackground(svc, cid);

    svc.silenceTask(cid, 'task-100'); // omitted duration ⇒ infinite

    // Infinite silence unblocks settlement even while the task keeps running:
    (svc as any).getStructuredCascadeTasks = async () => ({
      authoritative: true,
      activeTasks: [task],
      allTasks: [task],
      hasActiveChildren: false,
      isCascadeActive: false,
    });

    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      if (runOf(svc, cid).status === 'done') break;
    }

    expect(runOf(svc, cid).status).toBe('done');
    expect(notifySpy).toHaveBeenCalled();
    const settled = settlementNotices(deliverSpy);
    expect(settled.length).toBeGreaterThan(0);
    expect(settled[settled.length - 1]).toContain('静默后台任务残留警告');
  });

  it('error transitions are never silenced: an errored cascade still gets its error notice', async () => {
    const { svc } = makeService({ autoResume: { enabled: false } });
    const deliverSpy = vi.spyOn(svc as any, 'deliverMessageToAgent').mockReturnValue(true);
    const cid = 'cid-silence-error';

    await parkInWaitingBackground(svc, cid);
    svc.silenceTask(cid, 'task-100', 3600);

    // The cascade fails hard while the silenced task is still around.
    mockRead.mockImplementation(async () =>
      snap({
        maxStepIndex: 14,
        isFinished: false,
        engaged: true,
        tailKind: 'assistant-text',
        plannerContents: ['Build dispatched to background.'],
        activeBackgroundTasks: [task],
        error: 'Claude quota exhausted (429)',
      }),
    );

    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      if (runOf(svc, cid).status === 'error') break;
    }

    expect(runOf(svc, cid).status).toBe('error');
    const settled = settlementNotices(deliverSpy);
    expect(settled.length).toBeGreaterThan(0);
    expect(settled[settled.length - 1]).toContain('Execution Error');
  });

  it('check_run polling may not pre-empt (and swallow) the watcher\'s done notice', async () => {
    const { svc } = makeService();
    const deliverSpy = vi.spyOn(svc as any, 'deliverMessageToAgent').mockReturnValue(true);
    const cid = 'cid-silence-poll';

    await parkInWaitingBackground(svc, cid);
    svc.silenceTask(cid, 'task-100', 3600);

    // The task completes and the transcript carries a genuine final reply.
    mockRead.mockImplementation(async () =>
      snap({
        maxStepIndex: 15,
        isFinished: true,
        engaged: true,
        tailKind: 'assistant-text',
        plannerContents: ['All 42 tests passed.'],
        activeBackgroundTasks: [],
      }),
    );
    (svc as any).getStructuredCascadeTasks = async () => ({
      authoritative: true,
      activeTasks: [],
      allTasks: [],
      hasActiveChildren: false,
      isCascadeActive: false,
    });

    // The coordinator — having received no notices — polls check_run right in
    // the middle of the watcher's settle confirmation window.
    await vi.advanceTimersByTimeAsync(2000);
    await (svc as any).hubCheckRun(cid, false);

    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      if (!runOf(svc, cid) || runOf(svc, cid).status === 'done') break;
    }

    // Even after the poll, the done notice must still be delivered exactly once.
    const settled = settlementNotices(deliverSpy);
    expect(settled.length).toBeGreaterThan(0);
    expect(settled[settled.length - 1]).toContain('Completed Successfully');
  });

  it('control: the poll race swallows the done notice even WITHOUT silence_task (silence is the amplifier, not the gate)', async () => {
    const { svc } = makeService();
    const deliverSpy = vi.spyOn(svc as any, 'deliverMessageToAgent').mockReturnValue(true);
    const cid = 'cid-poll-nosilence';

    await parkInWaitingBackground(svc, cid);
    // NOTE: no silenceTask call at all.

    mockRead.mockImplementation(async () =>
      snap({
        maxStepIndex: 16,
        isFinished: true,
        engaged: true,
        tailKind: 'assistant-text',
        plannerContents: ['All 42 tests passed.'],
        activeBackgroundTasks: [],
      }),
    );
    (svc as any).getStructuredCascadeTasks = async () => ({
      authoritative: true,
      activeTasks: [],
      allTasks: [],
      hasActiveChildren: false,
      isCascadeActive: false,
    });

    await vi.advanceTimersByTimeAsync(2000);
    await (svc as any).hubCheckRun(cid, false);

    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      if (!runOf(svc, cid) || runOf(svc, cid).status === 'done') break;
    }

    const settled = settlementNotices(deliverSpy);
    expect(settled.length).toBeGreaterThan(0);
    expect(settled[settled.length - 1]).toContain('Completed Successfully');
  });

  it('check_run polling preserves watcher-owned run state (two-phase settle gate + silence scope)', async () => {
    const { svc } = makeService();
    vi.spyOn(svc as any, 'deliverMessageToAgent').mockReturnValue(true);
    const cid = 'cid-poll-keep-state';

    await parkInWaitingBackground(svc, cid);
    svc.silenceTask(cid, 'task-100', 3600);

    // The task completes: the transcript is quiet and finished.
    mockRead.mockImplementation(async () =>
      snap({
        maxStepIndex: 17,
        isFinished: true,
        engaged: true,
        tailKind: 'assistant-text',
        plannerContents: ['All 42 tests passed.'],
        activeBackgroundTasks: [],
      }),
    );
    (svc as any).getStructuredCascadeTasks = async () => ({
      authoritative: true,
      activeTasks: [],
      allTasks: [],
      hasActiveChildren: false,
      isCascadeActive: false,
    });

    // Past settleStableMs: the watcher records its round-1 settle gate.
    await vi.advanceTimersByTimeAsync(17_000);
    const before = runOf(svc, cid);
    expect(before.settleCandidateSnapshot).toBeTruthy();
    expect(before.silencedTasks).toBeTruthy();

    // A check_run poll lands mid-confirmation.
    await (svc as any).hubCheckRun(cid, false);

    const after = runOf(svc, cid);
    // The read-side refresh may not reset the settle gate (that starved
    // settlement for any polling coordinator) nor wipe the silence scope.
    expect(after.settleCandidateSnapshot).toEqual(before.settleCandidateSnapshot);
    expect(after.silencedTasks).toEqual(before.silencedTasks);

    // And the run still settles and announces normally afterwards.
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      if (runOf(svc, cid).status === 'done') break;
    }
    expect(runOf(svc, cid).status).toBe('done');
  });
});
