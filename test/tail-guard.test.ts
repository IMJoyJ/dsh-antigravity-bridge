import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  parseTranscript,
  decideTailSettle,
  isWaitingSpeech,
  pruneStaleBackgroundTasks,
  isTaskIdMatch,
  OBSERVATIONAL_TOOL_NAMES,
  LAUNCH_OBSERVATION_GRACE_MS,
  type TranscriptSnapshot,
  type TranscriptStep,
  type ActiveBackgroundTask,
} from '../src/hub/transcript.js';
import { AntigravityService, DEFAULT_AUTO_CONTINUE_MAX, buildSettlementNotice } from '../src/index.js';
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
    const run = runOf(svc, cascadeId);
    if (!watchers.has(cascadeId) || (run && (run.status === 'done' || run.status === 'error'))) break;
    await vi.advanceTimersByTimeAsync(1000);
  }
  if (!watchers.has(cascadeId) && watcherPromise) await watcherPromise;
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
    expect(sendMessage).toHaveBeenCalledWith('cid-a', 'Continue', { planModel: undefined });
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
    expect(sendMessage).toHaveBeenCalledWith('cid-g', 'Continue', { planModel: undefined });
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

describe('Background Task Tracking in parseTranscript', () => {
  it('detects background task launch from tool output', () => {
    const lines = [
      step({ step_index: 0, type: 'USER_INPUT', content: 'Run test in background' }),
      step({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ tool_name: 'run_command', tool_args: { CommandLine: 'dotnet run tools/SelfPlay' } }],
      }),
      step({
        step_index: 2,
        type: 'TOOL_RESULT',
        status: 'RUNNING',
        source: 'EXECUTOR',
        taskDetails: { id: 'task-602', description: 'dotnet run tools/SelfPlay' },
        content:
          'Command launched in background.\nTool is running as a background task with task id: task-602\nTask Description: dotnet run tools/SelfPlay',
      }),
      step({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        content: 'I have started the background test run and will monitor it.',
      }),
    ];

    const parsed = parseTranscript(lines, -1);
    expect(parsed.activeBackgroundTasks).toHaveLength(1);
    expect(parsed.activeBackgroundTasks![0]).toMatchObject({
      taskId: 'task-602',
      description: 'dotnet run tools/SelfPlay',
      startStepIndex: 2,
    });
  });

  it('marks task completed when SYSTEM_MESSAGE with sender is received', () => {
    const lines = [
      step({ step_index: 0, type: 'USER_INPUT', content: 'Run test in background' }),
      step({
        step_index: 1,
        type: 'TOOL_RESULT',
        status: 'RUNNING',
        source: 'EXECUTOR',
        content: 'Tool is running as a background task with task id: task-602\nTask Description: dotnet run',
      }),
      step({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        content: 'Task started in background.',
      }),
      step({
        step_index: 3,
        type: 'SYSTEM_MESSAGE',
        source: 'SYSTEM',
        sender: 'task-602',
        content: 'Background task task-602 exited with code 0.',
      }),
    ];

    const parsed = parseTranscript(lines, -1);
    expect(parsed.activeBackgroundTasks).toHaveLength(0);
  });

  it('marks task completed when content contains Task id "..." finished', () => {
    const lines = [
      step({ step_index: 0, type: 'USER_INPUT', content: 'Run test' }),
      step({
        step_index: 1,
        type: 'TOOL_RESULT',
        status: 'RUNNING',
        source: 'EXECUTOR',
        content: 'Tool is running as a background task with task id: task-999',
      }),
      step({
        step_index: 2,
        type: 'SYSTEM_MESSAGE',
        source: 'SYSTEM',
        content: 'Task id "task-999" finished successfully.',
      }),
    ];

    const parsed = parseTranscript(lines, -1);
    expect(parsed.activeBackgroundTasks).toHaveLength(0);
  });

  it('marks task completed when manage_task reports DONE or CANCELLED', () => {
    const lines = [
      step({ step_index: 0, type: 'USER_INPUT', content: 'Run test' }),
      step({
        step_index: 1,
        type: 'TOOL_RESULT',
        status: 'RUNNING',
        source: 'EXECUTOR',
        content: 'Tool is running as a background task with task id: task-100',
      }),
      step({
        step_index: 2,
        type: 'TOOL_RESULT',
        source: 'EXECUTOR',
        content: 'Task: task-100\nStatus: DONE\nExit Code: 0',
      }),
    ];

    const parsed = parseTranscript(lines, -1);
    expect(parsed.activeBackgroundTasks).toHaveLength(0);
  });

  it('marks task completed via foreground progress fallback when newer tool calls occur', () => {
    const lines = [
      step({ step_index: 0, type: 'USER_INPUT', content: 'Run test' }),
      step({
        step_index: 10,
        type: 'GENERIC',
        status: 'RUNNING',
        content:
          'Tool is running as a background task with task id: 32294fd3-4c5e-40df-bbc3-f518adbe83b1/task-255\nTask Description: dotnet test',
      }),
      step({
        step_index: 11,
        type: 'PLANNER_RESPONSE',
        content: 'The test is running in the background.',
      }),
      // Session resumed and performed subsequent foreground operations (e.g. view_file / run_command)
      step({
        step_index: 12,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ tool_name: 'write_to_file', tool_args: { TargetFile: 'D:/test.cs', CodeContent: 'new' } }],
      }),
      step({
        step_index: 13,
        type: 'GENERIC',
        status: 'DONE',
        content: 'File written successfully',
      }),
    ];

    const parsed = parseTranscript(lines, -1, '32294fd3-4c5e-40df-bbc3-f518adbe83b1');
    expect(parsed.activeBackgroundTasks).toHaveLength(0);
  });

  it('R3: pure observational tools do NOT clear active background tasks via fallback', () => {
    for (const obsTool of ['view_file', 'manage_task', 'list_dir', 'grep_search', 'schedule']) {
      const lines = [
        step({ step_index: 0, type: 'USER_INPUT', content: 'Run long build' }),
        step({
          step_index: 10,
          type: 'GENERIC',
          status: 'RUNNING',
          taskDetails: { id: '32294fd3-4c5e-40df-bbc3-f518adbe83b1/task-255', description: 'dotnet build' },
          content:
            'Tool is running as a background task with task id: 32294fd3-4c5e-40df-bbc3-f518adbe83b1/task-255\nTask Description: dotnet build',
        }),
        step({
          step_index: 11,
          type: 'PLANNER_RESPONSE',
          content: 'Building in background...',
        }),
        step({
          step_index: 12,
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ tool_name: obsTool, tool_args: {} }],
        }),
        step({
          step_index: 13,
          type: 'GENERIC',
          status: 'DONE',
          content: 'Observation result',
        }),
      ];

      const parsed = parseTranscript(lines, -1, '32294fd3-4c5e-40df-bbc3-f518adbe83b1');
      expect(parsed.activeBackgroundTasks).toHaveLength(1);
      expect(parsed.activeBackgroundTasks[0].taskId).toBe('task-255');
    }
  });

  it('R3: schedule and timerCondition tasks are NEVER cleared by foreground progress fallback', () => {
    const lines = [
      step({ step_index: 0, type: 'USER_INPUT', content: 'Wait for task' }),
      step({
        step_index: 10,
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          {
            tool_name: 'schedule',
            tool_args: {
              DurationSeconds: 300,
              TimerCondition: 'task-602',
              Prompt: 'Check on task-602',
            },
          },
        ],
      }),
      step({
        step_index: 11,
        type: 'GENERIC',
        status: 'RUNNING',
        taskDetails: { id: '32294fd3-4c5e-40df-bbc3-f518adbe83b1/task-605', description: 'schedule timer' },
        content:
          'Tool is running as a background task with task id: 32294fd3-4c5e-40df-bbc3-f518adbe83b1/task-605\nTask Description: schedule timer',
      }),
      // Substantive tool is run (e.g. write_to_file)
      step({
        step_index: 12,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ tool_name: 'write_to_file', tool_args: { TargetFile: 'D:/foo.txt' } }],
      }),
      step({
        step_index: 13,
        type: 'GENERIC',
        status: 'DONE',
        content: 'File created',
      }),
    ];

    const parsed = parseTranscript(lines, -1, '32294fd3-4c5e-40df-bbc3-f518adbe83b1');
    expect(parsed.activeBackgroundTasks).toHaveLength(1);
    expect(parsed.activeBackgroundTasks[0].taskId).toBe('task-605');
  });

  it('strictly isolates tasks by cascadeId and rejects foreign cascade tasks', () => {
    const lines = [
      step({
        step_index: 1,
        type: 'GENERIC',
        status: 'RUNNING',
        taskDetails: { id: 'foreign-cascade-uuid/task-999', description: 'foreign task' },
        content:
          'Tool is running as a background task with task id: foreign-cascade-uuid/task-999\nTask Description: foreign task',
      }),
      step({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        taskDetails: { id: 'target-cascade-uuid/task-123', description: 'target task' },
        content:
          'Tool is running as a background task with task id: target-cascade-uuid/task-123\nTask Description: target task',
      }),
    ];

    const parsed = parseTranscript(lines, -1, 'target-cascade-uuid');
    expect(parsed.activeBackgroundTasks).toHaveLength(1);
    expect(parsed.activeBackgroundTasks![0].taskId).toBe('task-123');
  });

  it('rejects garbage task entries and does not match on assistant message text or status DONE', () => {
    const lines = [
      // Assistant response discussing regex / patterns
      step({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        content:
          'We match Tool is running as a background task with task id: <taskId> and manage_task Status: DONE',
      }),
      // A command stdout with status DONE that prints task descriptions
      step({
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        content:
          'Tool is running as a background task with task id: 84b2a576/task-969\nTask Description: dotnet run\n中文解释句子不能被当作任务描述',
      }),
      // Malformed taskId with invalid characters
      step({
        step_index: 3,
        type: 'GENERIC',
        status: 'RUNNING',
        content:
          'Tool is running as a background task with task id: file:///C:/logs/task.log\nTask Description: invalid',
      }),
    ];

    const parsed = parseTranscript(lines, -1, 'my-cascade');
    expect(parsed.activeBackgroundTasks).toHaveLength(0);
  });

  it('verifies real transcript from cascade 84b2a576 has 0 active tasks at completion and no crosstalk', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const realLog = 'C:/Users/JoyJ/.gemini/antigravity/brain/84b2a576-3cdb-4add-b05f-05675911acdd/.system_generated/logs/transcript_full.jsonl';
    if (!fs.existsSync(realLog)) return;

    const raw = fs.readFileSync(realLog, 'utf-8');
    const lines = raw.trim().split('\n').filter((l) => l.trim());

    // 1. Target cascade 84b2: all tasks are completed, activeBackgroundTasks is empty
    const parsedTarget = parseTranscript(lines, -1, '84b2a576-3cdb-4add-b05f-05675911acdd');
    expect(parsedTarget.activeBackgroundTasks).toEqual([]);

    // 2. Foreign cascade (e.g. 34351239): all 84b2 tasks are rejected, no crosstalk
    const parsedForeign = parseTranscript(lines, -1, '34351239-40c1-49c2-9f7f-9ea28f05502b');
    expect(parsedForeign.activeBackgroundTasks).toEqual([]);
  });

  it('isTaskIdMatch enforces strict cascade prefix isolation', () => {
    // Same bare IDs match
    expect(isTaskIdMatch('task-37', 'task-37')).toBe(true);
    // Bare ID matches prefixed ID
    expect(isTaskIdMatch('cid-1/task-37', 'task-37')).toBe(true);
    expect(isTaskIdMatch('task-37', 'cid-1/task-37')).toBe(true);
    // Same cascade prefix matches
    expect(isTaskIdMatch('cid-1/task-37', 'cid-1/task-37')).toBe(true);
    expect(isTaskIdMatch('cid-1:task-37', 'cid-1:task-37')).toBe(true);
    // Different cascade prefix MUST NOT match!
    expect(isTaskIdMatch('cid-1/task-37', 'cid-2/task-37')).toBe(false);
    expect(isTaskIdMatch('cid-1:task-37', 'cid-2:task-37')).toBe(false);
    expect(isTaskIdMatch('ea687300-6f23-447f-9816-7d406f4ca6e0/task-20', '91aa4afb-other/task-20')).toBe(false);
  });

  it('manage_task "No background tasks are currently running" completes all active tasks', () => {
    const lines = [
      step({ step_index: 0, type: 'USER_INPUT', content: 'Run tasks' }),
      step({
        step_index: 1,
        type: 'GENERIC',
        status: 'RUNNING',
        content:
          'Tool is running as a background task with task id: my-cascade/task-10\nTask Description: sleep 100',
      }),
      step({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        content:
          'Tool is running as a background task with task id: my-cascade/task-11\nTask Description: sleep 200',
      }),
      step({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        content: 'Tasks are running.',
      }),
      step({
        step_index: 4,
        type: 'MANAGE_TASK',
        status: 'DONE',
        content: 'No background tasks are currently running.',
      }),
    ];

    const parsed = parseTranscript(lines, -1, 'my-cascade');
    expect(parsed.activeBackgroundTasks).toHaveLength(0);
  });

  it('unblocks timerCondition satisfaction even if targetTask was marked finished earlier', () => {
    const lines = [
      step({ step_index: 0, type: 'USER_INPUT', content: 'Run test command' }),
      step({
        step_index: 1,
        type: 'GENERIC',
        status: 'RUNNING',
        content:
          'Tool is running as a background task with task id: cid-1/task-20\nTask Description: dotnet test',
      }),
      // Foreground progress marks task-20 finished prematurely
      step({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ tool_name: 'write_to_file', tool_args: { TargetFile: 'foo.txt' } }],
      }),
      step({
        step_index: 3,
        type: 'TOOL_RESULT',
        status: 'DONE',
        content: 'File written',
      }),
      // Now schedule a timer waiting on task-20
      step({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          {
            tool_name: 'schedule',
            tool_args: {
              DurationSeconds: 10,
              TimerCondition: 'cid-1/task-20',
              Prompt: 'Check if tests finished',
            },
          },
        ],
      }),
      step({
        step_index: 5,
        type: 'TOOL_RESULT',
        status: 'RUNNING',
        content:
          'Tool is running as a background task with task id: cid-1/task-37\nTask Description: Timer: 10s, Prompt: Check if tests finished',
      }),
      // SYSTEM_MESSAGE arrives for task-20
      step({
        step_index: 6,
        type: 'SYSTEM_MESSAGE',
        sender: 'task-20',
        content: 'Background task cid-1/task-20 finished with exit code 0',
      }),
    ];

    const parsed = parseTranscript(lines, -1, 'cid-1');
    // task-37 should be satisfied and finished when task-20 completes!
    expect(parsed.activeBackgroundTasks).toHaveLength(0);
  });

  it('pruneStaleBackgroundTasks: evicts overdue phantom tasks when transcript is stagnant for >= 15 minutes', () => {
    const tasks: ActiveBackgroundTask[] = [
      {
        taskId: 'task-37',
        description: 'Timer: 10s, Prompt: Check if tests finished',
        startedAt: '2026-09-08T05:50:38Z',
        startStepIndex: 37,
        durationSeconds: 10,
        isSchedule: true,
      },
    ];

    const startMs = Date.parse('2026-09-08T05:50:38Z');
    // 20 minutes later; transcript idle for 20 minutes
    const nowMs = startMs + 20 * 60 * 1000;
    const lastActiveAtMs = startMs;

    const { activeTasks, prunedTasks } = pruneStaleBackgroundTasks(tasks, {
      nowMs,
      lastActiveAtMs,
    });

    expect(prunedTasks).toHaveLength(1);
    expect(prunedTasks[0].taskId).toBe('task-37');
    expect(activeTasks).toHaveLength(0);
  });

  it('pruneStaleBackgroundTasks: evicts generic orphan task with no duration after 15m idle', () => {
    const tasks: ActiveBackgroundTask[] = [
      {
        taskId: 'task-99',
        description: 'orphan command without duration',
        startedAt: '2026-09-08T05:00:00Z',
        startStepIndex: 10,
      },
    ];

    const startMs = Date.parse('2026-09-08T05:00:00Z');
    // 16 minutes later; transcript idle for 16 minutes
    const nowMs = startMs + 16 * 60 * 1000;
    const lastActiveAtMs = startMs;

    const { activeTasks, prunedTasks } = pruneStaleBackgroundTasks(tasks, {
      nowMs,
      lastActiveAtMs,
    });

    expect(prunedTasks).toHaveLength(1);
    expect(prunedTasks[0].taskId).toBe('task-99');
    expect(activeTasks).toHaveLength(0);
  });

  it('pruneStaleBackgroundTasks: COUNTER-EXAMPLE PROTECTION - never evicts long-running server when transcript is active', () => {
    const tasks: ActiveBackgroundTask[] = [
      {
        taskId: 'task-server',
        description: 'node ygopro-server.js',
        startedAt: '2026-09-08T02:00:00Z', // running for 4 hours
        startStepIndex: 5,
      },
    ];

    const nowMs = Date.parse('2026-09-08T06:00:00Z');
    // Transcript is actively growing! Last activity was 30 seconds ago
    const lastActiveAtMs = nowMs - 30 * 1000;

    const { activeTasks, prunedTasks } = pruneStaleBackgroundTasks(tasks, {
      nowMs,
      lastActiveAtMs,
    });

    expect(prunedTasks).toHaveLength(0);
    expect(activeTasks).toHaveLength(1);
    expect(activeTasks[0].taskId).toBe('task-server');
  });

  it('pruneStaleBackgroundTasks: does not evict recently started task even if transcript was idle', () => {
    const nowMs = Date.parse('2026-09-08T06:00:00Z');
    const tasks: ActiveBackgroundTask[] = [
      {
        taskId: 'task-fresh',
        description: 'fresh task started 2 minutes ago',
        startedAt: new Date(nowMs - 2 * 60 * 1000).toISOString(),
        startStepIndex: 50,
      },
    ];

    const lastActiveAtMs = nowMs - 20 * 60 * 1000;

    const { activeTasks, prunedTasks } = pruneStaleBackgroundTasks(tasks, {
      nowMs,
      lastActiveAtMs,
    });

    expect(prunedTasks).toHaveLength(0);
    expect(activeTasks).toHaveLength(1);
    expect(activeTasks[0].taskId).toBe('task-fresh');
  });

  it('verifies real transcript from cascade ea687300 has 0 active tasks at completion and resolves deadlocked task-37', async () => {
    const fs = await import('fs');
    const realLog =
      'C:/Users/JoyJ/.gemini/antigravity/brain/ea687300-6f23-447f-9816-7d406f4ca6e0/.system_generated/logs/transcript_full.jsonl';
    if (!fs.existsSync(realLog)) return;

    const raw = fs.readFileSync(realLog, 'utf-8');
    const lines = raw.trim().split('\n').filter((l) => l.trim());

    // 1. Target cascade ea687300: parseTranscript correctly resolves task-37
    const parsed = parseTranscript(lines, -1, 'ea687300-6f23-447f-9816-7d406f4ca6e0');
    console.log('[REAL VERIFICATION ea687300] activeBackgroundTasks length:', parsed.activeBackgroundTasks?.length);
    console.log('[REAL VERIFICATION ea687300] activeBackgroundTasks:', JSON.stringify(parsed.activeBackgroundTasks));
    console.log('[REAL VERIFICATION ea687300] isFinished:', parsed.isFinished);
    console.log('[REAL VERIFICATION ea687300] maxStepIndex:', parsed.maxStepIndex);
    expect(parsed.activeBackgroundTasks).toEqual([]);
    expect(parsed.isFinished).toBe(true);

    // 2. Prune with current time also results in 0 active tasks
    const lastActiveMs = parsed.lastActiveAt ? Date.parse(parsed.lastActiveAt) : Date.now();
    const { activeTasks, prunedTasks } = pruneStaleBackgroundTasks(parsed.activeBackgroundTasks, {
      nowMs: Date.now(),
      lastActiveAtMs: lastActiveMs,
    });
    expect(activeTasks).toEqual([]);
    console.log('[REAL VERIFICATION ea687300] Pruned active tasks:', activeTasks.length, 'Pruned tasks:', prunedTasks.length);

    // 3. Foreign cascade lookup rejects all ea68 tasks
    const parsedForeign = parseTranscript(lines, -1, '91aa4afb-foreign-cascade-id');
    expect(parsedForeign.activeBackgroundTasks).toEqual([]);
  });
});

