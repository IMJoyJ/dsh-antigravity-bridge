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

export interface TranscriptSnapshot {
  maxStepIndex: number;
  engaged: boolean;
  plannerContents: string[];
  lastActiveAt?: string;
  pendingApproval?: PendingToolApproval;
  isFinished?: boolean;
  error?: string;
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
  /** short_error from the first ERROR_MESSAGE step, if any. */
  error?: string;
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
    if (step.created_at) {
      result.lastActiveAt = step.created_at;
    }

    if (step.type === 'ERROR_MESSAGE') {
      const errObj = step.error_message as
        | { error?: { short_error?: string; user_error_message?: string } }
        | undefined;
      result.error =
        errObj?.error?.short_error ??
        errObj?.error?.user_error_message ??
        'unknown agent error';
      return result;
    }

    if (step.source === 'MODEL') {
      result.engagedAfterInput = true;
    }

    if (step.type === 'PLANNER_RESPONSE') {
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

/** One-shot read+parse of a cascade transcript; undefined when the file does not exist yet. */
export async function readCascadeTranscript(
  brainDir: string,
  cascadeId: string,
  baselineStepIndex = -1,
): Promise<TranscriptSnapshot | undefined> {
  const logPath = join(brainDir, cascadeId, '.system_generated', 'logs', 'transcript.jsonl');
  let text: string;
  try {
    text = await readFile(logPath, 'utf8');
  } catch {
    return undefined; // transcript not materialized yet
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const parsed = parseTranscript(lines, baselineStepIndex);
  return {
    maxStepIndex: parsed.maxStepIndex,
    engaged: parsed.engagedAfterInput,
    plannerContents: parsed.plannerContents,
    lastActiveAt: parsed.lastActiveAt,
    pendingApproval: parsed.pendingApproval,
    isFinished: parsed.isFinished,
    error: parsed.error,
  };
}

/**
 * Polls a cascade's transcript.jsonl until the planner answered (file stable
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
  const logPath = join(brainDir, cascadeId, '.system_generated', 'logs', 'transcript.jsonl');
  const deadline = Date.now() + timeoutMs;
  let lastChange = Date.now();
  let lastFingerprint = '';
  let latestParsed: ParsedTranscript | undefined;

  while (Date.now() < deadline) {
    let lines: string[] | undefined;
    try {
      const s = await stat(logPath);
      const text = await readFile(logPath, 'utf8');
      lines = text.split('\n').filter((l) => l.trim());
      const fingerprint = `${s.mtimeMs}:${lines.length}`;
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        lastChange = Date.now();
      }
    } catch {
      // transcript not materialized yet
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
        if (latestParsed.checkpointAfterInput || (latestParsed.isFinished && stable)) {
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

