import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export * from './trajectory.js';

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

export interface ActiveBackgroundTask {
  taskId: string;
  description?: string;
  startedAt?: string;
  startStepIndex: number;
  durationSeconds?: number;
  isSchedule?: boolean;
}

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
  /** Active (uncompleted) background tasks discovered in the transcript. */
  activeBackgroundTasks?: ActiveBackgroundTask[];
  /** 残余盲区①：whether subagent child sessions are currently active. */
  hasActiveChildren?: boolean;
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
  /** Active (uncompleted) background tasks discovered in the transcript. */
  activeBackgroundTasks: ActiveBackgroundTask[];
  /** 残余盲区①：whether subagent child sessions are currently active. */
  hasActiveChildren?: boolean;
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

/**
 * Pure observational tools that do not constitute substantive foreground work.
 * Invoking these tools does not imply that previous background tasks have finished.
 */
export const OBSERVATIONAL_TOOL_NAMES = new Set([
  'manage_task',
  'schedule',
  'view_file',
  'list_dir',
  'grep_search',
  'find_by_name',
  'read_url_content',
  'search_web',
  'read_resource',
  'list_resources',
]);

/**
 * R2 等待话术门:
 * Inspects whether the planner's final text output conveys waiting on a background task,
 * timer, or background execution without genuine completion semantics.
 */
export function isWaitingSpeech(text: string | undefined | null): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Inspect the trailing portion of the text (last paragraph or last 600 chars)
  const paragraphs = trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const tail = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1] : trimmed;

  // 1. Completion semantics veto: if the tail clearly indicates completion has ALREADY occurred
  // e.g. "has finished", "is completed", "completed successfully", "已运行完成，测试全部通过"
  const hasCompletion =
    /(?:has|have|is|are)\s+(?:completed|finished|terminated|succeeded|done)\b|(?:completed|finished|terminated)\s+successfully|all\s+tasks\s+(?:finished|done|completed)|(?:已运行完成|已执行完毕|执行完毕|运行完成|全部完成|已全部完成|已结束)\s*[,，。、;；\s]*(?:测试|所有|全部|任务|结果)?/i.test(
      tail
    );

  // If completion is declared AND it doesn't have an ongoing future-wait clause (like "请等待" or "静待")
  if (hasCompletion && !/(?:请等待|静待|耐心等待|稍后|正在等待|等待中)/i.test(tail)) {
    return false;
  }

  // 2. Explicit task waiting: /waiting for .*task-\d+/i or Chinese equivalent
  if (
    /waiting\s+(?:for|on)\s+.*task-\d+/i.test(tail) ||
    /(?:等待|静待|请稍候|稍后|耐心等待).*(?:task-\d+|后台任务)/i.test(tail)
  ) {
    return true;
  }

  // 3. Waiting for background process / job / command / test / build / output / notification / timer
  if (
    /(?:wait|waiting)\s+(?:for|on)\s+(?:the\s+)?(?:background\s+)?(?:task|process|job|command|build|test|run|output|completion|notification|result|timer)/i.test(
      tail
    )
  ) {
    return true;
  }

  // 4. Still running in background / running as background / awaiting timer / wake on notification / pausing to await
  if (
    /(?:still\s+running\s+in\s+(?:the\s+)?background|running\s+as\s+a\s+background\s+task|awaiting?\s+(?:timer|background|completion)|will\s+notify\s+(?:you|me|us)\s+when|wake\s+(?:when|up|upon)|pause\s+(?:and\s+wait|to\s+await))/i.test(
      tail
    ) ||
    /(?:后台仍在运行|在后台运行|转入后台|已提交后台|后台执行中|正在后台运行|等待唤醒|等待通知|等待.*完成|静待.*结果|已启动后台)/i.test(tail)
  ) {
    return true;
  }

  // 5. General waiting clauses (e.g. "Please wait a moment", "请稍候", "耐心等待")
  if (
    /(?:please\s+wait|wait\s+a\s+moment|waiting\s+for\s+(?:it\s+to\s+finish|completion))/i.test(tail) ||
    /(?:请稍候|请等待|耐心等待)/i.test(tail)
  ) {
    return true;
  }

  // Also check across the full text if it's relatively short (<1000 chars)
  if (trimmed.length < 1000) {
    if (
      /waiting\s+(?:for|on)\s+.*task-\d+/i.test(trimmed) ||
      /(?:等待|静待|请稍候|稍后|耐心等待).*(?:task-\d+|后台任务)/i.test(trimmed) ||
      /(?:后台仍在运行|在后台运行|转入后台|已提交后台)/i.test(trimmed) ||
      /(?:please\s+wait|wait\s+a\s+moment)/i.test(trimmed) ||
      /(?:请稍候|请等待|耐心等待)/i.test(trimmed)
    ) {
      return true;
    }
  }

  return false;
}