describe('decideTailSettle background task gating', () => {
  const activeTask: ActiveBackgroundTask = {
    taskId: 'task-602',
    description: 'dotnet run tools/SelfPlay',
    startedAt: '2026-09-07T15:00:00Z',
    startStepIndex: 2,
  };

  it('returns wait-background when activeBackgroundTasks is non-empty even if turn is finished with assistant text', () => {
    const s = snap({
      maxStepIndex: 10,
      isFinished: true,
      plannerContents: ['All tests have been initiated in the background.'],
      tailKind: 'assistant-text',
      activeBackgroundTasks: [activeTask],
    });

    const decision = decideTailSettle({
      snap: s,
      tailQuietMs: 15_000,
      autoContinueCount: 0,
      maxAutoContinue: 5,
    });

    expect(decision.action).toBe('wait-background');
    expect(decision.reason).toBe('background-task');
    expect(decision.activeTasks).toEqual([activeTask]);
  });

  it('settles normally when activeBackgroundTasks is empty or undefined', () => {
    const s = snap({
      maxStepIndex: 10,
      isFinished: true,
      plannerContents: ['Task completely done.'],
      tailKind: 'assistant-text',
      activeBackgroundTasks: [],
    });

    const decision = decideTailSettle({
      snap: s,
      tailQuietMs: 15_000,
      autoContinueCount: 0,
      maxAutoContinue: 5,
    });

    expect(decision.action).toBe('settle');
  });
});

