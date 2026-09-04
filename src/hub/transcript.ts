import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TranscriptStep {
  step_index: number;
  source: string;
  type: string;
  status: string;
  content?: string;
  created_at?: string;
  tool_calls?: Array<{
    name: string;
    args?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
}

export interface PendingToolApproval {
  name: string;
  args?: Record<string, unknown>;
  action?: string;
  summary?: string;
  requestedAt?: string;
}

export interface PollResult {
  done: boolean;
  content: string;
  status?: 'done' | 'awaiting-approval' | 'running' | 'timeout' | 'error';
  pendingTool?: PendingToolApproval;
  lastActiveAt?: string;
  error?: string;
}

/**
 * Classification of the LAST valid entry inside the current turn window.
 * Drives the tail guard that distinguishes a genuinely finished turn from a
 * model that merely paused mid-work (e.g. launched a background task and is
 * waiting on it).
 */
export type TranscriptTailKind =
  | 'none'           // no steps in the turn window yet
  | 'assistant-text' // PLANNER_RESPONSE without tool calls (the model's text reply)
  | 'tool-call'      // PLANNER_RESPONSE carrying tool_calls
  | 'tool-result'    // executor step (tool execution / result materialized)
  | 'checkpoint'     // CHECKPOINT
  | 'other';         // USER_INPUT / SYSTEM_MESSAGE / ERROR_MESSAGE / unknown

export interface TranscriptSnapshot {
  maxStepIndex: number;
  engaged: boolean;
  plannerContents: string[];
  lastActiveAt?: string;
  pendingApproval?: PendingToolApproval;
  isFinished?: boolean;
  error?: string;
  /** Kind of the last valid entry in the turn window (settlement tail guard). */
  tailKind: TranscriptTailKind;
}

interface ParsedTranscript {
  maxStepIndex: number;
  /** step_index of the latest completed USER_INPUT (our prompt). */
  userInputIndex: number;
  /** PLANNER_RESPONSE contents after userInputIndex, in order. */
  plannerContents: string[];
  /** Any MODEL step exists after userInputIndex (agent engaged). */
  engagedAfterInput: boolean;
  /** CHECKPOINT seen after userInputIndex. */
  checkpointAfterInput: boolean;
  /** Latest timestamp seen in the transcript. */
  lastActiveAt?: string;
  /** If the cascade is currently suspended on a pending tool call awaiting approval/completion. */
  pendingApproval?: PendingToolApproval;
  /** Whether the trajectory reached a definitive finished state (e.g. final text reply or checkpoint). */
  isFinished: boolean;
  /** Kind of the last valid entry in the turn window. */
  tailKind: TranscriptTailKind;
  /** short_error from the first ERROR_MESSAGE step, if any. */
  error?: string;
}

function classifyTranscriptStep(step: TranscriptStep): TranscriptTailKind {
  if (step.type === 'PLANNER_RESPONSE') {
    return Array.isArray(step.tool_calls) && step.tool_calls.length > 0 ? 'tool-call' : 'assistant-text';
  }
  if (step.type === 'CHECKPOINT') return 'checkpoint';
  if (step.type === 'USER_INPUT' || step.type === 'SYSTEM_MESSAGE' || step.type === 'ERROR_MESSAGE') {
    return 'other';
  }
  return 'tool-result';
}

export function parseTranscript(lines: string[], baselineStepIndex = -1): ParsedTranscript {
  const parsedSteps: TranscriptStep[] = [];
  let fileMaxStepIndex = -1;
  let latestGlobalUserInputIndex = -1;

  for (const line of lines) {
    let step: TranscriptStep;
    try {
      step = JSON.parse(line);
      parsedSteps.push(step);
      if (typeof step.step_index === 'number') {
        fileMaxStepIndex = Math.max(fileMaxStepIndex, step.step_index);
        if (step.type === 'USER_INPUT' && step.status === 'DONE') {
          latestGlobalUserInputIndex = Math.max(latestGlobalUserInputIndex, step.step_index);
        }
      }
    } catch {
      continue; // tolerate a torn trailing line from a concurrent writer
    }
  }

  const result: ParsedTranscript = {
    maxStepIndex: fileMaxStepIndex,
    userInputIndex: -1,
    plannerContents: [],
    engagedAfterInput: false,
    checkpointAfterInput: false,
    isFinished: false,
    tailKind: 'none',
  };

  // If a baseline is provided, only inspect steps generated AFTER the baseline step index
  if (baselineStepIndex >= 0) {
    const postBaselineSteps = parsedSteps.filter((s) => s.step_index > baselineStepIndex);
    if (postBaselineSteps.length === 0) {
      // Nothing has been written yet for this new turn; stay purely pending/running
      return result;
    }

    // Find the new USER_INPUT step in this turn if materialized
    for (const step of postBaselineSteps) {
      if (step.type === 'USER_INPUT' && step.status === 'DONE') {
        result.userInputIndex = Math.max(result.userInputIndex, step.step_index);
      }
    }
  } else {
    result.userInputIndex = latestGlobalUserInputIndex;
  }

  // Pending tool calls emitted by a PLANNER_RESPONSE that have not yet been completed
  let pendingTools: Array<{
    name: string;
    args?: Record<string, unknown>;
    action?: string;
    summary?: string;
    requestedAt?: string;
  }> = [];

  const cutIndex = result.userInputIndex >= 0 ? result.userInputIndex : baselineStepIndex;
  const relevantSteps = parsedSteps.filter((s) => s.step_index > cutIndex);

  for (const step of relevantSteps) {
    // Track the tail BEFORE anything else: the guard wants the classification of
    // the very last valid entry, even when this iteration takes an early return.
    result.tailKind = classifyTranscriptStep(step);

    if (step.created_at) {
      result.lastActiveAt = step.created_at;
    }

    if (step.type === 'ERROR_MESSAGE') {
      const errObj = step.error_message as
        | {
            error?: {
              short_error?: string;
              user_error_message?: string;
              code?: number | string;
              status?: string;
              message?: string;
            };
          }
        | undefined;
      const code = errObj?.error?.code;
      const status = errObj?.error?.status;
      const msg = errObj?.error?.message;
      const httpSummary = code && status ? `HTTP ${code} ${status}: ${msg || ''}`.trim() : undefined;

      // Keep a raw snippet in the fallback: an opaque "unknown agent error" hides
      // diagnostic fields this parser has not mapped yet.
      result.error =
        errObj?.error?.short_error ??
        errObj?.error?.user_error_message ??
        httpSummary ??
        (typeof step.content === 'string' && step.content ? step.content : undefined) ??
        `unknown agent error (raw: ${JSON.stringify(step).slice(0, 300)})`;
      return result;
    }

    if (step.source === 'MODEL') {
      result.engagedAfterInput = true;
    }

    if (step.type === 'PLANNER_RESPONSE') {
      if (step.status === 'ERROR') {
        result.error =
          step.content ||
          (step as any).error ||
          `Planner error at step ${step.step_index}`;
        return result;
      }

      if (step.content && step.status === 'DONE') {
        result.plannerContents.push(step.content);
      }

      if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        // Planner requested tool calls
        pendingTools = step.tool_calls.map((tc) => {
          const rawArgs = tc.args ?? {};
          // Args might have JSON strings or raw objects depending on serializer
          let argsObj: Record<string, unknown> = {};
          if (typeof rawArgs === 'string') {
            try {
              argsObj = JSON.parse(rawArgs);
            } catch {
              argsObj = { raw: rawArgs };
            }
          } else if (typeof rawArgs === 'object' && rawArgs !== null) {
            argsObj = { ...rawArgs };
            // Unquote nested stringified JSON strings if any
            for (const [k, v] of Object.entries(argsObj)) {
              if (typeof v === 'string' && (v.startsWith('"') || v.startsWith('{') || v.startsWith('['))) {
                try {
                  argsObj[k] = JSON.parse(v);
                } catch {}
              }
            }
          }

          const action = typeof argsObj.toolAction === 'string' ? argsObj.toolAction : undefined;
          const summary = typeof argsObj.toolSummary === 'string' ? argsObj.toolSummary : undefined;

          return {
            name: tc.name,
            args: argsObj,
            action,
            summary,
            requestedAt: step.created_at,
          };
        });
        result.isFinished = false;
      } else if (step.status === 'DONE') {
        // Planner completed with final response and no tool calls
        pendingTools = [];
        result.isFinished = true;
      }
    } else if (step.type === 'CHECKPOINT' && step.status === 'DONE') {
      result.checkpointAfterInput = true;
      pendingTools = [];
      result.isFinished = true;
    } else if (
      step.type !== 'USER_INPUT' &&
      step.type !== 'SYSTEM_MESSAGE' &&
      step.type !== 'PLANNER_RESPONSE'
    ) {
      // Execution step for a tool (GENERIC, RUN_COMMAND, VIEW_FILE, etc.)
      if (step.status === 'DONE' || step.status === 'ERROR' || step.status === 'CANCELED') {
        if (pendingTools.length > 0) {
          pendingTools.shift();
        }
      } else if (step.status === 'WAITING' || step.status === 'RUNNING') {
        result.isFinished = false;
      }
    }
  }

  if (pendingTools.length > 0) {
    const p = pendingTools[0];
    result.pendingApproval = {
      name: p.name,
      args: p.args,
      action: p.action,
      summary: p.summary,
      requestedAt: p.requestedAt || result.lastActiveAt,
    };
    result.isFinished = false;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Settlement tail guard (early-stop misjudgment fix)
// ---------------------------------------------------------------------------

export type AutoContinueReason = 'tool-tail' | 'no-assistant-text';

export type SettleGuardAction = 'settle' | 'settle-exhausted' | 'continue' | 'wait';

export interface SettleGuardInput {
  snap: Pick<
    TranscriptSnapshot,
    'isFinished' | 'plannerContents' | 'tailKind' | 'engaged' | 'pendingApproval' | 'error'
  >;
  /** How long the transcript has produced no new steps (ms). */
  tailQuietMs: number;
  /** Auto-continue nudges already spent on the current turn. */
  autoContinueCount: number;
  /** Auto-continue nudge budget per turn. */
  maxAutoContinue: number;
  /** Required stillness before a clean final reply may settle (ms). */
  settleStableMs: number;
  /** Required stillness before a stalled turn may be nudged (ms). */
  autoContinueQuietMs: number;
}

export interface SettleGuardDecision {
  action: SettleGuardAction;
  reason?: AutoContinueReason;
}

/**
 * Decides whether a "finished-looking" cascade snapshot may settle as done, or
 * whether the transcript tail proves the model merely paused mid-work and the
 * bridge should nudge it with a "Continue" message instead.
 *
 * Guard conditions (checked at every done-settlement exit):
 * - (a) `tool-tail`: the LAST valid entry is a tool call or tool result with no
 *   assistant text after it. `isFinished` is then stale state left behind by an
 *   earlier final text or CHECKPOINT (executor DONE steps never reset it) — the
 *   classic false summary "I am waiting for the background test run to
 *   complete." that the transcript carries while the model is actually stalled.
 * - (b) `no-assistant-text`: the whole turn ended without ANY assistant text
 *   reply (e.g. the model launched a background task and yielded silently).
 *
 * Both conditions keep the run unsettled and trigger one capped auto-continue;
 * once the budget (`maxAutoContinue`) is spent the caller settles anyway and
 * flags `autoContinueExhausted` so callers can verify the outcome.
 */
export function decideTailSettle(input: SettleGuardInput): SettleGuardDecision {
  const { snap, tailQuietMs, autoContinueCount, maxAutoContinue, settleStableMs, autoContinueQuietMs } = input;
  const finished = snap.isFinished === true;
  const hasText = snap.plannerContents.length > 0;

  // Not at a settlement point: errors / pending approvals / live turns are
  // handled by their dedicated branches.
  if (!finished || snap.error || snap.pendingApproval) {
    return { action: 'wait' };
  }

  // (b) Turn ended without any assistant text reply.
  if (!hasText) {
    // A turn-setup CHECKPOINT (no model activity yet) is not a stall.
    if (!snap.engaged) return { action: 'wait' };
    if (tailQuietMs < autoContinueQuietMs) return { action: 'wait' };
    if (autoContinueCount < maxAutoContinue) return { action: 'continue', reason: 'no-assistant-text' };
    return { action: 'settle-exhausted', reason: 'no-assistant-text' };
  }

  // (a) Tool call / tool result tail: the model has not produced its closing
  // reply after the latest tool activity.
  if (snap.tailKind === 'tool-call' || snap.tailKind === 'tool-result') {
    if (tailQuietMs < autoContinueQuietMs) return { action: 'wait' };
    if (autoContinueCount < maxAutoContinue) return { action: 'continue', reason: 'tool-tail' };
    return { action: 'settle-exhausted', reason: 'tool-tail' };
  }

  // Genuine-looking final reply (assistant text / checkpoint tail): settle, but
  // only after the transcript has been still for a short window — late-landing
  // executor steps (background tasks writing their results) flip the tail to a
  // tool message and get caught by the guard above instead of settling first.
  if (tailQuietMs < settleStableMs) return { action: 'wait' };
  return { action: 'settle' };
}

export interface LoadedTranscript {
  path: string;
  text: string;
  mtimeMs: number;
}

/**
 * Loads the cascade transcript from disk, preferring the full fidelity transcript
 * (`transcript_full.jsonl`) over the compact/truncated view (`transcript.jsonl`).
 * Evaluated dynamically per read so callers cleanly handle files appearing at different times.
 */
export async function loadTranscriptFile(
  brainDir: string,
  cascadeId: string,
): Promise<LoadedTranscript | undefined> {
  const logDir = join(brainDir, cascadeId, '.system_generated', 'logs');
  const fullPath = join(logDir, 'transcript_full.jsonl');
  const compactPath = join(logDir, 'transcript.jsonl');

  try {
    const s = await stat(fullPath);
    const text = await readFile(fullPath, 'utf8');
    return { path: fullPath, text, mtimeMs: s.mtimeMs };
  } catch {
    try {
      const s = await stat(compactPath);
      const text = await readFile(compactPath, 'utf8');
      return { path: compactPath, text, mtimeMs: s.mtimeMs };
    } catch {
      return undefined;
    }
  }
}

/** One-shot read+parse of a cascade transcript; undefined when the file does not exist yet. */
export async function readCascadeTranscript(
  brainDir: string,
  cascadeId: string,
  baselineStepIndex = -1,
): Promise<TranscriptSnapshot | undefined> {
  const loaded = await loadTranscriptFile(brainDir, cascadeId);
  if (!loaded) {
    return undefined; // transcript not materialized yet
  }
  const lines = loaded.text.split('\n').filter((l) => l.trim());
  const parsed = parseTranscript(lines, baselineStepIndex);
  return {
    maxStepIndex: parsed.maxStepIndex,
    engaged: parsed.engagedAfterInput,
    plannerContents: parsed.plannerContents,
    lastActiveAt: parsed.lastActiveAt,
    pendingApproval: parsed.pendingApproval,
    isFinished: parsed.isFinished,
    error: parsed.error,
    tailKind: parsed.tailKind,
  };
}

/**
 * Polls a cascade's transcript until the planner answered (file stable
 * for `stableMs` or a CHECKPOINT follows the reply), an approval is needed,
 * an error step appears, or the timeout elapses.
 */
export async function pollTranscript(
  brainDir: string,
  cascadeId: string,
  timeoutMs = 300_000,
  pollIntervalMs = 1500,
  stableMs = 4000,
  baselineStepIndex = -1,
): Promise<PollResult> {
  const deadline = Date.now() + timeoutMs;
  let lastChange = Date.now();
  let lastFingerprint = '';
  let latestParsed: ParsedTranscript | undefined;

  while (Date.now() < deadline) {
    let lines: string[] | undefined;
    const loaded = await loadTranscriptFile(brainDir, cascadeId);
    if (loaded) {
      lines = loaded.text.split('\n').filter((l) => l.trim());
      const fingerprint = `${loaded.path}:${loaded.mtimeMs}:${lines.length}`;
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        lastChange = Date.now();
      }
    }

    if (lines) {
      latestParsed = parseTranscript(lines, baselineStepIndex);
      if (latestParsed.error) {
        return {
          done: true,
          status: 'error',
          content: latestParsed.plannerContents.join('\n\n'),
          error: latestParsed.error,
          lastActiveAt: latestParsed.lastActiveAt,
        };
      }
      if (latestParsed.pendingApproval) {
        return {
          done: false,
          status: 'awaiting-approval',
          content: latestParsed.plannerContents.join('\n\n'),
          pendingTool: latestParsed.pendingApproval,
          lastActiveAt: latestParsed.lastActiveAt,
        };
      }
      if (latestParsed.plannerContents.length > 0) {
        const stable = Date.now() - lastChange >= stableMs;
        // Tail guard parity: a tool call/result as the last valid entry is
        // mid-turn activity (stale isFinished), never a completed turn.
        const tailSettleable =
          latestParsed.tailKind !== 'tool-call' && latestParsed.tailKind !== 'tool-result';
        if (latestParsed.checkpointAfterInput || (latestParsed.isFinished && tailSettleable && stable)) {
          return {
            done: true,
            status: 'done',
            content: latestParsed.plannerContents.join('\n\n'),
            lastActiveAt: latestParsed.lastActiveAt,
          };
        }
      }
    }

    await sleep(pollIntervalMs);
  }

  if (latestParsed?.pendingApproval) {
    return {
      done: false,
      status: 'awaiting-approval',
      content: latestParsed.plannerContents.join('\n\n'),
      pendingTool: latestParsed.pendingApproval,
      lastActiveAt: latestParsed.lastActiveAt,
    };
  }

  return {
    done: false,
    status: latestParsed?.engagedAfterInput ? 'running' : 'timeout',
    content: latestParsed?.plannerContents.join('\n\n') ?? '',
    lastActiveAt: latestParsed?.lastActiveAt,
    error: 'poll timeout',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