interface TrackedBackgroundTask {
  taskId: string;
  cascadeId?: string;
  description?: string;
  startedAt?: string;
  startStepIndex: number;
  timerCondition?: string | null;
  isSchedule?: boolean;
  durationSeconds?: number;
  finished: boolean;
}

export function isTaskIdMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;

  const parseParts = (id: string) => {
    const slashIdx = id.lastIndexOf('/');
    const colonIdx = id.lastIndexOf(':');
    const sepIdx = Math.max(slashIdx, colonIdx);
    if (sepIdx >= 0) {
      return { prefix: id.slice(0, sepIdx).trim(), base: id.slice(sepIdx + 1).trim() };
    }
    return { prefix: undefined, base: id.trim() };
  };

  const pA = parseParts(a);
  const pB = parseParts(b);

  if (pA.prefix && pB.prefix && pA.prefix.toLowerCase() !== pB.prefix.toLowerCase()) {
    return false;
  }
  return pA.base.toLowerCase() === pB.base.toLowerCase();
}

/**
 * 残余盲区②：结构化不可得的唯一例外。
 * IDE 层定时调度任务（如 schedule 工具创建的计时器），其触发完成通知仅以 SYSTEM_MESSAGE 注入，
 * 不产生独立的 tool execution step 状态变更。因此保留且仅保留这一条窄正则识别该通知，提取完成的任务 ID。
 */
