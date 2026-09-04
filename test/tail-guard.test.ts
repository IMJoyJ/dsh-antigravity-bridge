import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  parseTranscript,
  decideTailSettle,
  type TranscriptSnapshot,
  type TranscriptStep,
} from '../src/hub/transcript.js';
import { AntigravityService, DEFAULT_AUTO_CONTINUE_MAX } from '../src/index.js';
import type { AntigravityConfig, HubRun } from '../src/index.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// readCascadeTranscript is the single disk touchpoint of the watcher; it is
// scripted per test below. Everything else in transcript.js stays real.
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

function step(partial: Partial<TranscriptStep> & { step_index: number; type: string }): string {
  return JSON.stringify({ source: 'MODEL', status: 'DONE', ...partial });
}

const WAITING_TEXT = 'I am waiting for the background test run to complete.';

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

/** Scripted readCascadeTranscript: the returned snapshot is a pure function of the baseline. */
function scriptSnapshots(table: Array<{ minBaseline: number; s: TranscriptSnapshot }>): void {
  mockRead.mockImplementation(async (_brainDir: string, _cascadeId: string, baseline: number) => {
    let hit: TranscriptSnapshot | undefined;
    for (const entry of table) {
      if (baseline >= entry.minBaseline) hit = entry.s;
    }
    return hit;
  });
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

/** Advance fake time in 1s steps until the watcher settles (leaves the watchers map). */
async function driveUntilSettled(svc: AntigravityService, cascadeId: string, maxSeconds = 200): Promise<void> {
  const watchers = (svc as unknown as { watchers: Map<string, Promise<void>> }).watchers;
  const watcherPromise = watchers.get(cascadeId);
  for (let i = 0; i < maxSeconds; i++) {
    if (!watchers.has(cascadeId)) break;
    await vi.advanceTimersByTimeAsync(1000);
  }
  if (watcherPromise) await watcherPromise;
}

function runOf(svc: AntigravityService, cascadeId: string): HubRun {
  return (svc as unknown as { runs: Map<string, HubRun> }).runs.get(cascadeId)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  mockRead.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// parseTranscript: tail classification (mock transcript)
// ---------------------------------------------------------------------------

describe('parseTranscript tail classification', () => {
  it('flags the early-stop bug shape: stale isFinished with a tool-result tail', () => {
    const lines = [
      step({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'run the tests' }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', content: WAITING_TEXT }),
      step({ step_index: 2, type: 'CHECKPOINT', source: 'SYSTEM', content: '{{ CHECKPOINT 0 }}' }),
      step({ step_index: 3, type: 'GENERIC', source: 'SYSTEM', content: 'background test result' }),
    ];
    const parsed = parseTranscript(lines);
    // The misjudgment inputs: isFinished is stale (executor DONE steps never
    // reset it) while the last valid entry is a tool result, not a reply.
    expect(parsed.isFinished).toBe(true);
    expect(parsed.plannerContents).toEqual([WAITING_TEXT]);
    expect(parsed.tailKind).toBe('tool-result');
  });

  it('classifies a pending tool-call planner response as a tool-call tail', () => {
    const lines = [
      step({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'task' }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'starting work', tool_calls: [{ name: 'run_tests', args: {} }] }),
    ];
    const parsed = parseTranscript(lines);
    expect(parsed.tailKind).toBe('tool-call');
    expect(parsed.isFinished).toBe(false);
    expect(parsed.pendingApproval?.name).toBe('run_tests');
  });

  it('classifies a turn that ended without any assistant text (checkpoint tail)', () => {
    const lines = [
      step({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'task' }),
      step({ step_index: 1, type: 'CHECKPOINT', source: 'SYSTEM', content: '{{ CHECKPOINT 0 }}' }),
      step({ step_index: 2, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'start_background_task' }] }),
      step({ step_index: 3, type: 'GENERIC', source: 'SYSTEM', content: 'task launched' }),
      step({ step_index: 4, type: 'CHECKPOINT', source: 'SYSTEM', content: '{{ CHECKPOINT 1 }}' }),
    ];
    const parsed = parseTranscript(lines);
    expect(parsed.isFinished).toBe(true);
    expect(parsed.plannerContents).toEqual([]);
    expect(parsed.engagedAfterInput).toBe(true);
    expect(parsed.tailKind).toBe('checkpoint');
  });

  it('classifies a genuine final reply (assistant-text / checkpoint tails)', () => {
    const replyOnly = parseTranscript([
      step({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'task' }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'All done.' }),
    ]);
    expect(replyOnly.tailKind).toBe('assistant-text');
    expect(replyOnly.isFinished).toBe(true);

    const withCheckpoint = parseTranscript([
      step({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'task' }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'All done.' }),
      step({ step_index: 2, type: 'CHECKPOINT', source: 'SYSTEM', content: '{{ CHECKPOINT 0 }}' }),
    ]);
    expect(withCheckpoint.tailKind).toBe('checkpoint');
    expect(withCheckpoint.isFinished).toBe(true);
    expect(withCheckpoint.checkpointAfterInput).toBe(true);
  });

  it('reports none for an empty turn window and respects the baseline cut', () => {
    expect(parseTranscript([]).tailKind).toBe('none');

    const lines = [
      step({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'task' }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'earlier turn text' }),
      step({ step_index: 2, type: 'CHECKPOINT', source: 'SYSTEM', content: '{{ CHECKPOINT 0 }}' }),
      step({ step_index: 3, type: 'GENERIC', source: 'SYSTEM', content: 'new turn activity' }),
    ];
    expect(parseTranscript(lines, 2).tailKind).toBe('tool-result');
    expect(parseTranscript(lines, 3).tailKind).toBe('none');
    expect(parseTranscript(lines, 3).plannerContents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// decideTailSettle: pure settle-guard decision
// ---------------------------------------------------------------------------

describe('decideTailSettle', () => {
  const QUIET = 10_000;
  const STABLE = 3_000;

  it('(a) tool-result tail: nudges once quiet, never settles before the budget is spent', () => {
    const base = {
      snap: snap({ isFinished: true, plannerContents: [WAITING_TEXT], tailKind: 'tool-result', engaged: true }),
      maxAutoContinue: 5,
      settleStableMs: STABLE,
      autoContinueQuietMs: QUIET,
    };
    expect(decideTailSettle({ ...base, tailQuietMs: QUIET - 1, autoContinueCount: 0 }).action).toBe('wait');
    expect(decideTailSettle({ ...base, tailQuietMs: QUIET, autoContinueCount: 0 })).toEqual({
      action: 'continue',
      reason: 'tool-tail',
    });
    expect(decideTailSettle({ ...base, tailQuietMs: QUIET, autoContinueCount: 4 })).toEqual({
      action: 'continue',
      reason: 'tool-tail',
    });
    expect(decideTailSettle({ ...base, tailQuietMs: QUIET, autoContinueCount: 5 })).toEqual({
      action: 'settle-exhausted',
      reason: 'tool-tail',
    });
  });

  it('(a) tool-call tail is guarded the same way', () => {
    const decision = decideTailSettle({
      snap: snap({ isFinished: true, plannerContents: [WAITING_TEXT], tailKind: 'tool-call', engaged: true }),
      tailQuietMs: QUIET,
      autoContinueCount: 0,
      maxAutoContinue: DEFAULT_AUTO_CONTINUE_MAX,
      settleStableMs: STABLE,
      autoContinueQuietMs: QUIET,
    });
    expect(decision).toEqual({ action: 'continue', reason: 'tool-tail' });
  });

  it('(b) a turn with zero assistant text: nudges when engaged, ignores turn-setup checkpoints', () => {
    const base = {
      snap: snap({ isFinished: true, plannerContents: [], tailKind: 'checkpoint', engaged: true }),
      maxAutoContinue: 5,
      settleStableMs: STABLE,
      autoContinueQuietMs: QUIET,
    };
    expect(decideTailSettle({ ...base, tailQuietMs: QUIET, autoContinueCount: 0 })).toEqual({
      action: 'continue',
      reason: 'no-assistant-text',
    });
    expect(decideTailSettle({ ...base, tailQuietMs: QUIET, autoContinueCount: 5 })).toEqual({
      action: 'settle-exhausted',
      reason: 'no-assistant-text',
    });
    // Turn-setup CHECKPOINT: the model has not started yet — never a stall.
    expect(
      decideTailSettle({
        ...base,
        snap: snap({ isFinished: true, plannerContents: [], tailKind: 'checkpoint', engaged: false }),
        tailQuietMs: QUIET * 10,
        autoContinueCount: 0,
      }).action,
    ).toBe('wait');
  });

  it('settles a genuine final reply only after the stability window', () => {
    const base = {
      snap: snap({ isFinished: true, plannerContents: ['All done.'], tailKind: 'checkpoint', engaged: true }),
      autoContinueCount: 0,
      maxAutoContinue: 5,
      settleStableMs: STABLE,
      autoContinueQuietMs: QUIET,
    };
    expect(decideTailSettle({ ...base, tailQuietMs: STABLE - 1 }).action).toBe('wait');
    expect(decideTailSettle({ ...base, tailQuietMs: STABLE })).toEqual({ action: 'settle' });
  });

  it('keeps waiting on live turns, errors, and pending approvals', () => {
    const base = {
      tailQuietMs: QUIET * 10,
      autoContinueCount: 0,
      maxAutoContinue: 5,
      settleStableMs: STABLE,
      autoContinueQuietMs: QUIET,
    };
    expect(decideTailSettle({ ...base, snap: snap({ isFinished: false, plannerContents: ['...'], tailKind: 'tool-call', engaged: true }) }).action).toBe('wait');
    expect(decideTailSettle({ ...base, snap: snap({ isFinished: true, plannerContents: [], tailKind: 'other', engaged: true, error: 'boom' }) }).action).toBe('wait');
    expect(decideTailSettle({ ...base, snap: snap({ isFinished: true, plannerContents: ['...'], tailKind: 'tool-call', engaged: true, pendingApproval: { name: 'x' } }) }).action).toBe('wait');
  });
});

// ---------------------------------------------------------------------------
// AntigravityService watcher integration (scripted transcript)
// ---------------------------------------------------------------------------

describe('AntigravityService tail-guard watcher', () => {
  afterEach(async () => {
    // nothing persistent: watchers settle (break) inside each test
  });

  it('nudges a tool-tail stall once, then settles on the fresh final reply', async () => {
    scriptSnapshots([
      {
        minBaseline: -1,
        s: snap({ maxStepIndex: 10, isFinished: true, plannerContents: [WAITING_TEXT], tailKind: 'tool-result', engaged: true }),
      },
      {
        minBaseline: 10,
        s: snap({ maxStepIndex: 11, isFinished: true, plannerContents: ['All checks passed; task complete.'], tailKind: 'assistant-text', engaged: true }),
      },
    ]);
    const { svc, sendMessage } = makeService();
    svc.ensureActiveWatcher('cid-a', undefined, -1);
    await driveUntilSettled(svc, 'cid-a');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('cid-a', 'Continue');
    const run = runOf(svc, 'cid-a');
    expect(run.status).toBe('done');
    expect(run.autoContinueCount).toBe(1);
    expect(run.autoContinueExhausted).toBeFalsy();
    expect(run.lastAutoContinueReason).toBe('tool-tail');
    // The nudge re-baselined the observation window...
    expect(run.baselineStepIndex).toBe(10);
    // ...archived the stale waiting text instead of losing it...
    expect(run.priorContents).toContain(WAITING_TEXT);
    // ...and the settled content is the fresh final reply, not the false summary.
    expect(run.content).toBe('All checks passed; task complete.');
  });

  it('stops after the auto-continue budget and settles with autoContinueExhausted', async () => {
    const stallAt = (maxStepIndex: number, minBaseline: number) => ({
      minBaseline,
      s: snap({ maxStepIndex, isFinished: true, plannerContents: ['still mid-work'], tailKind: 'tool-result' as const, engaged: true }),
    });
    scriptSnapshots([
      stallAt(10, -1),
      stallAt(12, 10),
      stallAt(14, 12),
      stallAt(16, 14),
      stallAt(18, 16),
      stallAt(20, 18),
    ]);
    const { svc, sendMessage } = makeService();
    svc.ensureActiveWatcher('cid-b', undefined, -1);
    await driveUntilSettled(svc, 'cid-b');

    expect(sendMessage).toHaveBeenCalledTimes(DEFAULT_AUTO_CONTINUE_MAX);
    const run = runOf(svc, 'cid-b');
    expect(run.autoContinueCount).toBe(DEFAULT_AUTO_CONTINUE_MAX);
    expect(run.status).toBe('done');
    expect(run.autoContinueExhausted).toBe(true);
  });

  it('nudges a no-assistant-text turn and settles once the model finally replies', async () => {
    scriptSnapshots([
      {
        minBaseline: -1,
        s: snap({ maxStepIndex: 8, isFinished: true, plannerContents: [], tailKind: 'checkpoint', engaged: true }),
      },
      {
        minBaseline: 8,
        s: snap({ maxStepIndex: 9, isFinished: true, plannerContents: ['Background task finished; results verified.'], tailKind: 'assistant-text', engaged: true }),
      },
    ]);
    const { svc, sendMessage } = makeService();
    svc.ensureActiveWatcher('cid-c', undefined, -1);
    await driveUntilSettled(svc, 'cid-c');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const run = runOf(svc, 'cid-c');
    expect(run.status).toBe('done');
    expect(run.autoContinueCount).toBe(1);
    expect(run.autoContinueExhausted).toBeFalsy();
    expect(run.lastAutoContinueReason).toBe('no-assistant-text');
    expect(run.content).toBe('Background task finished; results verified.');
  });

  it('settles a genuine completion without sending any nudge', async () => {
    scriptSnapshots([
      {
        minBaseline: -1,
        s: snap({ maxStepIndex: 5, isFinished: true, plannerContents: ['Done.'], tailKind: 'checkpoint', engaged: true }),
      },
    ]);
    const { svc, sendMessage } = makeService();
    svc.ensureActiveWatcher('cid-d', undefined, -1);
    await driveUntilSettled(svc, 'cid-d');

    expect(sendMessage).not.toHaveBeenCalled();
    const run = runOf(svc, 'cid-d');
    expect(run.status).toBe('done');
    expect(run.autoContinueCount ?? 0).toBe(0);
    expect(run.autoContinueExhausted).toBeFalsy();
    expect(run.content).toBe('Done.');
  });

  it('classifies a tool-tail snapshot as running, never as done (classifySnapshot)', async () => {
    const { svc } = makeService();
    const classify = (svc as unknown as {
      classifySnapshot: (brainDir: string, id: string, baseline: number) => Promise<{ status: string }>;
    }).classifySnapshot.bind(svc);

    mockRead.mockResolvedValueOnce(
      snap({ maxStepIndex: 10, isFinished: true, plannerContents: [WAITING_TEXT], tailKind: 'tool-result', engaged: true }),
    );
    expect(await classify('D:/brain', 'cid-e', -1)).toMatchObject({ status: 'running' });
    expect(runOf(svc, 'cid-e').status).toBe('running');

    mockRead.mockResolvedValueOnce(
      snap({ maxStepIndex: 6, isFinished: true, plannerContents: ['All done.'], tailKind: 'assistant-text', engaged: true }),
    );
    expect(await classify('D:/brain', 'cid-f', -1)).toMatchObject({ status: 'done' });
  });

  it('sendAutoContinue: archives content, re-baselines, honours the budget, and flags failed delivery', async () => {
    const { svc, sendMessage } = makeService({ autoContinueMax: 2 });
    const sendAutoContinue = (
      svc as unknown as {
        sendAutoContinue: (id: string, run: HubRun, s: TranscriptSnapshot, reason: 'tool-tail') => Promise<boolean>;
      }
    ).sendAutoContinue.bind(svc);

    const run: HubRun = {
      cascadeId: 'cid-g',
      status: 'running',
      startedAt: 1,
      turnSeq: 1,
      priorContents: [],
      content: 'partial progress text',
      baselineStepIndex: 4,
    };
    (svc as unknown as { runs: Map<string, HubRun> }).runs.set('cid-g', run);
    const tail = snap({ maxStepIndex: 9, isFinished: true, plannerContents: ['partial progress text'], tailKind: 'tool-result' });

    expect(await sendAutoContinue('cid-g', run, tail, 'tool-tail')).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith('cid-g', 'Continue');
    expect(run.autoContinueCount).toBe(1);
    expect(run.baselineStepIndex).toBe(9);
    expect(run.priorContents).toContain('partial progress text');
    expect(run.content).toBeUndefined();

    expect(await sendAutoContinue('cid-g', run, tail, 'tool-tail')).toBe(true);
    expect(run.autoContinueCount).toBe(2);

    // Budget spent: no more sends, exhausted flag set.
    expect(await sendAutoContinue('cid-g', run, tail, 'tool-tail')).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(run.autoContinueExhausted).toBe(true);
    expect(run.autoContinueCount).toBe(2);
  });

  it('sendAutoContinue: a failed hub send does not consume budget and reports false', async () => {
    const ctx = new Context();
    const svc = new AntigravityService(ctx, {});
    const sendMessage = vi.fn(async () => {
      throw new Error('hub unreachable');
    });
    (svc as unknown as { getHubClient: () => Promise<unknown> }).getHubClient = async () => ({ sendMessage });

    const run: HubRun = { cascadeId: 'cid-h', status: 'running', startedAt: 1, turnSeq: 1, priorContents: [] };
    (svc as unknown as { runs: Map<string, HubRun> }).runs.set('cid-h', run);
    const sendAutoContinue = (
      svc as unknown as {
        sendAutoContinue: (id: string, run: HubRun, s: TranscriptSnapshot, reason: 'tool-tail') => Promise<boolean>;
      }
    ).sendAutoContinue.bind(svc);

    expect(await sendAutoContinue('cid-h', run, snap({ maxStepIndex: 3, tailKind: 'tool-result' }), 'tool-tail')).toBe(false);
    expect(run.autoContinueCount ?? 0).toBe(0);
    expect(run.autoContinueExhausted).toBeFalsy();
  });
});
