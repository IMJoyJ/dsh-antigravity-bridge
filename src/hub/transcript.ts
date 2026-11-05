import { stat, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isTransientRetryableError } from './classifier.js';

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
  logUri?: string;
  lastProgressAt?: string;
  isStalled?: boolean;
  stalledDurationMs?: number;
}

/**
 * 默认后台任务静默上限 (ms)：15分钟。
 * 任务超过该时长无任何日志写入或进展，在通知和状态中上报为「疑似停滞 (Suspected Stalled)」，
 * 但绝不粗暴误杀合法长时任务。
 */
export const DEFAULT_BACKGROUND_TASK_STALL_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * 迟滞窗口 (ms)：后台任务的「迟滞性」观测窗口。
 *
 * The hub does NOT register a cascade's background tasks at StartCascade /
 * SendUserCascadeMessage time. The executor has to run for a few seconds before
 * GetCascadeTrajectory starts carrying `taskDetails` for it, so a probe issued
 * right after launch legitimately reads `activeBackgroundTasks: []`.
 *
 * An empty task list inside this window therefore means "not observed yet", NOT
 * "there is no background work". Reading it as "none" prematurely settles a lane
 * that is still running — the false-idle defect.
 *
 * Size rationale (latency-neutral by construction): the settle path already
 * requires `settleStableMs` (15s) of transcript stillness before it even records
 * a candidate, plus `SETTLE_CONFIRMATION_INTERVAL_MS` (10s) of two-phase
 * confirmation. The last transcript movement can never predate the launch, so
 * the earliest possible settle is launch + ~25s. A 20s window therefore sits
 * strictly inside waiting that already happens and adds no settle latency.
 */
export const LAUNCH_OBSERVATION_GRACE_MS = 20_000;

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
  /** Spawned subagent conversation IDs in this transcript that have not yet returned or been killed. */
  activeSubagentIds?: string[];
  /** First created_at timestamp in transcript (anchors cascade start time). */
  firstCreatedAt?: string;
  /** Whether any step in the transcript carries explicit cancellation status. */
  hasCanceledStep?: boolean;
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
  /** Spawned subagent conversation IDs in this transcript that have not yet returned or been killed. */
  activeSubagentIds?: string[];
  /** First created_at timestamp in transcript (anchors cascade start time). */
  firstCreatedAt?: string;
  /** Whether any step in the transcript carries explicit cancellation status. */
  hasCanceledStep?: boolean;
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
  'manage_subagents',
  'invoke_subagent',
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
  logUri?: string;
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
 * Merges active background tasks discovered from the transcript with those
 * reported by structured hub queries.
 *
 * De-duplicates by taskId (using {@link isTaskIdMatch}).
 * Transcript entries have strict priority; hub entries can only supplement
 * tasks missing from the transcript table. Hub queries must NEVER erase
 * transcript-tracked tasks, EXCEPT when `hubAllTasks` explicitly provides
 * positive termination evidence (`isActive === false`) confirming a task has
 * reached a terminal state (e.g. crashed without SYSTEM_MESSAGE).
 */
export function mergeBackgroundTasks(
  transcriptTasks: ActiveBackgroundTask[],
  hubActiveTasks: ActiveBackgroundTask[],
  hubAllTasks?: (ActiveBackgroundTask & { isActive?: boolean })[],
): ActiveBackgroundTask[] {
  let result: ActiveBackgroundTask[] = Array.isArray(transcriptTasks) ? [...transcriptTasks] : [];

  // Positive termination evidence: if hubAllTasks explicitly reports a task with isActive === false,
  // the task has definitely reached a terminal state on the hub (e.g. crashed without SYSTEM_MESSAGE).
  // Such tasks are retired from transcript tracking.
  if (Array.isArray(hubAllTasks) && hubAllTasks.length > 0) {
    result = result.filter((tTask) => {
      if (!tTask || typeof tTask.taskId !== 'string') return false;
      const isPositivelyTerminated = hubAllTasks.some(
        (h) => h && typeof h.taskId === 'string' && isTaskIdMatch(tTask.taskId, h.taskId) && h.isActive === false,
      );
      return !isPositivelyTerminated;
    });
  }

  // Supplement with hub active tasks not yet present in the result
  if (Array.isArray(hubActiveTasks) && hubActiveTasks.length > 0) {
    for (const hTask of hubActiveTasks) {
      if (!hTask || typeof hTask.taskId !== 'string') continue;
      const exists = result.some((t) => isTaskIdMatch(t.taskId, hTask.taskId));
      if (!exists) {
        result.push(hTask);
      }
    }
  }

  return result;
}

