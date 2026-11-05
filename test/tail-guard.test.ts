import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import {
  parseTranscript,
  decideTailSettle,
  mergeBackgroundTasks,
  BACKGROUND_TASK_LAUNCH_MARKER_REGEX,
  BACKGROUND_TASK_LOG_URI_REGEX,
  MANAGE_TASK_EMPTY_LIST_REGEX,
  pruneStaleBackgroundTasks,
  isTaskIdMatch,
  assessBackgroundTaskProgress,
  DEFAULT_BACKGROUND_TASK_STALL_THRESHOLD_MS,
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
    vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
      authoritative: true,
      activeTasks: [],
      allTasks: [],
      hasActiveChildren: false,
      isCascadeActive: false,
    });
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
    vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
      authoritative: true,
      activeTasks: [],
      allTasks: [],
      hasActiveChildren: false,
      isCascadeActive: false,
    });
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
    vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
      authoritative: true,
      activeTasks: [],
      allTasks: [],
      hasActiveChildren: false,
      isCascadeActive: false,
    });
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
    vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
      authoritative: true,
      activeTasks: [],
      allTasks: [],
      hasActiveChildren: false,
      isCascadeActive: false,
    });
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
    vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
      authoritative: true,
      activeTasks: [],
      allTasks: [],
      hasActiveChildren: false,
      isCascadeActive: false,
    });
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
    // Read-side classification is observational for terminal `done`: the run
    // record must NOT latch it (the watcher is the single announcer; a latched
    // done here made check_run polls swallow the settlement notice).
    expect(runOf(svc, 'cid-f').status).toBe('running');
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
    vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
      authoritative: true,
      activeTasks: [],
      allTasks: [],
      hasActiveChildren: false,
      isCascadeActive: false,
    });
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

  describe('R2: zero-regex speech gate and decideTailSettle', () => {
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

  describe('R1: watcher done-residency & removal of fake-done rollback', () => {
    it('settle 之后 transcript 增长不会触发任何 revert/复活：watcher 已 break', async () => {
      const { svc } = makeService();
      vi.spyOn(svc as any, 'deliverMessageToAgent').mockReturnValue(true);
      const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

      vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
        authoritative: true,
        activeTasks: [],
        allTasks: [],
        hasActiveChildren: false,
        isCascadeActive: false,
      });

      // 1. Initial settlement at step 10
      let currentSnap = snap({
        maxStepIndex: 10,
        isFinished: true,
        engaged: true,
        tailKind: 'assistant-text',
        plannerContents: ['Settling at step 10'],
      });

      mockRead.mockImplementation(async () => currentSnap);

      svc.ensureActiveWatcher('cid-settle-break', undefined, -1);

      // Advance timers past settleStableMs (15_000ms) and confirmation window (10_000ms) to settle
      await vi.advanceTimersByTimeAsync(25_000);

      const run = runOf(svc, 'cid-settle-break');
      expect(run.status).toBe('done');
      expect(run.settledStepIndex).toBe(10);
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(run.lastNotifiedTransition).toContain('done:turn1::step10');

      // 2. Transcript grows to step 15
      currentSnap = snap({
        maxStepIndex: 15,
        isFinished: false,
        engaged: true,
        tailKind: 'tool-call',
        plannerContents: ['Settling at step 10', 'Late wake up or background message arrived...'],
      });

      // Advance timers: watcher has broken out upon settlement, no rollback/revert path exists
      await vi.advanceTimersByTimeAsync(30_000);

      expect(run.status).toBe('done');
      expect(run.settledStepIndex).toBe(10);
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(run.lastNotifiedTransition).toContain('done:turn1::step10');
    });

    it('evicts phantom task in watcher loop, transitions from waiting-background to running, and settles to done', async () => {
      const { svc } = makeService();
      vi.spyOn(svc, 'deliverMessageToAgent' as any).mockReturnValue(true);
      vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
        authoritative: true,
        activeTasks: [],
        allTasks: [],
        hasActiveChildren: false,
        isCascadeActive: false,
      });

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
        authoritative: true,
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
        authoritative: true,
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

  describe('Defect D4: Manual Stop & Cancellation Handling', () => {
    it('settles cleanly as done when hub reports manual stop or step canceled, check_run does not return running', async () => {
      const { svc } = makeService();
      const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

      // Cascade was aborted mid-turn during a tool call (isFinished: false, tailKind: tool-call)
      // but hub / trajectory reports canceled step and idle cascade
      const canceledSnap = snap({
        maxStepIndex: 2,
        isFinished: false,
        engaged: true,
        tailKind: 'tool-call',
        hasCanceledStep: true,
        firstCreatedAt: '2026-10-03T10:00:00.000Z',
      });
      mockRead.mockResolvedValue(canceledSnap);

      vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
        activeTasks: [],
        allTasks: [],
        hasActiveChildren: false,
        isCascadeActive: false,
        isCanceled: true,
        hasCanceledStep: true,
      });

      // 1. Instant check_run should return status: 'done', not 'running'
      const checkRes = (await svc.hubCheckRun('cid-d4-canceled', false)) as any;
      expect(checkRes.status).toBe('done');
      // elapsedMs must not be ~22ms: Date.now() - 2026-10-03T10:00:00.000Z
      expect(checkRes.elapsedMs).toBeGreaterThan(1000);

      // 2. Watcher running for an active cascade: when user cancels it, settles immediately to 'done' and notifies DSH
      svc.ensureActiveWatcher('cid-d4-watcher-cancel', undefined, -1);
      await vi.advanceTimersByTimeAsync(2000);

      const run = runOf(svc, 'cid-d4-watcher-cancel');
      expect(run.status).toBe('done');
      expect(notifySpy).toHaveBeenCalled();
    });

    it('does not falsely revert to running when new cancellation steps arrive on a settled cascade', async () => {
      const { svc } = makeService();
      const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

      // 1. Initial done state (e.g. parent cascade settled at step 49)
      let currentSnap = snap({
        maxStepIndex: 49,
        isFinished: true,
        engaged: true,
        tailKind: 'assistant-text',
        plannerContents: ['Waiting for subagents.'],
      });
      mockRead.mockImplementation(async () => currentSnap);

      vi.spyOn(svc, 'getStructuredCascadeTasks').mockImplementation(async () => ({
        authoritative: true,
        activeTasks: [],
        allTasks: [],
        hasActiveChildren: false,
        isCascadeActive: false,
        isCanceled: false,
        hasCanceledStep: false,
      }));

      svc.ensureActiveWatcher('cid-d4-revert-guard', undefined, -1);
      // Wait past confirmation window to settle
      await vi.advanceTimersByTimeAsync(25_000);

      const run = runOf(svc, 'cid-d4-revert-guard');
      expect(run.status).toBe('done');
      expect(run.settledStepIndex).toBe(49);
      expect(notifySpy).toHaveBeenCalledTimes(1);

      // 2. User stops subagents in IDE, generating cancellation / system messages (step 49 -> 58)
      currentSnap = snap({
        maxStepIndex: 58,
        isFinished: true,
        engaged: true,
        tailKind: 'other',
        hasCanceledStep: true,
        plannerContents: ['Waiting for subagents.'],
      });

      vi.spyOn(svc, 'getStructuredCascadeTasks').mockImplementation(async () => ({
        authoritative: true,
        activeTasks: [],
        allTasks: [],
        hasActiveChildren: false,
        isCascadeActive: false,
        isCanceled: true,
        hasCanceledStep: true,
      }));

      // Advance watcher: watcher had already broken out upon settlement, status stays done
      await vi.advanceTimersByTimeAsync(3000);

      // Must NOT revert to running! Settled cascade stays done
      expect(run.status).toBe('done');
      expect(run.settledStepIndex).toBe(49);
      expect(notifySpy).toHaveBeenCalledTimes(1);
    });

    it('preserves D2 launch hysteresis: empty task list inside 20s window without cancel mark still waits', () => {
      // decideTailSettle unit test ensuring D2 is not swallowed by D4
      const decision = decideTailSettle({
        snap: snap({
          isFinished: true,
          engaged: true,
          tailKind: 'assistant-text',
          plannerContents: ['All setup done.'],
          hasCanceledStep: false,
        }),
        tailQuietMs: 1000,
        autoContinueCount: 0,
        maxAutoContinue: 5,
        settleStableMs: 15_000,
        autoContinueQuietMs: 2000,
        blockingBackgroundTasks: [],
        hasActiveChildren: false,
        isCascadeActive: false,
        isCanceled: false,
        sinceLifecycleStartMs: 5_000, // inside 20s grace window
        launchObservationGraceMs: 20_000,
      });

      expect(decision.action).toBe('wait');
      expect(decision.reason).toBe('background-task-unobserved');
    });

    it('settles immediately inside 20s window if cascade is explicitly canceled by user', () => {
      // D4 override: when explicitly canceled by user, no need to wait 20s
      const decision = decideTailSettle({
        snap: snap({
          isFinished: true,
          engaged: true,
          tailKind: 'assistant-text',
          plannerContents: ['Aborted.'],
          hasCanceledStep: true,
        }),
        tailQuietMs: 1000,
        autoContinueCount: 0,
        maxAutoContinue: 5,
        settleStableMs: 15_000,
        autoContinueQuietMs: 2000,
        blockingBackgroundTasks: [],
        hasActiveChildren: false,
        isCascadeActive: false,
        isCanceled: true,
        sinceLifecycleStartMs: 5_000, // inside 20s grace window
        launchObservationGraceMs: 20_000,
      });

      expect(decision.action).toBe('settle');
    });

    describe('Defect D5: State view vs IDE reality sync & stalled task awareness', () => {
      it('assessBackgroundTaskProgress: distinguishes recent tasks from tasks silent >= stall threshold', () => {
        const now = Date.now();
        const freshTask: ActiveBackgroundTask = {
          taskId: 'task-recent',
          startedAt: new Date(now - 5 * 60 * 1000).toISOString(), // 5 min ago
          startStepIndex: 1,
        };
        const freshProgress = assessBackgroundTaskProgress(freshTask, { nowMs: now });
        expect(freshProgress.isStalled).toBe(false);
        expect(freshProgress.stalledDurationMs).toBe(5 * 60 * 1000);

        const stalledTask: ActiveBackgroundTask = {
          taskId: 'task-hung',
          startedAt: new Date(now - 25 * 60 * 1000).toISOString(), // 25 min ago
          startStepIndex: 2,
        };
        const stalledProgress = assessBackgroundTaskProgress(stalledTask, { nowMs: now });
        expect(stalledProgress.isStalled).toBe(true);
        expect(stalledProgress.stalledDurationMs).toBe(25 * 60 * 1000);

        // Custom stall threshold
        const customProgress = assessBackgroundTaskProgress(freshTask, {
          nowMs: now,
          stallThresholdMs: 3 * 60 * 1000,
        });
        expect(customProgress.isStalled).toBe(true);
      });

      it('long-running task protection: stalled task is marked as suspected stalled but NEVER prematurely killed or settled', async () => {
        const { svc } = makeService({
          backgroundTaskStallThresholdMs: 15 * 60 * 1000,
        });
        const deliverSpy = vi.spyOn(svc, 'deliverMessageToAgent' as any).mockReturnValue(true);

        const now = Date.now();
        const stalledTask: ActiveBackgroundTask = {
          taskId: 'task-long-run',
          description: 'run 5 rounds mutation experiments',
          startedAt: new Date(now - 25 * 60 * 1000).toISOString(), // 25m ago
          startStepIndex: 10,
        };

        mockRead.mockResolvedValue(
          snap({
            maxStepIndex: 10,
            isFinished: true,
            engaged: true,
            plannerContents: ['Mutation experiments are running in background.'],
            tailKind: 'assistant-text',
            activeBackgroundTasks: [stalledTask],
          }),
        );

        vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
          activeTasks: [stalledTask],
          allTasks: [stalledTask],
          hasActiveChildren: false,
          isCascadeActive: false,
          authoritative: true,
        });

        const callerAgent = { id: 'coordinator' };
        const watch = (
          svc as unknown as {
            runCascadeWatcher: (id: string, baseline: number, caller?: any) => Promise<void>;
          }
        ).runCascadeWatcher.bind(svc);

        watch('cid-d5-long-task', -1, callerAgent);

        // Advance 5 seconds: watcher starts and detects active task
        await vi.advanceTimersByTimeAsync(5000);
        const run = runOf(svc, 'cid-d5-long-task');

        // Assert: Cascade stays in waiting-background, NOT killed, NOT errored, NOT settled to done!
        expect(run.status).toBe('waiting-background');
        expect(run.hasStalledBackgroundTasks).toBe(true);

        // Advance to 5 minutes so periodic waiting-background notification triggers
        await vi.advanceTimersByTimeAsync(300_000);
        expect(deliverSpy).toHaveBeenCalled();
        const notificationMsg = deliverSpy.mock.calls[0][1] as any;
        const noticeText = notificationMsg.content[0].text;
        const summary = notificationMsg.source.summary;

        // Assert notification clearly states suspected stalled and silent duration instead of lying
        expect(noticeText).toContain('后台任务疑似停滞');
        expect(noticeText).toContain('`waiting-background` (疑似停滞)');
        expect(noticeText).toContain('已无日志输出');
        expect(noticeText).toContain('疑似停滞');
        expect(noticeText).toContain('task-long-run');
        expect(summary).toContain('后台任务疑似停滞');

        // Crucial assertion: Cascade is STILL alive in waiting-background after notification!
        expect(run.status).toBe('waiting-background');
      });

      it('reproduction & fix: when background task disappears from authoritative source, cascade settles cleanly as done', async () => {
        const { svc } = makeService();
        const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

        // Initial state: transcript has a lingering task-299 that crashed without writing SYSTEM_MESSAGE
        const task299: ActiveBackgroundTask = {
          taskId: 'task-299',
          description: 'pwsh mutation script',
          startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          startStepIndex: 298,
        };

        let currentSnap = snap({
          maxStepIndex: 299,
          isFinished: true,
          engaged: true,
          plannerContents: ['Started mutation script in background.'],
          tailKind: 'assistant-text',
          activeBackgroundTasks: [task299], // Lingering task in transcript
        });
        mockRead.mockImplementation(async () => currentSnap);

        // The hub / SQLite authoritative query knows the task is gone (activeTasks: [])
        vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
          activeTasks: [],
          allTasks: [{ ...task299, isActive: false }],
          hasActiveChildren: false,
          isCascadeActive: false,
          authoritative: true,
        });

        const callerAgent = { id: 'coordinator' };
        const watch = (
          svc as unknown as {
            runCascadeWatcher: (id: string, baseline: number, caller?: any) => Promise<void>;
          }
        ).runCascadeWatcher.bind(svc);

        // Initialize run as previously waiting-background
        const run: HubRun = {
          cascadeId: 'cid-d5-reproduce',
          status: 'waiting-background',
          startedAt: Date.now() - 60_000, // outside 20s grace window
          waitingBackgroundStartedAt: Date.now() - 40 * 60 * 1000,
          turnSeq: 1,
          priorContents: [],
          callerAgent,
        };
        (svc as any).runs.set('cid-d5-reproduce', run);

        watch('cid-d5-reproduce', -1, callerAgent);

        // Advance through settlement and confirmation window (15s stable + 10s round 2)
        await vi.advanceTimersByTimeAsync(25_000);

        // Assert: cascade recognized authoritative task completion, exited waiting-background, and settled to done!
        expect(run.status).toBe('done');
        expect(run.settledStepIndex).toBe(299);
        expect(notifySpy).toHaveBeenCalledTimes(1);
      });

      it('classifySnapshot respects authoritative active tasks disappearance outside grace window', async () => {
        const { svc } = makeService();
        const classify = svc.classifySnapshot.bind(svc);

        const lingeringTask: ActiveBackgroundTask = {
          taskId: 'task-299',
          description: 'mutation script',
          startedAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
          startStepIndex: 10,
        };

        // Transcript still has lingering task
        mockRead.mockResolvedValue(
          snap({
            maxStepIndex: 15,
            isFinished: true,
            engaged: true,
            plannerContents: ['Task finished.'],
            tailKind: 'assistant-text',
            activeBackgroundTasks: [lingeringTask],
          }),
        );

        // Authoritative source reports activeTasks empty, with lingering task positively terminated in allTasks
        vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
          activeTasks: [],
          allTasks: [{ ...lingeringTask, isActive: false }],
          hasActiveChildren: false,
          isCascadeActive: false,
          authoritative: true,
        });

        // Existing run started 10 minutes ago (well outside 20s grace window)
        const existing: HubRun = {
          cascadeId: 'cid-d5-classify',
          status: 'waiting-background',
          startedAt: Date.now() - 600_000,
          turnSeq: 1,
          priorContents: [],
        };
        (svc as any).runs.set('cid-d5-classify', existing);

        const result = await classify('D:/brain', 'cid-d5-classify', -1);

        // Assert: classifySnapshot uses authoritative empty active tasks and settles to done
        expect(result.status).toBe('done');
        expect(result.activeBackgroundTasks).toEqual([]);
      });
    });
  });

  describe('Waiting-Background Terminal Spec Requirements (§5.2)', () => {
    it('1. parseTranscript recognizes launch marker template in GENERIC step and clears it on completion SYSTEM_MESSAGE', () => {
      const cid = 'cascade-launch-test';
      const launchContent =
        'Tool is running as a background task with task id: cascade-launch-test/task-148 ' +
        'Task Description: dotnet build ' +
        'Task logs are available at: file:///C:/x/task-148.log ' +
        'YOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) either proceed to other relevant work (if any) or, B) simply update the user with a short message';

      const lines = [
        step({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'run dotnet build' }),
        JSON.stringify({
          step_index: 1,
          type: 'GENERIC',
          source: 'SYSTEM',
          status: 'DONE',
          content: launchContent,
        }),
      ];

      const snap1 = parseTranscript(lines, -1, cid);
      expect(snap1.activeBackgroundTasks).toHaveLength(1);
      expect(snap1.activeBackgroundTasks[0].taskId).toBe('task-148');
      expect(snap1.activeBackgroundTasks[0].description).toBe('dotnet build');
      expect(snap1.activeBackgroundTasks[0].logUri).toBe('file:///C:/x/task-148.log');

      // Append completion SYSTEM_MESSAGE
      const linesWithCompletion = [
        ...lines,
        JSON.stringify({
          step_index: 2,
          type: 'SYSTEM_MESSAGE',
          source: 'SYSTEM',
          status: 'DONE',
          content: 'Task id "cascade-launch-test/task-148" finished with result: Build succeeded.',
        }),
      ];

      const snap2 = parseTranscript(linesWithCompletion, -1, cid);
      expect(snap2.activeBackgroundTasks).toHaveLength(0);
    });

    it('2. manage_task empty list in GENERIC step finishes non-schedule active tasks while protecting schedule tasks', () => {
      const cid = 'cascade-empty-list-test';
      const launchContent =
        'Tool is running as a background task with task id: cascade-empty-list-test/task-148 ' +
        'Task Description: dotnet build ' +
        'Task logs are available at: file:///C:/x/task-148.log';

      const lines = [
        step({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'start commands' }),
        // Normal background task from launch template
        JSON.stringify({
          step_index: 1,
          type: 'GENERIC',
          source: 'SYSTEM',
          status: 'DONE',
          content: launchContent,
        }),
        // Schedule/timer task
        JSON.stringify({
          step_index: 2,
          type: 'TOOL_EXECUTION',
          source: 'MODEL',
          status: 'RUNNING',
          taskDetails: {
            id: 'task-99',
            description: 'Timer: 10s wait',
            is_schedule: true,
          },
        }),
      ];

      const snap1 = parseTranscript(lines, -1, cid);
      expect(snap1.activeBackgroundTasks).toHaveLength(2);

      // manage_task response with "No background tasks are currently running." at the end
      const linesWithManageTask = [
        ...lines,
        JSON.stringify({
          step_index: 3,
          type: 'GENERIC',
          source: 'SYSTEM',
          status: 'DONE',
          content: 'Created At: 2026-10-06\nTask: task-148\nStatus: TERMINATED\nNo background tasks are currently running.',
        }),
      ];

      const snap2 = parseTranscript(linesWithManageTask, -1, cid);
      expect(snap2.activeBackgroundTasks).toHaveLength(1);
      expect(snap2.activeBackgroundTasks[0].taskId).toBe('task-99');
      expect(snap2.activeBackgroundTasks[0].isSchedule).toBe(true);
    });

    it('3. registration grace window regression: does not settle when transcript tracks active task and hub query returns authoritative empty', async () => {
      const { svc } = makeService();
      const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

      const transcriptTask: ActiveBackgroundTask = {
        taskId: 'task-148',
        description: 'dotnet build',
        startStepIndex: 1,
        startedAt: new Date(Date.now() - 30_000).toISOString(),
      };

      // 1. Transcript tracks task-148, but hub query returns empty (hub registration delay)
      let currentSnap = snap({
        maxStepIndex: 5,
        isFinished: true,
        engaged: true,
        plannerContents: ['dotnet build launched in background'],
        tailKind: 'assistant-text',
        activeBackgroundTasks: [transcriptTask],
      });
      mockRead.mockImplementation(async () => currentSnap);

      vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
        authoritative: true,
        activeTasks: [],
        allTasks: [], // task-148 not even registered in allTasks yet
        hasActiveChildren: false,
        isCascadeActive: false,
      });

      const cid = 'cid-reg-window-regression';
      (svc as any).runs.set(cid, {
        cascadeId: cid,
        status: 'running',
        startedAt: Date.now() - 30_000, // outside grace window
        baselineStepIndex: -1,
        turnSeq: 1,
        priorContents: [],
      });

      svc.ensureActiveWatcher(cid, undefined, -1);

      // Advance 30 seconds past settleStableMs (15s) and confirmation interval (10s)
      await vi.advanceTimersByTimeAsync(30_000);

      const run = runOf(svc, cid);
      // MUST NOT settle to done! Union preserves transcript task
      expect(run.status).toBe('waiting-background');
      expect(notifySpy).not.toHaveBeenCalled();

      // 2. Task completion SYSTEM_MESSAGE arrives
      currentSnap = snap({
        maxStepIndex: 8,
        isFinished: true,
        engaged: true,
        plannerContents: ['dotnet build launched in background', 'dotnet build completed successfully.'],
        tailKind: 'assistant-text',
        activeBackgroundTasks: [],
      });

      // Advance timers for settlement
      await vi.advanceTimersByTimeAsync(30_000);

      expect(run.status).toBe('done');
      expect(notifySpy).toHaveBeenCalledTimes(1);
    });

    describe('4. mergeBackgroundTasks utility', () => {
      it('gives transcript tasks priority and de-duplicates by taskId', () => {
        const tTasks: ActiveBackgroundTask[] = [
          { taskId: 'task-148', description: 'from transcript', startStepIndex: 1 },
        ];
        const hActiveTasks: ActiveBackgroundTask[] = [
          { taskId: 'cascade-x/task-148', description: 'from hub', startStepIndex: 1 },
          { taskId: 'task-200', description: 'hub extra task', startStepIndex: 2 },
        ];

        const merged = mergeBackgroundTasks(tTasks, hActiveTasks);
        expect(merged).toHaveLength(2);
        expect(merged[0].taskId).toBe('task-148');
        expect(merged[0].description).toBe('from transcript');
        expect(merged[1].taskId).toBe('task-200');
        expect(merged[1].description).toBe('hub extra task');
      });

      it('retires transcript task when hubAllTasks has positive termination evidence (isActive === false)', () => {
        const tTasks: ActiveBackgroundTask[] = [
          { taskId: 'task-148', description: 'from transcript', startStepIndex: 1 },
          { taskId: 'task-149', description: 'still alive', startStepIndex: 2 },
        ];
        const hubAllTasks = [
          { taskId: 'task-148', isActive: false, startStepIndex: 1 },
        ];

        const merged = mergeBackgroundTasks(tTasks, [], hubAllTasks);
        expect(merged).toHaveLength(1);
        expect(merged[0].taskId).toBe('task-149');
      });

      it('does NOT retire transcript task when hubAllTasks does not contain that taskId', () => {
        const tTasks: ActiveBackgroundTask[] = [
          { taskId: 'task-148', description: 'from transcript', startStepIndex: 1 },
        ];
        const hubAllTasks = [
          { taskId: 'task-999', isActive: false, startStepIndex: 999 },
        ];

        const merged = mergeBackgroundTasks(tTasks, [], hubAllTasks);
        expect(merged).toHaveLength(1);
        expect(merged[0].taskId).toBe('task-148');
      });
    });

    it('5. circuit breaker: Round-2 refuses to settle to done when freshTasks.authoritative is false', async () => {
      const { svc } = makeService();
      const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

      mockRead.mockResolvedValue(
        snap({
          maxStepIndex: 10,
          isFinished: true,
          engaged: true,
          plannerContents: ['All work completed.'],
          tailKind: 'assistant-text',
          activeBackgroundTasks: [],
        }),
      );

      // Hub returns authoritative: false
      vi.spyOn(svc, 'getStructuredCascadeTasks').mockResolvedValue({
        authoritative: false,
        activeTasks: [],
        allTasks: [],
        hasActiveChildren: false,
        isCascadeActive: false,
      });

      const cid = 'cid-circuit-breaker-test';
      (svc as any).runs.set(cid, {
        cascadeId: cid,
        status: 'running',
        startedAt: Date.now() - 30_000,
        baselineStepIndex: -1,
        turnSeq: 1,
        priorContents: [],
      });

      svc.ensureActiveWatcher(cid, undefined, -1);

      // Advance 30 seconds
      await vi.advanceTimersByTimeAsync(30_000);

      const run = runOf(svc, cid);
      expect(run.status).toBe('running');
      expect(notifySpy).not.toHaveBeenCalled();
    });

    describe('6. Stale SUBAGENT_STATE_ALIVE vs Real Active Child Settlement Regression', () => {
      let tempBrainDir: string;

      beforeEach(() => {
        tempBrainDir = mkdtempSync(join(tmpdir(), 'agy-subagent-test-'));
      });

      afterEach(() => {
        if (tempBrainDir) {
          rmSync(tempBrainDir, { recursive: true, force: true });
        }
      });

      it('authoritative inactive + stale SUBAGENT_STATE_ALIVE file does not stick in waiting-background; read-only classify does not latch done and watcher notifies done once', async () => {
        const { svc, sendMessage } = makeService();
        const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

        const cid = 'cid-stale-subagent-alive';
        const childId = 'child-stale-001';
        const subagentsDir = join(tempBrainDir, cid, '.system_generated', 'subagents');
        mkdirSync(subagentsDir, { recursive: true });
        writeFileSync(
          join(subagentsDir, `${childId}.json`),
          JSON.stringify({
            conversationId: childId,
            state: 'SUBAGENT_STATE_ALIVE',
            role: 'Codebase Researcher',
            spawnStepIndex: 3,
          }),
          'utf8',
        );

        // Child transcript on disk is already terminally finished
        const childLogsDir = join(tempBrainDir, childId, '.system_generated', 'logs');
        mkdirSync(childLogsDir, { recursive: true });
        writeFileSync(
          join(childLogsDir, 'transcript.jsonl'),
          [
            JSON.stringify({
              step_index: 0,
              type: 'USER_INPUT',
              status: 'DONE',
              content: 'Investigate helper functions',
              created_at: new Date(Date.now() - 60_000).toISOString(),
            }),
            JSON.stringify({
              step_index: 5,
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              content: 'Here is the complete research summary.',
              created_at: new Date(Date.now() - 40_000).toISOString(),
            }),
          ].join('\n') + '\n',
          'utf8',
        );

        // Authoritative Hub query reports parent inactive and no active children
        (svc as any).getHubClient = async () => ({
          sendMessage,
          getCascadeTasks: async () => ({
            activeTasks: [],
            allTasks: [],
            hasActiveChildren: false,
            isCascadeActive: false,
            authoritative: true,
          }),
        });

        mockRead.mockResolvedValue(
          snap({
            maxStepIndex: 12,
            isFinished: true,
            engaged: true,
            plannerContents: ['Final report after child completed.'],
            tailKind: 'assistant-text',
            activeBackgroundTasks: [],
            lastActiveAt: new Date(Date.now() - 25_000).toISOString(),
          }),
        );

        (svc as any).runs.set(cid, {
          cascadeId: cid,
          brainDir: tempBrainDir,
          status: 'running',
          startedAt: Date.now() - 35_000,
          baselineStepIndex: -1,
          turnSeq: 1,
          priorContents: [],
        });

        // 1. Direct structured tasks check: stale ALIVE file must not flip hasActiveChildren to true
        const taskRes = await svc.getStructuredCascadeTasks(cid, tempBrainDir, 12, true);
        expect(taskRes.authoritative).toBe(true);
        expect(taskRes.hasActiveChildren).toBe(false);

        // 2. Read-only classifySnapshot must classify as 'done' (NOT 'waiting-background')
        //    and must NOT latch run.status = 'done' before watcher settles
        const classified = await (svc as any).classifySnapshot(tempBrainDir, cid, -1);
        expect(classified.status).toBe('done');
        expect(runOf(svc, cid).status).toBe('running');
        expect(notifySpy).not.toHaveBeenCalled();

        // 3. Watcher runs, enters done, and announces settlement exactly once
        svc.ensureActiveWatcher(cid, undefined, -1);
        await vi.advanceTimersByTimeAsync(30_000);

        const run = runOf(svc, cid);
        expect(run.status).toBe('done');
        expect(notifySpy).toHaveBeenCalledTimes(1);
      });

      it('active flag unpublished or state conflict (SUBAGENT_STATE_ALIVE without terminal child evidence yet) conservatively waits in waiting-background until child terminal evidence lands', async () => {
        const { svc, sendMessage } = makeService();
        const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

        const cid = 'cid-conflict-subagent';
        const childId = 'child-unpublished-002';
        const subagentsDir = join(tempBrainDir, cid, '.system_generated', 'subagents');
        mkdirSync(subagentsDir, { recursive: true });
        writeFileSync(
          join(subagentsDir, `${childId}.json`),
          JSON.stringify({
            conversationId: childId,
            state: 'SUBAGENT_STATE_ALIVE',
            spawnStepIndex: 2,
          }),
          'utf8',
        );

        // Hub reports authoritative inactive (e.g. INVOKE_SUBAGENT step is DONE in parent trajectory
        // and child active flag is unpublished), and child has no terminal transcript/SQLite/return yet.
        (svc as any).getHubClient = async () => ({
          sendMessage,
          getCascadeTasks: async () => ({
            activeTasks: [],
            allTasks: [],
            hasActiveChildren: false,
            isCascadeActive: false,
            authoritative: true,
          }),
        });

        mockRead.mockResolvedValue(
          snap({
            maxStepIndex: 9,
            isFinished: true,
            engaged: true,
            plannerContents: ['Waiting on subagent...'],
            tailKind: 'assistant-text',
            activeBackgroundTasks: [],
            lastActiveAt: new Date(Date.now() - 25_000).toISOString(),
          }),
        );

        (svc as any).runs.set(cid, {
          cascadeId: cid,
          brainDir: tempBrainDir,
          status: 'running',
          startedAt: Date.now() - 35_000,
          baselineStepIndex: -1,
          turnSeq: 1,
          priorContents: [],
        });

        // 1. State conflict / unpublished active flag MUST conservatively wait (never done/notify)
        const taskResConflict = await svc.getStructuredCascadeTasks(cid, tempBrainDir, 9, true);
        expect(taskResConflict.hasActiveChildren).toBe(true);

        const classifiedConflict = await (svc as any).classifySnapshot(tempBrainDir, cid, -1);
        expect(classifiedConflict.status).toBe('waiting-background');

        svc.ensureActiveWatcher(cid, undefined, -1);
        await vi.advanceTimersByTimeAsync(35_000);

        expect(runOf(svc, cid).status).toBe('waiting-background');
        expect(notifySpy).not.toHaveBeenCalled();

        // 2. Now verifiable child return SYSTEM_MESSAGE lands in parent transcript on disk
        //    (even though SUBAGENT_STATE_ALIVE file remains stale)
        const parentLogsDir = join(tempBrainDir, cid, '.system_generated', 'logs');
        mkdirSync(parentLogsDir, { recursive: true });
        writeFileSync(
          join(parentLogsDir, 'transcript.jsonl'),
          [
            JSON.stringify({
              step_index: 0,
              type: 'USER_INPUT',
              status: 'DONE',
              content: 'Run subagent',
            }),
            JSON.stringify({
              step_index: 10,
              type: 'SYSTEM_MESSAGE',
              status: 'DONE',
              content: `[Message] timestamp=2026-11-05T14:21:14Z sender=${childId} priority=MESSAGE_PRIORITY_HIGH content=Subagent completed`,
            }),
            JSON.stringify({
              step_index: 11,
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              content: 'Final report after child returned.',
            }),
          ].join('\n') + '\n',
          'utf8',
        );

        mockRead.mockResolvedValue(
          snap({
            maxStepIndex: 11,
            isFinished: true,
            engaged: true,
            plannerContents: ['Waiting on subagent...', 'Final report after child returned.'],
            tailKind: 'assistant-text',
            activeBackgroundTasks: [],
            lastActiveAt: new Date(Date.now() - 20_000).toISOString(),
          }),
        );

        await vi.advanceTimersByTimeAsync(35_000);

        expect(runOf(svc, cid).status).toBe('done');
        expect(notifySpy).toHaveBeenCalledTimes(1);
      });

      it('9cde45d9 counter-example: INVOKE_SUBAGENT before assistant-text tail ("等待只读子代理") never settles via ordinary assistant-text while child is running or unreturned', async () => {
        const { svc, sendMessage } = makeService();
        const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

        const cid = '9cde45d9-8d32-4f10-853f-88ca518e3bbc';
        const childId = '54d0c460-5533-4803-84d3-7cbb054f6acf';
        const parentLogsDir = join(tempBrainDir, cid, '.system_generated', 'logs');
        mkdirSync(parentLogsDir, { recursive: true });
        const parentTranscriptPath = join(parentLogsDir, 'transcript.jsonl');

        const initialParentLines = [
          JSON.stringify({
            step_index: 0,
            type: 'USER_INPUT',
            status: 'DONE',
            content: 'Fix DSH Antigravity completion notification',
            created_at: new Date(Date.now() - 100_000).toISOString(),
          }),
          JSON.stringify({
            step_index: 9,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            content: '',
            tool_calls: [
              {
                name: 'invoke_subagent',
                args: {
                  Subagents: [{ TypeName: 'research', Role: 'Codebase Researcher' }],
                },
              },
            ],
            created_at: new Date(Date.now() - 95_000).toISOString(),
          }),
          JSON.stringify({
            step_index: 10,
            type: 'GENERIC',
            status: 'DONE',
            content: `Created the following subagents:\n{\n  "conversationId": "${childId}",\n  "type": "research",\n  "role": "Codebase Researcher"\n}`,
            created_at: new Date(Date.now() - 94_000).toISOString(),
          }),
          JSON.stringify({
            step_index: 11,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            content: '正在等待只读子代理汇总两个仓库的完整上下文与测试辅助结构，收到返回后立即按顺序执行修复。',
            created_at: new Date(Date.now() - 90_000).toISOString(),
          }),
        ];
        writeFileSync(parentTranscriptPath, initialParentLines.join('\n') + '\n', 'utf8');

        // 1. Verify parseTranscript detects the unreturned subagent from INVOKE_SUBAGENT + Created the following subagents
        const parsedWaiting = parseTranscript(initialParentLines, -1, cid);
        expect(parsedWaiting.tailKind).toBe('assistant-text');
        expect(parsedWaiting.isFinished).toBe(true);
        expect(parsedWaiting.hasActiveChildren).toBe(true);
        expect(parsedWaiting.activeSubagentIds).toEqual([childId]);

        // 2. Even when Hub getCascadeTasks reports authoritative:true, hasActiveChildren:false
        //    (because INVOKE_SUBAGENT step 10 is DONE), parent MUST stay waiting-background
        //    and NEVER emit premature done at ~96s!
        (svc as any).getHubClient = async () => ({
          sendMessage,
          getCascadeTasks: async () => ({
            activeTasks: [],
            allTasks: [],
            hasActiveChildren: false,
            isCascadeActive: false,
            authoritative: true,
          }),
        });

        mockRead.mockResolvedValue(
          snap({
            maxStepIndex: 11,
            isFinished: parsedWaiting.isFinished,
            engaged: parsedWaiting.engagedAfterInput,
            plannerContents: parsedWaiting.plannerContents,
            tailKind: parsedWaiting.tailKind,
            activeBackgroundTasks: [],
            hasActiveChildren: parsedWaiting.hasActiveChildren,
            activeSubagentIds: parsedWaiting.activeSubagentIds,
            lastActiveAt: parsedWaiting.lastActiveAt,
          }),
        );

        (svc as any).runs.set(cid, {
          cascadeId: cid,
          brainDir: tempBrainDir,
          status: 'running',
          startedAt: Date.now() - 100_000,
          baselineStepIndex: -1,
          turnSeq: 1,
          priorContents: [],
        });

        const classifiedAt96s = await (svc as any).classifySnapshot(tempBrainDir, cid, -1);
        expect(classifiedAt96s.status).toBe('waiting-background');

        svc.ensureActiveWatcher(cid, undefined, -1);
        await vi.advanceTimersByTimeAsync(100_000);

        expect(runOf(svc, cid).status).toBe('waiting-background');
        expect(notifySpy).not.toHaveBeenCalled();

        // 3. Subagent returns SYSTEM_MESSAGE (step 36) and parent completes final report (step 37)
        const completedParentLines = [
          ...initialParentLines,
          JSON.stringify({
            step_index: 36,
            type: 'SYSTEM_MESSAGE',
            status: 'DONE',
            content: `[Message] timestamp=2026-11-05T14:21:14Z sender=${childId} priority=MESSAGE_PRIORITY_HIGH content=Subagent research finished`,
            created_at: new Date(Date.now() - 25_000).toISOString(),
          }),
          JSON.stringify({
            step_index: 37,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            content: '两个仓库修复与回归测试已全部完成。',
            created_at: new Date(Date.now() - 20_000).toISOString(),
          }),
        ];
        writeFileSync(parentTranscriptPath, completedParentLines.join('\n') + '\n', 'utf8');

        const parsedDone = parseTranscript(completedParentLines, -1, cid);
        expect(parsedDone.hasActiveChildren).toBeFalsy();

        mockRead.mockResolvedValue(
          snap({
            maxStepIndex: 37,
            isFinished: parsedDone.isFinished,
            engaged: parsedDone.engagedAfterInput,
            plannerContents: parsedDone.plannerContents,
            tailKind: parsedDone.tailKind,
            activeBackgroundTasks: [],
            hasActiveChildren: parsedDone.hasActiveChildren,
            activeSubagentIds: parsedDone.activeSubagentIds,
            lastActiveAt: parsedDone.lastActiveAt,
          }),
        );

        await vi.advanceTimersByTimeAsync(35_000);

        expect(runOf(svc, cid).status).toBe('done');
        expect(notifySpy).toHaveBeenCalledTimes(1);
      });

      it('real active child transcript on disk blocks settlement (waiting-background, no premature done) until child finishes', async () => {
        const { svc, sendMessage } = makeService();
        const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

        const cid = 'cid-real-active-child';
        const childId = 'child-active-003';
        const subagentsDir = join(tempBrainDir, cid, '.system_generated', 'subagents');
        mkdirSync(subagentsDir, { recursive: true });
        writeFileSync(
          join(subagentsDir, `${childId}.json`),
          JSON.stringify({
            conversationId: childId,
            state: 'SUBAGENT_STATE_ALIVE',
            spawnStepIndex: 2,
          }),
          'utf8',
        );

        // Child transcript is currently mid-turn (tool-call tail, not finished)
        const childLogsDir = join(tempBrainDir, childId, '.system_generated', 'logs');
        mkdirSync(childLogsDir, { recursive: true });
        const childTranscriptPath = join(childLogsDir, 'transcript.jsonl');
        writeFileSync(
          childTranscriptPath,
          [
            JSON.stringify({
              step_index: 0,
              type: 'USER_INPUT',
              status: 'DONE',
              content: 'Read files in repo',
              created_at: new Date(Date.now() - 20_000).toISOString(),
            }),
            JSON.stringify({
              step_index: 1,
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              content: '',
              tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/tmp/a.ts' } }],
              created_at: new Date(Date.now() - 10_000).toISOString(),
            }),
          ].join('\n') + '\n',
          'utf8',
        );

        // Even though parent's INVOKE_SUBAGENT step is DONE in Hub (so Hub reports hasActiveChildren: false),
        // the real active child transcript on disk MUST block premature done settlement!
        (svc as any).getHubClient = async () => ({
          sendMessage,
          getCascadeTasks: async () => ({
            activeTasks: [],
            allTasks: [],
            hasActiveChildren: false,
            isCascadeActive: false,
            authoritative: true,
          }),
        });

        mockRead.mockResolvedValue(
          snap({
            maxStepIndex: 4,
            isFinished: true,
            engaged: true,
            plannerContents: ['Waiting for read-only subagent...'],
            tailKind: 'assistant-text',
            activeBackgroundTasks: [],
            lastActiveAt: new Date(Date.now() - 25_000).toISOString(),
          }),
        );

        (svc as any).runs.set(cid, {
          cascadeId: cid,
          brainDir: tempBrainDir,
          status: 'running',
          startedAt: Date.now() - 35_000,
          baselineStepIndex: -1,
          turnSeq: 1,
          priorContents: [],
        });

        const classifiedWhileActive = await (svc as any).classifySnapshot(tempBrainDir, cid, -1);
        expect(classifiedWhileActive.status).toBe('waiting-background');

        svc.ensureActiveWatcher(cid, undefined, -1);
        await vi.advanceTimersByTimeAsync(35_000);

        const run = runOf(svc, cid);
        expect(run.status).toBe('waiting-background');
        expect(notifySpy).not.toHaveBeenCalled();

        // Now the child subagent finishes its turn and parent outputs final report
        writeFileSync(
          childTranscriptPath,
          [
            JSON.stringify({
              step_index: 0,
              type: 'USER_INPUT',
              status: 'DONE',
              content: 'Read files in repo',
              created_at: new Date(Date.now() - 50_000).toISOString(),
            }),
            JSON.stringify({
              step_index: 1,
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              content: '',
              tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/tmp/a.ts' } }],
              created_at: new Date(Date.now() - 40_000).toISOString(),
            }),
            JSON.stringify({
              step_index: 2,
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              content: 'Subagent finished reading all files.',
              created_at: new Date(Date.now() - 5_000).toISOString(),
            }),
          ].join('\n') + '\n',
          'utf8',
        );

        mockRead.mockResolvedValue(
          snap({
            maxStepIndex: 7,
            isFinished: true,
            engaged: true,
            plannerContents: ['Waiting for read-only subagent...', 'All tasks complete.'],
            tailKind: 'assistant-text',
            activeBackgroundTasks: [],
            lastActiveAt: new Date(Date.now() - 20_000).toISOString(),
          }),
        );

        await vi.advanceTimersByTimeAsync(35_000);

        expect(run.status).toBe('done');
        expect(notifySpy).toHaveBeenCalledTimes(1);
      });

      it('authoritative active child (hasActiveChildren: true) keeps run in waiting-background without settling', async () => {
        const { svc, sendMessage } = makeService();
        const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

        const cid = 'cid-auth-active-child';
        const childId = 'child-auth-active-004';
        const subagentsDir = join(tempBrainDir, cid, '.system_generated', 'subagents');
        mkdirSync(subagentsDir, { recursive: true });
        writeFileSync(
          join(subagentsDir, `${childId}.json`),
          JSON.stringify({
            conversationId: childId,
            state: 'SUBAGENT_STATE_ALIVE',
          }),
          'utf8',
        );

        (svc as any).getHubClient = async () => ({
          sendMessage,
          getCascadeTasks: async () => ({
            activeTasks: [],
            allTasks: [],
            hasActiveChildren: true,
            isCascadeActive: false,
            authoritative: true,
          }),
        });

        mockRead.mockResolvedValue(
          snap({
            maxStepIndex: 6,
            isFinished: true,
            engaged: true,
            plannerContents: ['Subagent still running according to Hub.'],
            tailKind: 'assistant-text',
            activeBackgroundTasks: [],
            lastActiveAt: new Date(Date.now() - 25_000).toISOString(),
          }),
        );

        (svc as any).runs.set(cid, {
          cascadeId: cid,
          brainDir: tempBrainDir,
          status: 'running',
          startedAt: Date.now() - 35_000,
          baselineStepIndex: -1,
          turnSeq: 1,
          priorContents: [],
        });

        svc.ensureActiveWatcher(cid, undefined, -1);
        await vi.advanceTimersByTimeAsync(35_000);

        expect(runOf(svc, cid).status).toBe('waiting-background');
        expect(notifySpy).not.toHaveBeenCalled();
      });

      it('T2: CANCELED step or output.txt context canceled + live child + waiting narration MUST NOT settle or latch done', async () => {
        const { svc, sendMessage } = makeService();
        const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

        const cid = 'cid-t2-canceled-step-live-child';
        const childId = 'child-t2-live';
        const subagentsDir = join(tempBrainDir, cid, '.system_generated', 'subagents');
        mkdirSync(subagentsDir, { recursive: true });
        writeFileSync(
          join(subagentsDir, `${childId}.json`),
          JSON.stringify({
            conversationId: childId,
            state: 'SUBAGENT_STATE_ALIVE',
            spawnStepIndex: 10,
          }),
          'utf8',
        );

        // Step 5 output had "context canceled" earlier in the turn
        const step5Dir = join(tempBrainDir, cid, '.system_generated', 'steps', '5');
        mkdirSync(step5Dir, { recursive: true });
        writeFileSync(join(step5Dir, 'output.txt'), 'Error: context canceled\n', 'utf8');

        // Child subagent is actively running on disk
        const childLogsDir = join(tempBrainDir, childId, '.system_generated', 'logs');
        mkdirSync(childLogsDir, { recursive: true });
        writeFileSync(
          join(childLogsDir, 'transcript.jsonl'),
          [
            JSON.stringify({
              step_index: 0,
              type: 'USER_INPUT',
              status: 'DONE',
              content: 'Inspect test helpers',
              created_at: new Date(Date.now() - 10_000).toISOString(),
            }),
          ].join('\n') + '\n',
          'utf8',
        );

        (svc as any).getHubClient = async () => ({
          sendMessage,
          getCascadeTasks: async () => ({
            activeTasks: [],
            allTasks: [],
            hasActiveChildren: false,
            isCascadeActive: false,
            hasCanceledStep: true,
            isCanceled: true,
            authoritative: true,
          }),
        });

        mockRead.mockResolvedValue(
          snap({
            maxStepIndex: 12,
            isFinished: true,
            engaged: true,
            hasCanceledStep: true,
            plannerContents: ['等待只读子代理返回中...'],
            tailKind: 'assistant-text',
            activeBackgroundTasks: [],
            lastActiveAt: new Date(Date.now() - 25_000).toISOString(),
          }),
        );

        (svc as any).runs.set(cid, {
          cascadeId: cid,
          brainDir: tempBrainDir,
          status: 'running',
          startedAt: Date.now() - 35_000,
          baselineStepIndex: -1,
          turnSeq: 1,
          priorContents: [],
        });

        // Read-only classify must return waiting-background, never done
        const classified = await (svc as any).classifySnapshot(tempBrainDir, cid, -1);
        expect(classified.status).toBe('waiting-background');

        svc.ensureActiveWatcher(cid, undefined, -1);
        await vi.advanceTimersByTimeAsync(35_000);

        const run = runOf(svc, cid);
        expect(run.status).toBe('waiting-background');
        expect(notifySpy).not.toHaveBeenCalled();
      });

      it('T4: child-only waiting (empty activeTasks) emits waiting warning after 5m and emits timeout notice at watchMaxMs deadline', async () => {
        const { svc, sendMessage } = makeService({ watchMaxMs: 360_000 });
        const deliverSpy = vi.spyOn(svc, 'deliverMessageToAgent' as any).mockReturnValue(true);
        const notifySpy = vi.spyOn(svc, 'notifySettlementToDsh');

        const cid = 'cid-t4-child-only-wait';
        (svc as any).getHubClient = async () => ({
          sendMessage,
          getCascadeTasks: async () => ({
            activeTasks: [],
            allTasks: [],
            hasActiveChildren: true,
            isCascadeActive: false,
            authoritative: true,
          }),
        });

        mockRead.mockResolvedValue(
          snap({
            maxStepIndex: 8,
            isFinished: true,
            engaged: true,
            plannerContents: ['Waiting on child subagent...'],
            tailKind: 'assistant-text',
            activeBackgroundTasks: [],
            lastActiveAt: new Date(Date.now() - 25_000).toISOString(),
          }),
        );

        (svc as any).runs.set(cid, {
          cascadeId: cid,
          brainDir: tempBrainDir,
          status: 'running',
          startedAt: Date.now() - 35_000,
          baselineStepIndex: -1,
          turnSeq: 1,
          priorContents: [],
          callerAgentId: 'agent-main',
        });

        svc.ensureActiveWatcher(cid, undefined, -1);

        // Advance 310s (> 5m episode threshold): child-only waiting warning MUST be emitted!
        await vi.advanceTimersByTimeAsync(310_000);
        expect(runOf(svc, cid).status).toBe('waiting-background');
        expect(deliverSpy).toHaveBeenCalled();
        const warnMsg = deliverSpy.mock.calls[0][1] as any;
        expect(warnMsg.content[0].text).toContain('subagent');

        // Advance past watchMaxMs (360s): waiting-background MUST transition to timeout and notify!
        await vi.advanceTimersByTimeAsync(60_000);
        expect(runOf(svc, cid).status).toBe('timeout');
        expect(notifySpy).toHaveBeenCalledTimes(1);
      });

      it('T5: orphan waiting/running run with empty callerAgentId does not block other agents in hasActiveRuns/getActiveRuns', () => {
        const { svc } = makeService();

        (svc as any).runs.set('cid-orphan-subagent', {
          cascadeId: 'cid-orphan-subagent',
          status: 'running',
          startedAt: Date.now() - 60_000,
          turnSeq: 1,
          priorContents: [],
          // callerAgentId is undefined (orphan subagent run)
        });

        (svc as any).runs.set('cid-owned-by-alpha', {
          cascadeId: 'cid-owned-by-alpha',
          status: 'waiting-background',
          callerAgentId: 'agent-alpha',
          startedAt: Date.now() - 60_000,
          turnSeq: 1,
          priorContents: [],
        });

        // Orphan run must NOT make hasActiveRuns('agent-beta') true
        expect(svc.hasActiveRuns('agent-beta')).toBe(false);
        expect(svc.getActiveRuns('agent-beta')).toHaveLength(0);

        // Agent alpha still sees its own active run
        expect(svc.hasActiveRuns('agent-alpha')).toBe(true);
        expect(svc.getActiveRuns('agent-alpha')).toHaveLength(1);

        // Unfiltered hasActiveRuns() still sees active runs globally
        expect(svc.hasActiveRuns()).toBe(true);
      });

      it('T7: false done followed by real done in same turn is not swallowed by transitionKey, and non-done status never renders Completed Successfully', () => {
        const { svc } = makeService();
        const deliverSpy = vi.spyOn(svc, 'deliverMessageToAgent' as any).mockReturnValue(true);

        // 1. buildSettlementNotice on running / waiting-background must never say Completed Successfully
        const runningNotice = buildSettlementNotice({
          cascadeId: 'cid-t7-notice-check',
          status: 'running',
          startedAt: Date.now() - 30_000,
          content: '等待只读子代理',
          turnSeq: 1,
          priorContents: [],
        });
        expect(runningNotice.summary).not.toContain('✅');
        expect(runningNotice.summary).not.toContain('Completed Successfully');
        expect(runningNotice.noticeText).not.toContain('Completed Successfully');

        const waitingNotice = buildSettlementNotice({
          cascadeId: 'cid-t7-notice-check',
          status: 'waiting-background',
          startedAt: Date.now() - 30_000,
          content: '等待只读子代理',
          turnSeq: 1,
          priorContents: [],
        });
        expect(waitingNotice.summary).not.toContain('✅');
        expect(waitingNotice.noticeText).not.toContain('Completed Successfully');

        // 2. Suppose an earlier false done was recorded in turn 1 at step 23 with interim text
        const run: HubRun = {
          cascadeId: 'cid-t7-idempotency',
          status: 'done',
          startedAt: Date.now() - 60_000,
          settledStepIndex: 23,
          content: '等待只读子代理...',
          turnSeq: 1,
          priorContents: [],
          callerAgentId: 'agent-main',
        };
        svc.notifySettlementToDsh(run);
        expect(deliverSpy).toHaveBeenCalledTimes(1);

        // Duplicate notification of the exact same state is still idempotent
        svc.notifySettlementToDsh(run);
        expect(deliverSpy).toHaveBeenCalledTimes(1);

        // True done later in the same turn (step 45 or updated final content) MUST NOT be swallowed!
        run.settledStepIndex = 45;
        run.content = '最终完整报告：A 与 B 均已修复通过。';
        svc.notifySettlementToDsh(run);
        expect(deliverSpy).toHaveBeenCalledTimes(2);
      });
    });
  });
});