describe('AntigravityService Background Task Watcher Lifecycle', () => {
  const activeTask: ActiveBackgroundTask = {
    taskId: 'task-602',
    description: 'dotnet run tools/SelfPlay',
    startedAt: new Date(Date.now() - 360_000).toISOString(), // started 6 minutes ago
    startStepIndex: 5,
  };

  it('enters waiting-background status and does not settle or auto-continue', async () => {
    const { svc, sendMessage } = makeService();
    const deliverSpy = vi.spyOn(svc, 'deliverMessageToAgent' as any).mockReturnValue(true);

    let state: 'waiting' | 'finished' = 'waiting';

    mockRead.mockImplementation(async () => {
      if (state === 'waiting') {
        return snap({
          maxStepIndex: 5,
          isFinished: true,
          engaged: true,
          plannerContents: ['Background tests running.'],
          tailKind: 'assistant-text',
          activeBackgroundTasks: [activeTask],
        });
      }
      return snap({
        maxStepIndex: 8,
        isFinished: true,
        engaged: true,
        plannerContents: ['Background tests finished successfully!'],
        tailKind: 'assistant-text',
        activeBackgroundTasks: [],
      });
    });

    const watch = (
      svc as unknown as {
        runCascadeWatcher: (id: string, baseline: number, caller?: any) => Promise<void>;
      }
    ).runCascadeWatcher.bind(svc);

    const callerAgent = { id: 'test-agent' };
    const watcherPromise = watch('cid-bg-1', -1, callerAgent);

    // Advance 5 seconds: watcher should observe background task and enter waiting-background
    await vi.advanceTimersByTimeAsync(5000);
    const run = runOf(svc, 'cid-bg-1');
    expect(run.status).toBe('waiting-background');
    expect(sendMessage).not.toHaveBeenCalled(); // No auto-continue sent!
    expect(deliverSpy).not.toHaveBeenCalled(); // Under 5 minutes in current waiting episode; no premature warning!

    // Advance to 5 minutes (300,000ms from start of episode): warning should fire
    await vi.advanceTimersByTimeAsync(295_000);
    expect(deliverSpy).toHaveBeenCalled();
    const deliveredMsg = deliverSpy.mock.calls[0][1] as any;
    expect(deliveredMsg.source.form).toBe('notice');
    expect(deliveredMsg.source.summary).toContain('后台任务运行中');
    expect(deliveredMsg.source.summary).toContain('已等待 5.0 分钟');

    // DeliverSpy should not be called again within 5 minutes (rate limit check)
    deliverSpy.mockClear();
    await vi.advanceTimersByTimeAsync(60_000); // 1 minute later
    expect(deliverSpy).not.toHaveBeenCalled();

    // Now complete the background task
    state = 'finished';
    await vi.advanceTimersByTimeAsync(20_000); // settle stable window (15s + confirmation)

    expect(run.status).toBe('done');
    expect(run.content).toContain('Background tests finished successfully!');
    expect(run.lastBackgroundWarningAt).toBeGreaterThan(0);
  });

  it('enforces 2-minute global rate limit across distinct waiting episodes and measures elapsed time from episode start', () => {
    const { svc } = makeService();
    const deliverSpy = vi.spyOn(svc, 'deliverMessageToAgent' as any).mockReturnValue(true);

    const now = Date.now();
    const run: HubRun = {
      cascadeId: 'cid-multi-episodes',
      status: 'waiting-background',
      startedAt: now - 3600_000, // cascade started 1 hour ago
      waitingBackgroundStartedAt: now - 300_000, // current episode started 5 mins ago
      callerAgent: { id: 'agent-1' },
    };

    const task: ActiveBackgroundTask = {
      taskId: 'task-1',
      description: 'compile project',
      startedAt: new Date(now - 300_000).toISOString(),
    };

    // 1. First warning in episode 1
    (svc as any).notifyWaitingBackgroundToDsh(run, [task]);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const msg1 = deliverSpy.mock.calls[0][1] as any;
    // Must show ~5.0 minutes (episode elapsed time), NOT 60 minutes from run.startedAt!
    expect(msg1.source.summary).toContain('已等待 5.0 分钟');
    const firstWarnTime = run.lastBackgroundWarningAt!;
    expect(firstWarnTime).toBeGreaterThan(0);

    // 2. Episode 1 finishes: status flipped to running, waitingBackgroundStartedAt cleared, lastBackgroundWarningAt kept
    run.status = 'running';
    run.waitingBackgroundStartedAt = undefined;
    expect(run.lastBackgroundWarningAt).toBe(firstWarnTime);

    // 3. Episode 2 starts 10 seconds later:
    vi.advanceTimersByTime(10_000);
    const ep2Start = Date.now();
    run.status = 'waiting-background';
    run.waitingBackgroundStartedAt = ep2Start;
    deliverSpy.mockClear();

    // 4. Advance time by 72 seconds (total 82s since first warning: 1.2 minutes)
    vi.advanceTimersByTime(72_000);
    // Even if episode threshold is simulated, 2-minute global rate limit blocks warning
    run.waitingBackgroundStartedAt = Date.now() - 300_000;
    (svc as any).notifyWaitingBackgroundToDsh(run, [task]);
    expect(deliverSpy).not.toHaveBeenCalled(); // Blocked by 2-minute global rate limit!

    // 5. Advance time past 2 minutes from first warning and past 5-minute episode threshold:
    run.waitingBackgroundStartedAt = ep2Start; // Restore actual episode 2 start
    vi.advanceTimersByTime(230_000); // 10s + 72s + 230s = 312s (> 5 mins for episode 2, and > 5 mins since warn 1)
    (svc as any).notifyWaitingBackgroundToDsh(run, [task]);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const msg2 = deliverSpy.mock.calls[0][1] as any;
    // Episode 2 elapsed time measured accurately from Episode 2 start (5.0 minutes, NOT 60+ minutes from cascade start)
    expect(msg2.source.summary).toContain('已等待 5.0 分钟');
  });

  it('bypasses 120s stall detection when background task is running', async () => {
    const { svc } = makeService({ stallTimeoutMs: 120_000 });
    const handleCascadeErrorSpy = vi.spyOn(svc, 'handleCascadeError' as any);

    mockRead.mockResolvedValue(
      snap({
        maxStepIndex: 5,
        isFinished: false,
        engaged: true,
        plannerContents: ['Still executing...'],
        tailKind: 'none',
        activeBackgroundTasks: [activeTask],
      }),
    );

    const watch = (
      svc as unknown as {
        runCascadeWatcher: (id: string, baseline: number, caller?: any) => Promise<void>;
      }
    ).runCascadeWatcher.bind(svc);

    void watch('cid-bg-stall', -1);

    // Advance 150 seconds (greater than 120s stallTimeoutMs)
    await vi.advanceTimersByTimeAsync(150_000);

    // Stall error must NOT be triggered
    expect(handleCascadeErrorSpy).not.toHaveBeenCalled();
    expect(runOf(svc, 'cid-bg-stall').status).toBe('waiting-background');
  });

  it('classifySnapshot returns waiting-background when background task is active', async () => {
    const { svc } = makeService();
    const classify = (
      svc as unknown as {
        classifySnapshot: (b: string, id: string, bl: number) => Promise<any>;
      }
    ).classifySnapshot.bind(svc);

    mockRead.mockResolvedValueOnce(
      snap({
        maxStepIndex: 4,
        isFinished: true,
        engaged: true,
        plannerContents: ['Waiting for background job'],
        tailKind: 'assistant-text',
        activeBackgroundTasks: [activeTask],
      }),
    );

    const result = await classify('D:/brain', 'cid-bg-classify', -1);
    expect(result.status).toBe('waiting-background');
    expect(result.activeBackgroundTasks).toEqual([activeTask]);
    expect(runOf(svc, 'cid-bg-classify').status).toBe('waiting-background');
  });

  describe('R2: waiting speech gate (isWaitingSpeech and decideTailSettle)', () => {
    it('isWaitingSpeech correctly recognizes waiting speech and respects completion override', () => {
      expect(isWaitingSpeech('I am waiting for task-602 to complete.')).toBe(true);
      expect(isWaitingSpeech('Waiting for task-1234 to finish.')).toBe(true);
      expect(isWaitingSpeech('The process is still running in background, waiting for notification.')).toBe(true);
      expect(isWaitingSpeech('已设置定时器，等待后台任务唤醒。')).toBe(true);
      expect(isWaitingSpeech('Awaiting timer notification from task-500.')).toBe(true);

      // Negative cases: completion semantics take precedence
      expect(isWaitingSpeech('Task-602 has finished running.')).toBe(false);
      expect(isWaitingSpeech('Waiting for task-602 is completed; all tests passed.')).toBe(false);
      expect(isWaitingSpeech('Background execution finished successfully.')).toBe(false);
      expect(isWaitingSpeech('后台任务已运行完成，测试全部通过。')).toBe(false);
      expect(isWaitingSpeech('Done.')).toBe(false);
      expect(isWaitingSpeech(undefined)).toBe(false);
      expect(isWaitingSpeech('')).toBe(false);
    });

    it('decideTailSettle does NOT wait on waiting speech alone (zero-regex settle)', () => {
      const snapWait = snap({
        maxStepIndex: 10,
        isFinished: true,
        tailKind: 'assistant-text',
        plannerContents: ['I am waiting for task-602 to finish.'],
        activeBackgroundTasks: [],
      });
      const decision = decideTailSettle({
        snap: snapWait,
        tailQuietMs: 10_000,
        autoContinueCount: 0,
        maxAutoContinue: 5,
        settleStableMs: 3_000,
        autoContinueQuietMs: 5_000,
      });
      // Zero-regex settle: speech text does NOT gate settlement
      expect(decision.action).toBe('settle');
    });

    it('decideTailSettle returns wait-background when hasActiveChildren is true (blindspot 1)', () => {
      const snapChild = snap({
        maxStepIndex: 10,
        isFinished: true,
        tailKind: 'assistant-text',
        plannerContents: ['Delegated subagent task.'],
        activeBackgroundTasks: [],
        hasActiveChildren: true,
      });
      const decision = decideTailSettle({
        snap: snapChild,
        tailQuietMs: 10_000,
        autoContinueCount: 0,
        maxAutoContinue: 5,
        settleStableMs: 3_000,
        autoContinueQuietMs: 5_000,
      });
      expect(decision.action).toBe('wait-background');
      expect(decision.reason).toBe('background-task');
    });

    it('decideTailSettle settles when planner output is genuine completion', () => {
      const snapDone = snap({
        maxStepIndex: 10,
        isFinished: true,
        tailKind: 'assistant-text',
        plannerContents: ['Task-602 completed successfully. All 15 tests passed.'],
        activeBackgroundTasks: [],
      });
      const decision = decideTailSettle({
        snap: snapDone,
        tailQuietMs: 10_000,
        autoContinueCount: 0,
        maxAutoContinue: 5,
        settleStableMs: 3_000,
        autoContinueQuietMs: 5_000,
      });
      expect(decision.action).toBe('settle');
    });
  });

  describe('R1: watcher done-residency & fake-done recovery', () => {
    it('detects fake-done on transcript growth, reverts status to running, and delivers second done notification', async () => {
      const { svc } = makeService();
      vi.spyOn(svc as any, 'deliverMessageToAgent').mockReturnValue(true);
      const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

      // 1. Initial fake done at step 10
      let currentSnap = snap({
        maxStepIndex: 10,
        isFinished: true,
        engaged: true,
        tailKind: 'assistant-text',
        plannerContents: ['Premature done at step 10'],
      });

      mockRead.mockImplementation(async () => currentSnap);

      svc.ensureActiveWatcher('cid-fake-done', undefined, -1);

      // Advance timers past settleStableMs (15_000ms) and confirmation window (10_000ms) to trigger first settlement
      await vi.advanceTimersByTimeAsync(20_000);

      const run = runOf(svc, 'cid-fake-done');
      expect(run.status).toBe('done');
      expect(run.settledStepIndex).toBe(10);
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(run.lastNotifiedTransition).toContain('done:turn1::step10');

      // 2. Transcript grows to step 15 (e.g. background task completed, model woke up)
      currentSnap = snap({
        maxStepIndex: 15,
        isFinished: false,
        engaged: true,
        tailKind: 'tool-call',
        plannerContents: ['Premature done at step 10', 'Resuming work after background task...'],
      });

      // Advance timers: watcher should detect fake done and revert to running
      await vi.advanceTimersByTimeAsync(2000);

      expect(run.status).toBe('running');
      expect(run.lastNotifiedTransition).toBeUndefined();
      expect(run.settledStepIndex).toBeUndefined();

      // 3. Real completion at step 20
      currentSnap = snap({
        maxStepIndex: 20,
        isFinished: true,
        engaged: true,
        tailKind: 'assistant-text',
        plannerContents: [
          'Premature done at step 10',
          'Resuming work after background task...',
          'Real final completion: task-602 finished successfully!',
        ],
      });

      await vi.advanceTimersByTimeAsync(20_000);

      expect(run.status).toBe('done');
      expect(run.settledStepIndex).toBe(20);
      expect(notifySpy).toHaveBeenCalledTimes(2);
      expect(run.lastNotifiedTransition).toContain('done:turn1::step20');
    });

    it('evicts phantom task in watcher loop, transitions from waiting-background to running, and settles to done', async () => {
      const { svc } = makeService();
      vi.spyOn(svc, 'deliverMessageToAgent' as any).mockReturnValue(true);

      const phantomTask: ActiveBackgroundTask = {
        taskId: 'task-37',
        description: 'Timer: 10s, Prompt: Check if tests finished',
        startedAt: '2026-09-08T05:50:38Z',
        startStepIndex: 37,
        durationSeconds: 10,
        isSchedule: true,
      };

      const cid = 'cid-stale-evict';
      (svc as any).runs.set(cid, {
        cascadeId: cid,
        status: 'running',
        startedAt: Date.now() - 600_000,
        baselineStepIndex: -1,
        turnSeq: 1,
      });

      let currentSnap: TranscriptSnapshot = snap({
        maxStepIndex: 40,
        isFinished: true,
        tailKind: 'assistant-text',
        plannerContents: ['All tests completed.'],
        activeBackgroundTasks: [phantomTask],
      });

      mockRead.mockImplementation(async () => currentSnap);

      svc.ensureActiveWatcher(cid, undefined, -1);

      // Run 1 cycle: enters waiting-background
      await vi.advanceTimersByTimeAsync(3000);
      const run = runOf(svc, cid);
      expect(run.status).toBe('waiting-background');

      // Next: readCascadeTranscript prunes the stale task, returning activeBackgroundTasks: []
      currentSnap = snap({
        maxStepIndex: 40,
        isFinished: true,
        tailKind: 'assistant-text',
        plannerContents: ['All tests completed.'],
        activeBackgroundTasks: [],
      });

      // Advance timers past settleStableMs (15_000ms) and idleCycles
      await vi.advanceTimersByTimeAsync(20_000);

      expect(run.status).toBe('done');
      expect(run.waitingBackgroundStartedAt).toBeUndefined();
    });

    it('initState startup recovery settles stale waiting-background run to done without warning alarms', async () => {
      const fsp = await import('node:fs/promises');
      const pathMod = await import('node:path');
      const osMod = await import('node:os');
      const tmpDir = await fsp.mkdtemp(pathMod.join(osMod.tmpdir(), 'agy-init-test-'));

      try {
        const { svc } = makeService({ appDataDir: tmpDir });
        const deliverSpy = vi.spyOn(svc, 'deliverMessageToAgent' as any).mockReturnValue(true);

        const cid = 'cid-initstate-stale';
        (svc as any).runs.set(cid, {
          cascadeId: cid,
          status: 'waiting-background',
          startedAt: Date.now() - 3600_000,
          waitingBackgroundStartedAt: Date.now() - 1800_000,
          baselineStepIndex: -1,
          turnSeq: 1,
        });

        // Persist to disk so initState can read state.json
        await (svc as any).saveStateNow();

        // On startup, readCascadeTranscript returns a finished snapshot where the task was pruned
        mockRead.mockImplementation(async () =>
          snap({
            maxStepIndex: 50,
            isFinished: true,
            tailKind: 'assistant-text',
            plannerContents: ['Work completed.'],
            activeBackgroundTasks: [],
          }),
        );

        // Call initState directly
        await (svc as any).initState();

        const run = runOf(svc, cid);
        expect(run.status).toBe('done');
        expect(run.waitingBackgroundStartedAt).toBeUndefined();
        // No waiting-background notifications were emitted
        const waitingCalls = deliverSpy.mock.calls.filter((c: any) =>
          c[2] && typeof c[2].body === 'string' && c[2].body.includes('仍在后台运行中'),
        );
        expect(waitingCalls).toHaveLength(0);
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe('Real Task-driven Settle, Task Silence Tool & Residue Warnings (User Ruling Amendment 2)', () => {
    it('silenceTask: supports timed silence and auto-expiration', () => {
      const { svc } = makeService();
      const cid = 'cid-silence-1';
      (svc as any).runs.set(cid, {
        cascadeId: cid,
        status: 'waiting-background',
        startedAt: Date.now(),
        baselineStepIndex: -1,
        turnSeq: 1,
      });

      // Silence task-100 for 30 seconds
      const res = svc.silenceTask(cid, 'task-100', 30);
      expect(res.success).toBe(true);
      expect(res.infinite).toBe(false);
      expect(res.durationSeconds).toBe(30);

      // Check immediately: silenced, not infinite
      const status1 = svc.isTaskSilenced(cid, 'task-100');
      expect(status1).toEqual({ silenced: true, infinite: false });

      // Check normalization: matches raw number '100' as well
      const statusNorm = svc.isTaskSilenced(cid, '100');
      expect(statusNorm).toEqual({ silenced: true, infinite: false });

      // Advance time by 29 seconds: still silenced
      vi.advanceTimersByTime(29_000);
      expect(svc.isTaskSilenced(cid, 'task-100').silenced).toBe(true);

      // Advance time by 2 seconds (total 31s): expired
      vi.advanceTimersByTime(2_000);
      expect(svc.isTaskSilenced(cid, 'task-100')).toEqual({ silenced: false, infinite: false });
    });

    it('silenceTask: supports infinite silence (duration <= 0 or omitted)', () => {
      const { svc } = makeService();
      const cid = 'cid-silence-2';
      (svc as any).runs.set(cid, {
        cascadeId: cid,
        status: 'waiting-background',
        startedAt: Date.now(),
        baselineStepIndex: -1,
        turnSeq: 1,
      });

      // Infinite silence with duration_seconds = 0
      const res0 = svc.silenceTask(cid, 'task-200', 0);
      expect(res0.infinite).toBe(true);
      expect(svc.isTaskSilenced(cid, 'task-200')).toEqual({ silenced: true, infinite: true });

      // Infinite silence with duration_seconds omitted
      const resOmitted = svc.silenceTask(cid, 'task-300');
      expect(resOmitted.infinite).toBe(true);
      expect(svc.isTaskSilenced(cid, 'task-300')).toEqual({ silenced: true, infinite: true });

      // Advance 100 days: still infinite
      vi.advanceTimersByTime(100 * 24 * 3600 * 1000);
      expect(svc.isTaskSilenced(cid, 'task-300')).toEqual({ silenced: true, infinite: true });
    });

    it('settle blocking: un-silenced active task strictly blocks settle; timed silence does not unblock settle', () => {
      const activeTask: ActiveBackgroundTask = {
        taskId: 'task-blocking-1',
        description: 'cargo test',
        command: 'cargo test',
        startedAt: new Date().toISOString(),
      };

      // 1. Un-silenced task blocks settle
      const decision1 = decideTailSettle({
        snap: snap({
          isFinished: true,
          tailKind: 'assistant-text',
          plannerContents: ['All tests dispatched to background.'],
          activeBackgroundTasks: [activeTask],
        }),
        blockingBackgroundTasks: [activeTask],
        tailQuietMs: 10_000,
        autoContinueCount: 0,
        maxAutoContinue: 5,
        settleStableMs: 1_000,
        autoContinueQuietMs: 2_000,
      });
      expect(decision1.action).toBe('wait-background');
      expect(decision1.reason).toBe('background-task');

      // 2. Timed silence blocks settle as well (timed silence only suppresses warnings, does NOT unblock settle)
      const decisionTimed = decideTailSettle({
        snap: snap({
          isFinished: true,
          tailKind: 'assistant-text',
          plannerContents: ['All tests dispatched to background.'],
          activeBackgroundTasks: [activeTask],
        }),
        blockingBackgroundTasks: [activeTask], // timed silence still counts as blocking
        tailQuietMs: 10_000,
        autoContinueCount: 0,
        maxAutoContinue: 5,
        settleStableMs: 1_000,
        autoContinueQuietMs: 2_000,
      });
      expect(decisionTimed.action).toBe('wait-background');
    });

    it('infinite silence settle: infinitely silenced task does NOT block settle, and settle notice includes residual task warning & machine-readable fields', () => {
      const activeTask: ActiveBackgroundTask = {
        taskId: 'task-inf-1',
        description: 'long daemon server',
        command: 'python server.py',
        startedAt: new Date().toISOString(),
      };

      // When infinitely silenced, blockingBackgroundTasks is empty
      const decision = decideTailSettle({
        snap: snap({
          isFinished: true,
          tailKind: 'assistant-text',
          plannerContents: ['Server daemon launched in background.'],
          activeBackgroundTasks: [activeTask],
        }),
        blockingBackgroundTasks: [], // Infinite silence filtered out from blocking tasks
        tailQuietMs: 10_000,
        autoContinueCount: 0,
        maxAutoContinue: 5,
        settleStableMs: 1_000,
        autoContinueQuietMs: 2_000,
      });
      expect(decision.action).toBe('settle');

      // Now verify settlement notice generation
      const run: HubRun = {
        cascadeId: 'cid-residual-test',
        status: 'done',
        startedAt: Date.now() - 65_000,
        baselineStepIndex: 0,
        settledStepIndex: 88,
        residualBackgroundTasks: ['task-inf-1'],
        content: 'Server daemon launched in background.',
      };
      const notice = buildSettlementNotice(run);
      expect(notice.noticeText).toContain('- **Settled Step Index**: `88`');
      expect(notice.noticeText).toContain('- **Active Background Tasks**: 1');
      expect(notice.noticeText).toContain('- **Residual Background Task IDs**: `task-inf-1`');
      expect(notice.noticeText).toContain(
        '> ⚠️ **静默后台任务残留警告**: 有静默后台任务仍在运行中，id=task-inf-1，请适时通知该车道终止任务。'
      );
    });

    it('R1 false-done rollback: pushes reverted-from-done notification when activity resumes after settlement', () => {
      const { svc } = makeService();
      const deliverSpy = vi.spyOn(svc, 'deliverMessageToAgent' as any).mockReturnValue(true);

      const run: HubRun = {
        cascadeId: 'cid-r1-revert-test',
        status: 'running',
        startedAt: Date.now() - 100_000,
        baselineStepIndex: 0,
        settledStepIndex: 40,
        callerAgentId: 'agent-1',
      };

      svc.notifyRevertedFromDoneToDsh(run, {
        oldSettledStep: 40,
        currentStep: 45,
        oldActiveAt: '2026-09-26T10:00:00Z',
        currentActiveAt: '2026-09-26T10:01:00Z',
      });

      expect(deliverSpy).toHaveBeenCalledTimes(1);
      const msg = deliverSpy.mock.calls[0][1];
      expect(msg.source.kind).toBe('subagent-settled');
      expect(msg.source.revertedFromDone).toBe(true);
      expect(msg.source.oldSettledStep).toBe(40);
      expect(msg.source.currentStep).toBe(45);
      expect(msg.content[0].text).toContain('结算撤回 (Reverted from Done)');
      expect(msg.content[0].text).toContain('40 -> 45');
    });

    it('3s early probe: waiting speech prevents premature done settlement', () => {
      // isWaitingSpeech checks
      expect(isWaitingSpeech('已提交后台运行，请稍候。')).toBe(true);
      expect(isWaitingSpeech('后台任务已启动，正在后台运行')).toBe(true);
      expect(isWaitingSpeech('耐心等待测试完成')).toBe(true);
      expect(isWaitingSpeech('All background tasks launched. Please wait a moment.')).toBe(true);
      // Legitimate completions must not be flagged
      expect(isWaitingSpeech('所有测试已全部执行完毕，结果如下：通过。')).toBe(false);
      expect(isWaitingSpeech('All tasks completed successfully.')).toBe(false);
    });

    it('parseTranscript: structured step.taskDetails and step.task_details are parsed without regex reliance', () => {
      const rawLines = [
        step({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          content: 'Launching background build.',
        }),
        JSON.stringify({
          step_index: 2,
          type: 'TOOL_EXECUTION',
          source: 'MODEL',
          status: 'RUNNING',
          taskDetails: {
            id: 'task-99',
            description: 'cargo build --release',
          },
        }),
      ];

      const snapshot = parseTranscript(rawLines, -1, 'cid-proto-test');
      expect(snapshot.activeBackgroundTasks).toHaveLength(1);
      expect(snapshot.activeBackgroundTasks![0].taskId).toBe('task-99');
      expect(snapshot.activeBackgroundTasks![0].description).toBe('cargo build --release');

      // Now add completion step
      const rawWithCompletion = [
        ...rawLines,
        JSON.stringify({
          step_index: 3,
          type: 'TOOL_EXECUTION',
          source: 'SYSTEM',
          status: 'DONE',
          task_details: {
            id: 'task-99',
          },
        }),
      ];

      const completedSnapshot = parseTranscript(rawWithCompletion, -1, 'cid-proto-test');
      expect(completedSnapshot.activeBackgroundTasks).toHaveLength(0);
    });

    it('parseTranscript: supports structured task launch and IDE timer completion patterns', () => {
      const rawLines = [
        JSON.stringify({
          step_index: 1,
          type: 'TOOL_EXECUTION',
          source: 'SYSTEM',
          status: 'RUNNING',
          task_details: { id: 'cid-cn-test/task-101', description: '执行命令' },
          content: '执行命令中，已转入后台运行 (task-101)',
        }),
      ];

      const snap1 = parseTranscript(rawLines, -1, 'cid-cn-test');
      expect(snap1.activeBackgroundTasks).toHaveLength(1);
      expect(snap1.activeBackgroundTasks![0].taskId).toBe('task-101');

      // IDE timer completion pattern via SYSTEM_MESSAGE (Blindspot 2)
      const rawWithDone = [
        ...rawLines,
        JSON.stringify({
          step_index: 2,
          type: 'SYSTEM_MESSAGE',
          source: 'SYSTEM',
          status: 'DONE',
          content: '任务 "task-101" 已完成，所有结果收集完毕。',
        }),
      ];

      const snap2 = parseTranscript(rawWithDone, -1, 'cid-cn-test');
      expect(snap2.activeBackgroundTasks).toHaveLength(0);
    });
  });

  describe('Two-Phase Settlement Confirmation (Phase 3 Regression)', () => {
    it('rejects settlement when final-looking text has round 1 empty tasks but round 2 discovers active tasks', async () => {
      const { svc } = makeService();
      const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

      // Transcript has final-looking declaration text
      const transcriptSnap = snap({
        maxStepIndex: 100,
        isFinished: true,
        engaged: true,
        tailKind: 'assistant-text',
        plannerContents: ['I have launched benchmark run 1 of 3, please wait...'],
        activeBackgroundTasks: [],
      });
      mockRead.mockResolvedValue(transcriptSnap);

      // Mock getStructuredCascadeTasks:
      // Call 1 (Round 1): 0 tasks (manifest window race)
      // Call 2+ (Round 2 fresh read): task appears!
      let taskQueryCount = 0;
      vi.spyOn(svc, 'getStructuredCascadeTasks').mockImplementation(async () => {
        taskQueryCount++;
        if (taskQueryCount === 1) {
          return { activeTasks: [], allTasks: [], hasActiveChildren: false, isCascadeActive: false };
        }
        return {
          activeTasks: [{ taskId: 'task-101', description: 'cargo test', startStepIndex: 101 }],
          allTasks: [{ taskId: 'task-101', description: 'cargo test', startStepIndex: 101 }],
          hasActiveChildren: false,
          isCascadeActive: false,
        };
      });

      svc.ensureActiveWatcher('cid-two-phase-rejection', undefined, -1);

      // Advance timers past SETTLE_STABLE_MS (15s) and confirmation interval (10s)
      await vi.advanceTimersByTimeAsync(20_000);

      const run = runOf(svc, 'cid-two-phase-rejection');
      // Must NOT be settled as done!
      expect(run.status).not.toBe('done');
      expect(run.settledStepIndex).toBeUndefined();
      expect(notifySpy).not.toHaveBeenCalled();
    });

    it('settles cleanly when two consecutive rounds are consistent and quiet', async () => {
      const { svc } = makeService();
      const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

      const transcriptSnap = snap({
        maxStepIndex: 50,
        isFinished: true,
        engaged: true,
        tailKind: 'assistant-text',
        plannerContents: ['All tasks completed successfully. Here are the results.'],
        activeBackgroundTasks: [],
      });
      mockRead.mockResolvedValue(transcriptSnap);

      vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
        activeTasks: [],
        allTasks: [],
        hasActiveChildren: false,
        isCascadeActive: false,
      });

      svc.ensureActiveWatcher('cid-two-phase-settle', undefined, -1);

      // Advance timers past SETTLE_STABLE_MS (15s) and confirmation interval (10s)
      await vi.advanceTimersByTimeAsync(20_000);

      const run = runOf(svc, 'cid-two-phase-settle');
      expect(run.status).toBe('done');
      expect(run.settledStepIndex).toBe(50);
      expect(notifySpy).toHaveBeenCalledTimes(1);
    });

    it('rejects settlement when trajectory indicates cascade is active (isCascadeActive: true)', async () => {
      const { svc } = makeService();
      const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

      const transcriptSnap = snap({
        maxStepIndex: 50,
        isFinished: true,
        engaged: true,
        tailKind: 'assistant-text',
        plannerContents: ['Working on it...'],
        activeBackgroundTasks: [],
      });
      mockRead.mockResolvedValue(transcriptSnap);

      vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
        activeTasks: [],
        allTasks: [],
        hasActiveChildren: false,
        isCascadeActive: true, // cascade is still running at the turn level
      });

      svc.ensureActiveWatcher('cid-two-phase-cascade-active', undefined, -1);

      await vi.advanceTimersByTimeAsync(20_000);

      const run = runOf(svc, 'cid-two-phase-cascade-active');
      expect(run.status).not.toBe('done');
      expect(notifySpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // D2 — launch hysteresis: an empty task list right after launch is
  //     "unobserved", not "none" (false idle → revert-from-done)
  // -------------------------------------------------------------------------
  describe('D2 launch observation hysteresis', () => {
    const settledLooking = (over: Partial<TranscriptSnapshot> = {}) => snap({
      maxStepIndex: 50,
      isFinished: true,
      engaged: true,
      tailKind: 'assistant-text',
      plannerContents: ['All done, the report is in src/.'], // closing reply, tool-tail absent
      activeBackgroundTasks: [], // hub has not published any task yet
      ...over,
    });

    const baseInput = (over: Record<string, unknown> = {}) => ({
      snap: settledLooking(),
      tailQuietMs: 60_000,
      autoContinueCount: 0,
      maxAutoContinue: DEFAULT_AUTO_CONTINUE_MAX,
      settleStableMs: 15_000,
      autoContinueQuietMs: 10_000,
      ...over,
    });

    it('refuses to settle from an empty task list inside the observation window', () => {
      const decision = decideTailSettle(baseInput({
        sinceLifecycleStartMs: LAUNCH_OBSERVATION_GRACE_MS - 1,
      }) as any);
      expect(decision.action).toBe('wait');
      expect(decision.reason).toBe('background-task-unobserved');
    });

    it('settles normally once the observation window has closed', () => {
      const decision = decideTailSettle(baseInput({
        sinceLifecycleStartMs: LAUNCH_OBSERVATION_GRACE_MS,
      }) as any);
      expect(decision.action).toBe('settle');
    });

    it('leaves pre-existing callers (no launch info) on the old behaviour', () => {
      expect(decideTailSettle(baseInput() as any).action).toBe('settle');
    });

    it('still reports a positively-observed live cascade as wait-background inside the window', () => {
      const withTask = decideTailSettle(baseInput({
        sinceLifecycleStartMs: 1_000,
        blockingBackgroundTasks: [{ taskId: 'task-1', startStepIndex: 3 }],
      }) as any);
      expect(withTask.action).toBe('wait-background');

      const cascadeActive = decideTailSettle(baseInput({
        sinceLifecycleStartMs: 1_000,
        isCascadeActive: true,
      }) as any);
      expect(cascadeActive.action).toBe('wait-background');

      const withChildren = decideTailSettle(baseInput({
        sinceLifecycleStartMs: 1_000,
        hasActiveChildren: true,
      }) as any);
      expect(withChildren.action).toBe('wait-background');
    });

    it('does not suppress the tool-tail auto-continue diagnosis inside the window', () => {
      // The hysteresis must not swallow the "paused mid-work" signal; it only
      // refuses the *settle* conclusion.
      const decision = decideTailSettle(baseInput({
        sinceLifecycleStartMs: LAUNCH_OBSERVATION_GRACE_MS,
        snap: settledLooking({ tailKind: 'tool-result' }),
      }) as any);
      expect(decision.action).toBe('continue');
      expect(decision.reason).toBe('tool-tail');
    });

    it('watcher: a freshly launched cascade with an empty task list does not settle', async () => {
      const { svc } = makeService();
      const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

      mockRead.mockResolvedValue(settledLooking());
      vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
        activeTasks: [],
        allTasks: [],
        hasActiveChildren: false,
        isCascadeActive: false,
      });

      svc.ensureActiveWatcher('cid-launch-hysteresis', undefined, -1);
      // run.startedAt is "now" (fake timers): inside the observation window.
      await vi.advanceTimersByTimeAsync(15_000);

      expect(runOf(svc, 'cid-launch-hysteresis').status).not.toBe('done');
      expect(notifySpy).not.toHaveBeenCalled();

      // Past the window the same (unchanging, still task-less) observation settles.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runOf(svc, 'cid-launch-hysteresis').status).toBe('done');
      expect(notifySpy).toHaveBeenCalledTimes(1);
    });
  });
});