/**
 * hub 工具执行结果中即时注入的后台任务启动标记模板。
 * 真实样本：
 * "Tool is running as a background task with task id: <cascadeId>/task-148 Task Description: dotnet build ... Task logs are available at: file:///.../tasks/task-148.log"
 */
export const BACKGROUND_TASK_LAUNCH_MARKER_REGEX =
  /running as a background task with task id:\s*([a-zA-Z0-9_-]+)\/(task-\d+)/i;

/**
 * hub 工具执行结果模板中注入的任务专属日志 URI 正则。
 */
export const BACKGROUND_TASK_LOG_URI_REGEX =
  /Task logs are available at:\s*(file:\/\/\/\S+?\.log)/i;

/**
 * 残余盲区②：结构化不可得的唯一例外。
 * IDE 层定时调度任务（如 schedule 工具创建的计时器），其触发完成通知仅以 SYSTEM_MESSAGE 注入，
 * 不产生独立的 tool execution step 状态变更。因此保留且仅保留这一条窄正则识别该通知，提取完成的任务 ID。
 */
export const IDE_TIMER_SYSTEM_MESSAGE_REGEX =
  /(?:sender=|(?:Task id|任务)\s*")([a-zA-Z0-9_-]+\/)?(task-\d+)\b/i;

/**
 * manage_task list 工具调用的空列表响应正则。
 * 真实形态（GENERIC 步，结构化工具结果尾部）及测试形态（MANAGE_TASK 步，裸短语）：
 * "No background tasks are currently running."
 * 作为 hub 阳性证据表明当前无任何非调度类后台任务在运行。
 * 严格尾部锚定（禁止短语出现在文本中间），且要求短语必须位于 Created At 结构化标头之后
 * （或为纯裸短语），防止 view_file 读取包含该字面量的文件时产生假 done。
 */
export const MANAGE_TASK_EMPTY_LIST_REGEX =
  /(?:Created At:[\s\S]*?|^\s*)No background tasks are currently running[.\s]*$/i;

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
  let firstCreatedAt: string | undefined;
  let hasCanceledStep = false;

  for (const line of lines) {
    let step: TranscriptStep;
    try {
      step = JSON.parse(line);
      parsedSteps.push(step);
      if (typeof step.step_index === 'number') {
        if (!firstCreatedAt && typeof step.created_at === 'string') {
          firstCreatedAt = step.created_at;
        }
        if (
          step.status === 'CANCELED' ||
          step.status === 'CANCELLED' ||
          (typeof step.content === 'string' && /context canceled|explicitly canceled by the user/i.test(step.content))
        ) {
          hasCanceledStep = true;
        } else if (
          (step.type === 'USER_INPUT' || step.type === 'PLANNER_RESPONSE') &&
          step.status === 'DONE'
        ) {
          hasCanceledStep = false;
        }
        fileMaxStepIndex = Math.max(fileMaxStepIndex, step.step_index);
        if (step.type === 'USER_INPUT' && step.status === 'DONE') {
          latestGlobalUserInputIndex = Math.max(latestGlobalUserInputIndex, step.step_index);
        }
      }
    } catch {
      continue; // tolerate a torn trailing line from a concurrent writer
    }
  }

  // Scan trajectory for active (uncompleted) background tasks and child subagents
  const tasksMap = new Map<string, TrackedBackgroundTask>();
  interface TrackedSubagent {
    childId: string;
    startStepIndex: number;
    lastDispatchStep: number;
    returned: boolean;
    killed: boolean;
  }
  const subagentsMap = new Map<string, TrackedSubagent>();
  const pendingInvokeSubagentSteps: number[] = [];
  let lastTimerCondition: string | null = null;
  let lastToolWasSchedule = false;
  let lastDurationSeconds: number | undefined = undefined;

  for (const step of parsedSteps) {
    const stepIdxForSub = step.step_index ?? 0;
    if (step.tool_calls) {
      for (const tc of step.tool_calls) {
        const tName = String(tc.name || (tc as any).tool_name || '').trim();
        const rawTcArgs = tc.args ?? (tc as any).tool_args ?? (tc as any).arguments;
        let tArgs: Record<string, any> | undefined;
        if (typeof rawTcArgs === 'string') {
          try {
            tArgs = JSON.parse(rawTcArgs);
          } catch {}
        } else if (typeof rawTcArgs === 'object' && rawTcArgs !== null) {
          tArgs = rawTcArgs as Record<string, any>;
        }

        if (tName === 'schedule') {
          lastToolWasSchedule = true;
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
        } else if (tName === 'invoke_subagent' || tName === 'INVOKE_SUBAGENT') {
          pendingInvokeSubagentSteps.push(stepIdxForSub);
        } else if (tName === 'send_message' && tArgs) {
          const rawRecipient = tArgs.Recipient ?? tArgs.recipient;
          if (typeof rawRecipient === 'string') {
            const recipient = rawRecipient.replace(/^"|"$/g, '').trim().toLowerCase();
            if (
              recipient &&
              (subagentsMap.has(recipient) ||
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recipient))
            ) {
              const prev = subagentsMap.get(recipient);
              subagentsMap.set(recipient, {
                childId: recipient,
                startStepIndex: prev?.startStepIndex ?? stepIdxForSub,
                lastDispatchStep: stepIdxForSub,
                returned: false,
                killed: false,
              });
            }
          }
        } else if (tName === 'manage_subagents' && tArgs) {
          const action = String(tArgs.Action ?? tArgs.action ?? '').replace(/^"|"$/g, '').trim().toLowerCase();
          if (action === 'kill_all') {
            for (const [, sub] of subagentsMap) {
              sub.killed = true;
            }
            pendingInvokeSubagentSteps.length = 0;
          } else if (action === 'kill') {
            let convIds = tArgs.ConversationIds ?? tArgs.conversationIds;
            if (typeof convIds === 'string') {
              try {
                convIds = JSON.parse(convIds);
              } catch {}
            }
            if (Array.isArray(convIds)) {
              for (const rawCid of convIds) {
                const norm = String(rawCid ?? '').replace(/^"|"$/g, '').trim().toLowerCase();
                const sub = subagentsMap.get(norm);
                if (sub) sub.killed = true;
              }
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
    const isSubagentStepType =
      step.type === 'INVOKE_SUBAGENT' ||
      step.type === 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT' ||
      step.type === 'MANAGE_SUBAGENTS';
    const isViewFileOutput =
      typeof step.content === 'string' &&
      /(?:^|\n)File Path:\s*`?file:\/\/\//i.test(step.content.slice(0, 400));

    if ((isLaunchStepType || isSubagentStepType) && !isViewFileOutput) {
      const spawnedIds: string[] = [];
      if (typeof step.content === 'string' && /Created the following subagents:/i.test(step.content)) {
        const matches = step.content.matchAll(/"conversationId"\s*:\s*"([^"]+)"/gi);
        for (const m of matches) {
          if (m[1]) spawnedIds.push(m[1].trim().toLowerCase());
        }
      }
      const structChildId =
        (step as any).subagentDetails?.conversationId ||
        (step as any).subagent_details?.conversation_id ||
        (step as any).childConversationId ||
        (step as any).child_conversation_id;
      if (typeof structChildId === 'string' && structChildId.trim()) {
        spawnedIds.push(structChildId.trim().toLowerCase());
      }
      if (spawnedIds.length > 0) {
        if (pendingInvokeSubagentSteps.length > 0) {
          pendingInvokeSubagentSteps.shift();
        }
        for (const cid of spawnedIds) {
          subagentsMap.set(cid, {
            childId: cid,
            startStepIndex: stepIdxForSub,
            lastDispatchStep: stepIdxForSub,
            returned: false,
            killed: false,
          });
        }
      } else if (
        (step.type === 'INVOKE_SUBAGENT' || step.type === 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT') &&
        pendingInvokeSubagentSteps.length === 0
      ) {
        pendingInvokeSubagentSteps.push(stepIdxForSub);
      }

      if (typeof step.content === 'string') {
        if (/No active subagents|You have 0 active subagent/i.test(step.content)) {
          for (const [, sub] of subagentsMap) {
            if (sub.lastDispatchStep <= stepIdxForSub) {
              sub.killed = true;
            }
          }
          pendingInvokeSubagentSteps.length = 0;
        } else {
          const listMatch = step.content.match(/You have \d+ active subagent\(s\):\s*(\[[\s\S]*\])/i);
          if (listMatch && listMatch[1]) {
            try {
              const listArr = JSON.parse(listMatch[1]);
              if (Array.isArray(listArr)) {
                for (const item of listArr) {
                  const cid = String(item?.conversationId ?? '').trim().toLowerCase();
                  const st = String(item?.state ?? '').trim().toLowerCase();
                  if (cid && (st === 'idle' || st === 'errored' || st === 'subagent_state_killed')) {
                    const sub = subagentsMap.get(cid);
                    if (sub) sub.returned = true;
                  }
                }
              }
            } catch {}
          }
        }
      }
    }

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

        const logUri = structDetails.logUri || structDetails.log_uri;

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
          logUri,
        });
        lastTimerCondition = null;
        lastToolWasSchedule = false;
        lastDurationSeconds = undefined;
      }
    }

    // 1b. 文本模板任务启动 (hub 注入工具结果启动模板)
    // 即时拦截 hub 在工具结果里注入的后台任务启动文本，消除注册空窗。
    if (isLaunchStepType && typeof step.content === 'string') {
      const launchMatch = step.content.match(BACKGROUND_TASK_LAUNCH_MARKER_REGEX);
      if (launchMatch) {
        const cascadePrefix = launchMatch[1];
        const rawTaskId = launchMatch[2];
        const taskId = rawTaskId.toLowerCase();

        // 共存规则：文本分支仅在 tasksMap 尚无该 taskId 时注册，绝不覆盖结构化分支已注册的条目
        if (!tasksMap.has(taskId)) {
          // Cascade isolation: if a cascade prefix exists and target cascadeId is specified, must match
          if (cascadePrefix && cascadeId && cascadePrefix !== cascadeId) {
            console.warn(
              `[antigravity] Rejecting background task ${rawTaskId} from foreign cascade ${cascadePrefix} (target: ${cascadeId})`
            );
          } else if (!/^task-\d+$/.test(taskId)) {
            // Validation: taskId must strictly match task-\d+
            console.warn(
              `[antigravity] Dropping invalid taskId: "${taskId}" in cascade ${cascadeId ?? 'unknown'}`
            );
          } else {
            let description: string | undefined;
            if (
              structDetails?.description ||
              structDetails?.summary ||
              structDetails?.toolSummary ||
              structDetails?.tool_summary
            ) {
              description = String(
                structDetails.description ||
                structDetails.summary ||
                structDetails.toolSummary ||
                structDetails.tool_summary
              ).trim();
            } else {
              const descMatch = step.content.match(
                /Task Description:\s*([\s\S]*?)(?=Task logs are available at:|$)/i
              );
              if (descMatch && descMatch[1]) {
                const extracted = descMatch[1].replace(/[\r\n]+/g, ' ').trim();
                if (extracted) {
                  description = extracted;
                }
              }
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

            let logUri = structDetails?.logUri || structDetails?.log_uri;
            if (!logUri) {
              const logMatch = step.content.match(BACKGROUND_TASK_LOG_URI_REGEX);
              if (logMatch && logMatch[1]) {
                logUri = logMatch[1].trim();
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
              logUri,
            });

            lastTimerCondition = null;
            lastToolWasSchedule = false;
            lastDurationSeconds = undefined;
          }
        }
      }
    }

    // 2. Structured Task Finish
    // 2a. SYSTEM_MESSAGE from hub
    // 残余盲区②：结构化不可得的唯一例外。
    // IDE 层定时调度任务/计时器完成通知仅以 SYSTEM_MESSAGE 文本注入（携带 sender 或 Task id 引号文本），
    // 允许且仅保留这一条窄正则识别该通知，提取完成的任务 ID。
    if (step.type === 'SYSTEM_MESSAGE') {
      const senders: string[] = [];
      if ((step as any).sender) senders.push(String((step as any).sender).trim());

      if (typeof step.content === 'string') {
        const ideScheduleMatch = step.content.match(IDE_TIMER_SYSTEM_MESSAGE_REGEX);
        if (ideScheduleMatch) {
          const prefix = ideScheduleMatch[1]?.replace(/\/$/, '');
          if (!prefix || !cascadeId || prefix === cascadeId) {
            senders.push(ideScheduleMatch[2].toLowerCase());
          }
        }
        const subSenderMatches = step.content.matchAll(/(?:\bsender=|"sender"\s*:\s*")([a-zA-Z0-9_-]+)/gi);
        for (const sm of subSenderMatches) {
          if (sm[1]) senders.push(sm[1].trim());
        }
      }

      for (const s of senders) {
        const matched = findMatchingTask(s);
        if (matched) {
          matched.finished = true;
          markTimerConditionSatisfied(matched.taskId);
        }
        markTimerConditionSatisfied(s);

        const normSender = s.toLowerCase();
        const trackedSub = subagentsMap.get(normSender);
        if (trackedSub && stepIdxForSub > trackedSub.lastDispatchStep) {
          trackedSub.returned = true;
        } else if (
          pendingInvokeSubagentSteps.length > 0 &&
          pendingInvokeSubagentSteps[0] < stepIdxForSub &&
          !/^task-\d+$/i.test(normSender)
        ) {
          pendingInvokeSubagentSteps.shift();
        }
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

    // 2c. Empty Background Task List Signal (manage_task "No background tasks are currently running")
    // When manage_task returns "No background tasks are currently running", it provides explicit
    // positive evidence from hub that all foreground background tasks have finished.
    const isManageTaskEmptyListStep = isLaunchStepType || step.type === 'MANAGE_TASK';
    if (
      isManageTaskEmptyListStep &&
      typeof step.content === 'string' &&
      MANAGE_TASK_EMPTY_LIST_REGEX.test(step.content)
    ) {
      for (const [id, t] of tasksMap) {
        // schedule / timerCondition tasks must NEVER be cleared by empty background task list!
        const isTimerOrSchedule =
          Boolean(t.timerCondition) ||
          t.isSchedule ||
          t.taskId.includes('timer') ||
          Boolean(t.description && /timer|schedule|cron/i.test(t.description));
        if (isTimerOrSchedule) {
          continue;
        }

        if (!t.finished) {
          t.finished = true;
          markTimerConditionSatisfied(id);
        }
      }
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
      logUri: t.logUri,
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
    firstCreatedAt,
    hasCanceledStep,
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
  const activeSubagentIds = Array.from(subagentsMap.values())
    .filter((s) => !s.returned && !s.killed && s.lastDispatchStep > baselineStepIndex)
    .map((s) => s.childId);
  const hasPendingUnnamedInvoke = pendingInvokeSubagentSteps.some((idx) => idx > cutIndex);
  if (activeSubagentIds.length > 0) {
    result.activeSubagentIds = activeSubagentIds;
    result.hasActiveChildren = true;
  } else if (hasPendingUnnamedInvoke) {
    result.hasActiveChildren = true;
  }
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
      pendingTools = [];
      result.isFinished = false;
      continue;
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
        pendingTools = [];
        result.isFinished = false;
        continue;
      }

      // Subsequent successful model response indicates recovery from any earlier error
      result.error = undefined;

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

export type SettleGuardReason = AutoContinueReason | 'background-task' | 'background-task-unobserved';

export type SettleGuardAction = 'settle' | 'settle-exhausted' | 'continue' | 'wait' | 'wait-background';

export interface SettleGuardInput {
  snap: Pick<
    TranscriptSnapshot,
    'isFinished' | 'plannerContents' | 'tailKind' | 'engaged' | 'pendingApproval' | 'error' | 'activeBackgroundTasks' | 'hasActiveChildren' | 'hasCanceledStep'
  >;
  /** Optional active background tasks that block settlement (non-infinite-silenced). If omitted, defaults to snap.activeBackgroundTasks. */
  blockingBackgroundTasks?: ActiveBackgroundTask[];
  /** 残余盲区①：Optional flag indicating active subagent child sessions. If omitted, defaults to snap.hasActiveChildren. */
  hasActiveChildren?: boolean;
  /** Turn-level active status from GetCascadeTrajectory (CascadeRunStatus RUNNING/BUSY/CANCELING). */
  isCascadeActive?: boolean;
  /** Whether the cascade has been explicitly stopped or canceled by user. */
  isCanceled?: boolean;
  /**
   * How long ago the bridge recorded this cascade lifecycle (launch / re-arm)
   * — i.e. `now - HubRun.startedAt`. Optional: omitted means "no launch
   * information available" and disables the {@link LAUNCH_OBSERVATION_GRACE_MS}
   * hysteresis, preserving the pre-fix behaviour for callers that cannot supply it.
   */
  sinceLifecycleStartMs?: number;
  /** Override for the launch-hysteresis window (tests / tuning). Defaults to {@link LAUNCH_OBSERVATION_GRACE_MS}. */
  launchObservationGraceMs?: number;
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
  reason?: SettleGuardReason;
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
 * - (0.5) `background-task-unobserved`: launch hysteresis. The hub only
 *   registers a cascade's background tasks after its executor has run for a few
 *   seconds, so a task list read shortly after launch is empty *because it was
 *   not populated yet*, not because there is no background work. Inside
 *   {@link LAUNCH_OBSERVATION_GRACE_MS} an empty observation is UNKNOWN, so the
 *   honest answer is "keep polling" instead of prematurely settling a lane that is
 *   still running (settle immediately breaks the watcher loop without residency detection).
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

  // Turn-level cascade active status (CascadeRunStatus RUNNING/BUSY/CANCELING from GetCascadeTrajectory)
  if (input.isCascadeActive) {
    return { action: 'wait-background', reason: 'background-task' };
  }

  // D4: Explicit cancellation guard. If the cascade was explicitly stopped/canceled by user
  // and is not actively running on the hub, it must settle cleanly as done regardless of whether
  // a closing assistant text was produced.
  const isCanceled = Boolean(input.isCanceled || snap.hasCanceledStep);
  if (isCanceled && !input.isCascadeActive && (!blockingTasks || blockingTasks.length === 0) && !activeChildren) {
    return { action: 'settle' };
  }

  // (0.5) Launch hysteresis. The three liveness guards above all read the SAME
  // hub observation, and that observation is empty until the executor has been
  // running for a few seconds. So an empty list during the window after launch
  // is UNKNOWN, not "none" — model it as "still polling" (the same action a
  // live turn takes) instead of letting the settle path below conclude idleness
  // from a list the hub had not filled in yet.
  //
  // Deliberately placed AFTER the liveness guards so a positively-observed live
  // cascade still reports 'wait-background' (with its task list), and it never
  // overrides an explicit caller's `sinceLifecycleStartMs === undefined`, which
  // keeps every pre-existing caller on the old behaviour.
  if (
    input.sinceLifecycleStartMs !== undefined &&
    input.sinceLifecycleStartMs < (input.launchObservationGraceMs ?? LAUNCH_OBSERVATION_GRACE_MS)
  ) {
    return { action: 'wait', reason: 'background-task-unobserved' };
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

export interface BackgroundTaskProgress {
  isStalled: boolean;
  stalledDurationMs: number;
  lastProgressAt?: string;
  logMtimeMs?: number;
}

/**
 * 评估后台任务进展与停滞状态：
 * 探测任务专属日志文件（task-XXX.log）修改时间（最精确活动心跳）、启动时间与会话最后活跃时间。
 * 当且仅当静默时长 >= stallThresholdMs 时标记为 isStalled（疑似停滞），
 * 但绝不以此为依据强制判死，保障合法长时无输出任务的执行权。
 */
export function assessBackgroundTaskProgress(
  task: ActiveBackgroundTask,
  options?: {
    brainDir?: string;
    cascadeId?: string;
    nowMs?: number;
    stallThresholdMs?: number;
    transcriptLastActiveAt?: string;
  },
): BackgroundTaskProgress {
  const nowMs = options?.nowMs ?? Date.now();
  const stallThresholdMs = options?.stallThresholdMs ?? DEFAULT_BACKGROUND_TASK_STALL_THRESHOLD_MS;
  let logMtimeMs: number | undefined;

  if (options?.brainDir && options?.cascadeId) {
    try {
      let logPath: string | undefined;
      if (task.logUri && task.logUri.startsWith('file:///')) {
        try {
          logPath = fileURLToPath(new URL(task.logUri));
        } catch {}
      }
      if (!logPath) {
        logPath = join(options.brainDir, options.cascadeId, '.system_generated', 'tasks', `${task.taskId}.log`);
      }
      if (existsSync(logPath)) {
        const s = statSync(logPath);
        logMtimeMs = s.mtimeMs;
      }
    } catch {
      // Best-effort inspection
    }
  }

  const taskStartMs = task.startedAt ? Date.parse(task.startedAt) : NaN;
  const candidates: number[] = [];
  if (typeof logMtimeMs === 'number' && !Number.isNaN(logMtimeMs)) {
    candidates.push(logMtimeMs);
  }
  if (!Number.isNaN(taskStartMs)) {
    candidates.push(taskStartMs);
  }

  const effectiveProgressMs = candidates.length > 0 ? Math.max(...candidates) : nowMs;
  const silentDurationMs = Math.max(0, nowMs - effectiveProgressMs);
  const isStalled = silentDurationMs >= stallThresholdMs;

  return {
    isStalled,
    stalledDurationMs: silentDurationMs,
    lastProgressAt: new Date(effectiveProgressMs).toISOString(),
    logMtimeMs,
  };
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
    hasActiveChildren: parsed.hasActiveChildren,
    activeSubagentIds: parsed.activeSubagentIds,
    firstCreatedAt: parsed.firstCreatedAt,
    hasCanceledStep: parsed.hasCanceledStep,
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
        if (!isTransientRetryableError(latestParsed.error)) {
          return {
            done: true,
            status: 'error',
            content: latestParsed.plannerContents.join('\n\n'),
            error: latestParsed.error,
            lastActiveAt: latestParsed.lastActiveAt,
          };
        }
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
          Boolean(latestParsed.activeBackgroundTasks && latestParsed.activeBackgroundTasks.length > 0) ||
          Boolean(latestParsed.hasActiveChildren);
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