export const IDE_TIMER_SYSTEM_MESSAGE_REGEX =
  /(?:sender=|(?:Task id|任务)\s*")([a-zA-Z0-9_-]+\/)?(task-\d+)\b/i;

/**
 * Parses raw JSON lines from a cascade transcript into a structured snapshot.
 *
 * @param lines Raw lines read from transcript_full.jsonl or transcript.jsonl
 * @param baselineStepIndex If >= 0, only steps with step_index > baselineStepIndex
 *        are inspected for user input and completion signals.
 * @param cascadeId Target cascade ID for task isolation. Tasks belonging to a
 *        different cascade prefix are discarded.
 */
export function parseTranscript(
  lines: string[],
  baselineStepIndex = -1,
  cascadeId?: string,
): ParsedTranscript {
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

  // Scan trajectory for active (uncompleted) background tasks
  const tasksMap = new Map<string, TrackedBackgroundTask>();
  let lastTimerCondition: string | null = null;
  let lastToolWasSchedule = false;
  let lastDurationSeconds: number | undefined = undefined;

  for (const step of parsedSteps) {
    if (step.tool_calls) {
      for (const tc of step.tool_calls) {
        const tName = tc.name || (tc as any).tool_name;
        if (tName === 'schedule') {
          lastToolWasSchedule = true;
          const tArgs = tc.args || (tc as any).tool_args;
          if (tArgs) {
            if (typeof tArgs.TimerCondition === 'string') {
              lastTimerCondition = tArgs.TimerCondition;
            }
            if (typeof tArgs.DurationSeconds === 'number') {
              lastDurationSeconds = tArgs.DurationSeconds;
            } else if (typeof tArgs.DurationSeconds === 'string') {
              const parsedSec = parseInt(tArgs.DurationSeconds, 10);
              if (!Number.isNaN(parsedSec)) lastDurationSeconds = parsedSec;
            }
          }
        }
      }
    }

    // 1. Structured Task Launch
    // Must be status === 'RUNNING' and a tool executor step carrying structured taskDetails.
    // Excludes PLANNER_RESPONSE, USER_INPUT, CHECKPOINT, SYSTEM_MESSAGE, etc.
    const isLaunchStepType =
      step.type === 'GENERIC' ||
      step.type === 'TOOL_RESULT' ||
      step.type === 'TOOL_EXECUTION' ||
      step.type === 'RUN_COMMAND';
    const structDetails = (step as any).taskDetails || (step as any).task_details;
    if (
      step.status === 'RUNNING' &&
      isLaunchStepType &&
      structDetails &&
      typeof structDetails.id === 'string'
    ) {
      let cascadePrefix: string | undefined;
      let rawTaskId: string | undefined;
      let description: string | undefined;

      const idParts = structDetails.id.split('/');
      if (idParts.length === 2) {
        cascadePrefix = idParts[0];
        rawTaskId = idParts[1];
      } else {
        rawTaskId = idParts[0];
      }
      if (
        structDetails.description ||
        structDetails.summary ||
        structDetails.toolSummary ||
        structDetails.tool_summary
      ) {
        description = String(
          structDetails.description ||
          structDetails.summary ||
          structDetails.toolSummary ||
          structDetails.tool_summary
        ).trim();
      }

      if (rawTaskId) {
        // Cascade isolation: if a cascade prefix exists and target cascadeId is specified, must match
        if (cascadePrefix && cascadeId && cascadePrefix !== cascadeId) {
          console.warn(
            `[antigravity] Rejecting background task ${rawTaskId} from foreign cascade ${cascadePrefix} (target: ${cascadeId})`
          );
          continue;
        }

        const taskId = rawTaskId.toLowerCase();
        // Validation: taskId must strictly match task-\d+
        if (!/^task-\d+$/.test(taskId)) {
          console.warn(
            `[antigravity] Dropping invalid taskId: "${taskId}" in cascade ${cascadeId ?? 'unknown'}`
          );
          continue;
        }

        // Validation on description: no newlines, no standalone file URIs
        if (description) {
          if (
            /[\r\n]/.test(description) ||
            /^file:\/\/\//i.test(description)
          ) {
            console.warn(
              `[antigravity] Dropping invalid task description for ${taskId}: "${description}"`
            );
            description = undefined;
          } else if (description.length > 300) {
            description = description.slice(0, 300);
          }
        }

        const durationSeconds = lastDurationSeconds;

        const isSchedule =
          lastToolWasSchedule ||
          Boolean(lastTimerCondition) ||
          durationSeconds !== undefined ||
          Boolean(description && /timer|schedule|cron/i.test(description));

        tasksMap.set(taskId, {
          taskId,
          cascadeId: cascadePrefix || cascadeId,
          description,
          startedAt: step.created_at,
          startStepIndex: step.step_index ?? 0,
          timerCondition: lastTimerCondition,
          isSchedule,
          durationSeconds,
          finished: false,
        });
        lastTimerCondition = null;
        lastToolWasSchedule = false;
        lastDurationSeconds = undefined;
      }
    }

    // 2. Structured Task Finish
    // 2a. SYSTEM_MESSAGE from hub
    // 残余盲区②：结构化不可得的唯一例外。
    // IDE 层定时调度任务/计时器完成通知仅以 SYSTEM_MESSAGE 文本注入（携带 sender 或 Task id 引号文本），
    // 允许且仅保留这一条窄正则识别该通知，提取完成的任务 ID。
    if (step.type === 'SYSTEM_MESSAGE' && typeof step.content === 'string') {
      const senders: string[] = [];
      if ((step as any).sender) senders.push(String((step as any).sender).trim());

      const ideScheduleMatch = step.content.match(IDE_TIMER_SYSTEM_MESSAGE_REGEX);
      if (ideScheduleMatch) {
        const prefix = ideScheduleMatch[1]?.replace(/\/$/, '');
        if (!prefix || !cascadeId || prefix === cascadeId) {
          senders.push(ideScheduleMatch[2].toLowerCase());
        }
      }

      for (const s of senders) {
        const matched = findMatchingTask(s);
        if (matched) {
          matched.finished = true;
          markTimerConditionSatisfied(matched.taskId);
        }
        markTimerConditionSatisfied(s);
      }
    }

    // 2b. Structured Task Finish via step.taskDetails or step.task_details
    const finDetails = (step as any).taskDetails || (step as any).task_details;
    if (step.status === 'DONE' && finDetails && typeof finDetails.id === 'string') {
      const parts = finDetails.id.split('/');
      const rawId = parts.length === 2 ? parts[1] : parts[0];
      const matched = findMatchingTask(rawId.toLowerCase());
      if (matched) {
        matched.finished = true;
        markTimerConditionSatisfied(matched.taskId);
      }
      markTimerConditionSatisfied(rawId.toLowerCase());
    }

    // 3. Foreground Progress Fallback (前台步骤推进兜底)
    // If a subsequent step shows active foreground progress (new USER_INPUT or PLANNER_RESPONSE
    // invoking substantive tools other than pure observational tools), any standard background task
    // started BEFORE this step has necessarily finished (hub wakes session upon background task exit).
    // R3: 纯观测类工具排除，且 schedule / timerCondition 任务永不被兜底误清。
    const stepIdx = step.step_index ?? 0;
    let isForegroundProgress = false;

    if (step.type === 'USER_INPUT') {
      isForegroundProgress = true;
    } else if (step.type === 'PLANNER_RESPONSE' && step.tool_calls && step.tool_calls.length > 0) {
      const hasSubstantiveTools = step.tool_calls.some((tc) => {
        const name = (tc.name || (tc as any).tool_name || '').trim();
        return name.length > 0 && !OBSERVATIONAL_TOOL_NAMES.has(name);
      });
      if (hasSubstantiveTools) isForegroundProgress = true;
    }

    if (isForegroundProgress) {
      for (const [id, t] of tasksMap) {
        // schedule / timerCondition tasks must NEVER be cleared by foreground progress fallback!
        const isTimerOrSchedule =
          Boolean(t.timerCondition) ||
          t.isSchedule ||
          t.taskId.includes('timer') ||
          Boolean(t.description && /timer|schedule|cron/i.test(t.description));
        if (isTimerOrSchedule) {
          continue;
        }

        if (!t.finished && stepIdx > t.startStepIndex) {
          t.finished = true;
          markTimerConditionSatisfied(id);
        }
      }
    }
  }

  function findMatchingTask(candidateId: string): TrackedBackgroundTask | undefined {
    const raw = candidateId.toLowerCase();
    for (const [id, t] of tasksMap) {
      if (isTaskIdMatch(id, raw)) return t;
    }
    return undefined;
  }

  function markTimerConditionSatisfied(targetId: string) {
    for (const [, otherT] of tasksMap) {
      if (!otherT.finished && otherT.timerCondition && isTaskIdMatch(otherT.timerCondition, targetId)) {
        otherT.finished = true;
      }
    }
  }

  const activeBackgroundTasks: ActiveBackgroundTask[] = Array.from(tasksMap.values())
    .filter((t) => !t.finished)
    .map((t) => ({
      taskId: t.taskId,
      description: t.description,
      startedAt: t.startedAt,
      startStepIndex: t.startStepIndex,
      durationSeconds: t.durationSeconds,
      isSchedule: t.isSchedule,
    }));

  const result: ParsedTranscript = {
    maxStepIndex: fileMaxStepIndex,
    userInputIndex: -1,
    plannerContents: [],
    engagedAfterInput: false,
    checkpointAfterInput: false,
    isFinished: false,
    tailKind: 'none',
    activeBackgroundTasks,
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

export type SettleGuardAction = 'settle' | 'settle-exhausted' | 'continue' | 'wait' | 'wait-background';

export interface SettleGuardInput {
  snap: Pick<
    TranscriptSnapshot,
    'isFinished' | 'plannerContents' | 'tailKind' | 'engaged' | 'pendingApproval' | 'error' | 'activeBackgroundTasks' | 'hasActiveChildren'
  >;
  /** Optional active background tasks that block settlement (non-infinite-silenced). If omitted, defaults to snap.activeBackgroundTasks. */
  blockingBackgroundTasks?: ActiveBackgroundTask[];
  /** 残余盲区①：Optional flag indicating active subagent child sessions. If omitted, defaults to snap.hasActiveChildren. */
  hasActiveChildren?: boolean;
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
  reason?: AutoContinueReason | 'background-task';
  activeTasks?: ActiveBackgroundTask[];
}

/**
 * Decides whether a "finished-looking" cascade snapshot may settle as done, or
 * whether the transcript tail proves the model merely paused mid-work and the
 * bridge should nudge it with a "Continue" message instead.
 *
 * Guard conditions (checked at every done-settlement exit):
 * - (0) `background-task`: active background tasks are still running in the
 *   session. Any background task completion sends a message to AGY session from
 *   the hub, waking it up. The turn is NOT complete; do not settle or continue.
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

  // Background task guard: when there are blocking (non-infinite-silenced) background tasks,
  // the turn is NOT finished regardless of whether the model output text or finished turn.
  // The hub will send a message to AGY session when any background task completes to wake it up.
  // Do NOT settle, do NOT auto-continue.
  const blockingTasks = input.blockingBackgroundTasks ?? snap.activeBackgroundTasks;
  if (blockingTasks && blockingTasks.length > 0) {
    return { action: 'wait-background', reason: 'background-task', activeTasks: blockingTasks };
  }

  // 残余盲区①：subagent 子会话（父帧只有 has_active_children 布尔——为 true 时视为阻塞 settle）
  const activeChildren = input.hasActiveChildren ?? snap.hasActiveChildren ?? false;
  if (activeChildren) {
    return { action: 'wait-background', reason: 'background-task' };
  }

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

  // Genuine-looking final reply (assistant text / checkpoint tail): settle after stillness window.
  // Note: isWaitingSpeech is NO LONGER evaluated here! Zero regexes on settle path.
  if (tailQuietMs < settleStableMs) return { action: 'wait' };
  return { action: 'settle' };
}

export interface LoadedTranscript {
  path: string;
  text: string;
  mtimeMs: number;
}

export interface PruneStaleTasksOptions {
  nowMs?: number;
  lastActiveAtMs?: number;
}

/**
 * Prunes stale orphan background tasks that have exceeded their expected lifetime
 * AND whose transcript has ceased growing for at least 15 minutes.
 *
 * Counter-example protection:
 * If the transcript is actively growing (nowMs - lastActiveAtMs < 15 minutes),
 * long-running processes (e.g. `node ygopro-server.js`) MUST NEVER be pruned.
 */
export function pruneStaleBackgroundTasks(
  tasks: ActiveBackgroundTask[] | undefined,
  options?: PruneStaleTasksOptions,
): { activeTasks: ActiveBackgroundTask[]; prunedTasks: ActiveBackgroundTask[] } {
  if (!tasks || tasks.length === 0) {
    return { activeTasks: [], prunedTasks: [] };
  }

  const nowMs = options?.nowMs ?? Date.now();
  const lastActiveAtMs = options?.lastActiveAtMs ?? nowMs;

  const FIFTEEN_MIN_MS = 15 * 60 * 1000;
  const transcriptIsStale = nowMs - lastActiveAtMs >= FIFTEEN_MIN_MS;

  // Condition (c) protection: If transcript is still actively growing, NEVER prune any task!
  if (!transcriptIsStale) {
    return { activeTasks: tasks, prunedTasks: [] };
  }

  const activeTasks: ActiveBackgroundTask[] = [];
  const prunedTasks: ActiveBackgroundTask[] = [];

  for (const t of tasks) {
    let expectedLifetimeMs: number;
    const isTimer = Boolean(
      t.isSchedule ||
      t.durationSeconds !== undefined ||
      t.taskId.includes('timer') ||
      (t.description && /timer|schedule|cron/i.test(t.description))
    );

    if (isTimer) {
      if (typeof t.durationSeconds === 'number' && t.durationSeconds > 0) {
        expectedLifetimeMs = t.durationSeconds * 10 * 1000;
      } else {
        const descM = t.description?.match(/\bTimer:\s*(\d+)\s*s(?:ec(?:ond)?)?\b/i);
        if (descM) {
          expectedLifetimeMs = parseInt(descM[1], 10) * 10 * 1000;
        } else {
          expectedLifetimeMs = FIFTEEN_MIN_MS;
        }
      }
    } else {
      expectedLifetimeMs = FIFTEEN_MIN_MS;
    }

    let isTaskOverdue = false;
    if (t.startedAt) {
      const taskStartMs = Date.parse(t.startedAt);
      if (!Number.isNaN(taskStartMs)) {
        isTaskOverdue = nowMs - taskStartMs >= expectedLifetimeMs;
      } else {
        isTaskOverdue = true;
      }
    } else {
      isTaskOverdue = true;
    }

    if (isTaskOverdue && transcriptIsStale) {
      console.warn(
        `[antigravity] Pruning stale background task ${t.taskId} (desc: "${t.description ?? 'none'}", startedAt: ${t.startedAt}, expectedLifetimeMs: ${expectedLifetimeMs}ms, transcriptIdleMs: ${nowMs - lastActiveAtMs}ms)`
      );
      prunedTasks.push(t);
    } else {
      activeTasks.push(t);
    }
  }

  return { activeTasks, prunedTasks };
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
  const parsed = parseTranscript(lines, baselineStepIndex, cascadeId);

  const lastActiveAtMs = parsed.lastActiveAt ? Date.parse(parsed.lastActiveAt) : loaded.mtimeMs;
  const effectiveLastActiveMs = Number.isNaN(lastActiveAtMs) ? loaded.mtimeMs : lastActiveAtMs;
  const { activeTasks } = pruneStaleBackgroundTasks(parsed.activeBackgroundTasks, {
    nowMs: Date.now(),
    lastActiveAtMs: effectiveLastActiveMs,
  });

  return {
    maxStepIndex: parsed.maxStepIndex,
    engaged: parsed.engagedAfterInput,
    plannerContents: parsed.plannerContents,
    lastActiveAt: parsed.lastActiveAt,
    pendingApproval: parsed.pendingApproval,
    isFinished: parsed.isFinished,
    error: parsed.error,
    tailKind: parsed.tailKind,
    activeBackgroundTasks: activeTasks,
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
      latestParsed = parseTranscript(lines, baselineStepIndex, cascadeId);
      const lastActiveAtMs = latestParsed.lastActiveAt
        ? Date.parse(latestParsed.lastActiveAt)
        : (loaded?.mtimeMs ?? Date.now());
      const effectiveLastActiveMs = Number.isNaN(lastActiveAtMs)
        ? (loaded?.mtimeMs ?? Date.now())
        : lastActiveAtMs;
      const { activeTasks } = pruneStaleBackgroundTasks(latestParsed.activeBackgroundTasks, {
        nowMs: Date.now(),
        lastActiveAtMs: effectiveLastActiveMs,
      });
      latestParsed.activeBackgroundTasks = activeTasks;
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
        const hasActiveTasks =
          Boolean(latestParsed.activeBackgroundTasks && latestParsed.activeBackgroundTasks.length > 0);
        if (
          !hasActiveTasks &&
          (latestParsed.checkpointAfterInput || (latestParsed.isFinished && tailSettleable && stable))
        ) {
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

