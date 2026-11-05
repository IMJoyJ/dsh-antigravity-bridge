import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ActiveBackgroundTask } from './transcript.js';

/**
 * CortexStepStatus code mappings:
 * PENDING=1, RUNNING=2, WAITING=9, GENERATING=8, QUEUED=11 (Active)
 * DONE=3, CLEARED=5, CANCELED=6, ERROR=7, INTERRUPTED=12 (Terminal)
 */
export const CORTEX_ACTIVE_STATUS_CODES = new Set<number>([1, 2, 8, 9, 11]);
export const CORTEX_TERMINAL_STATUS_CODES = new Set<number>([3, 5, 6, 7, 12]);

export const CORTEX_ACTIVE_STATUS_NAMES = new Set<string>([
  'PENDING',
  'CORTEX_STEP_STATUS_PENDING',
  'RUNNING',
  'CORTEX_STEP_STATUS_RUNNING',
  'WAITING',
  'CORTEX_STEP_STATUS_WAITING',
  'GENERATING',
  'CORTEX_STEP_STATUS_GENERATING',
  'QUEUED',
  'CORTEX_STEP_STATUS_QUEUED',
]);

export const CORTEX_TERMINAL_STATUS_NAMES = new Set<string>([
  'DONE',
  'CORTEX_STEP_STATUS_DONE',
  'CLEARED',
  'CORTEX_STEP_STATUS_CLEARED',
  'CANCELED',
  'CORTEX_STEP_STATUS_CANCELED',
  'CANCELLED',
  'CORTEX_STEP_STATUS_CANCELLED',
  'ERROR',
  'CORTEX_STEP_STATUS_ERROR',
  'INTERRUPTED',
  'CORTEX_STEP_STATUS_INTERRUPTED',
]);

export interface StatusTransition {
  updatedStatus?: string | number;
  timestamp?: string;
}

export interface TrajectoryStepDetail {
  id?: string;
  logUri?: string;
  log_uri?: string;
  description?: string;
  summary?: string;
  toolSummary?: string;
  tool_summary?: string;
}

export interface TrajectoryStepMetadata {
  createdAt?: string;
  created_at?: string;
  internalMetadata?: {
    statusTransitions?: StatusTransition[];
  };
  internal_metadata?: {
    status_transitions?: StatusTransition[];
  };
  hasActiveChildren?: boolean;
  has_active_children?: boolean;
}

export interface TrajectoryStep {
  stepIndex?: number;
  step_index?: number;
  type?: string | number;
  status?: string | number;
  taskDetails?: TrajectoryStepDetail;
  task_details?: TrajectoryStepDetail;
  metadata?: TrajectoryStepMetadata;
  hasSubtrajectory?: boolean;
  has_subtrajectory?: boolean;
  [key: string]: unknown;
}

export interface TrajectoryResponse {
  trajectory?: {
    cascadeId?: string;
    steps?: TrajectoryStep[];
    metadata?: Record<string, unknown>;
    hasActiveChildren?: boolean;
    has_active_children?: boolean;
  };
  status?: string | number;
  hasActiveChildren?: boolean;
  has_active_children?: boolean;
}

export interface StructuredCascadeTasksResult {
  activeTasks: ActiveBackgroundTask[];
  allTasks: (ActiveBackgroundTask & { isActive?: boolean })[];
  hasActiveChildren: boolean;
  /** True when all known child subagents have been positively verified terminal via child transcript/SQLite or parent return message. */
  verifiedAllChildrenTerminal?: boolean;
  isCascadeActive?: boolean;
  /** Whether the cascade has been explicitly canceled or interrupted. */
  isCanceled?: boolean;
  /** Whether any step in the trajectory has status CANCELED (6) or INTERRUPTED (12). */
  hasCanceledStep?: boolean;
  /** Parent conversation ID if this cascade is a child subagent. */
  parentConversationId?: string;
  /** Indicates whether this result comes from an authoritative query (Hub or SQLite) */
  authoritative?: boolean;
}

/**
 * CascadeRunStatus mappings (from protobuf exa.cortex_pb.CascadeRunStatus):
 * UNSPECIFIED=0, IDLE=1
 * RUNNING=2, CANCELING=3, BUSY=4 (Active)
 */
export const CASCADE_RUN_ACTIVE_CODES = new Set<number>([2, 3, 4]);
export const CASCADE_RUN_ACTIVE_NAMES = new Set<string>([
  'RUNNING',
  'CASCADE_RUN_STATUS_RUNNING',
  'BUSY',
  'CASCADE_RUN_STATUS_BUSY',
  'CANCELING',
  'CASCADE_RUN_STATUS_CANCELING',
]);

export function isCascadeRunStatusActive(status: unknown): boolean {
  if (typeof status === 'number') return CASCADE_RUN_ACTIVE_CODES.has(status);
  if (typeof status === 'string') {
    const num = parseInt(status, 10);
    if (!Number.isNaN(num) && CASCADE_RUN_ACTIVE_CODES.has(num)) return true;
    return CASCADE_RUN_ACTIVE_NAMES.has(status.toUpperCase());
  }
  return false;
}

export function isCortexStatusActive(status: unknown): boolean {
  if (typeof status === 'number') return CORTEX_ACTIVE_STATUS_CODES.has(status);
  if (typeof status === 'string') {
    const num = parseInt(status, 10);
    if (!Number.isNaN(num) && CORTEX_ACTIVE_STATUS_CODES.has(num)) return true;
    return CORTEX_ACTIVE_STATUS_NAMES.has(status.toUpperCase());
  }
  return false;
}

export function isCortexStatusTerminal(status: unknown): boolean {
  if (typeof status === 'number') return CORTEX_TERMINAL_STATUS_CODES.has(status);
  if (typeof status === 'string') {
    const num = parseInt(status, 10);
    if (!Number.isNaN(num) && CORTEX_TERMINAL_STATUS_CODES.has(num)) return true;
    return CORTEX_TERMINAL_STATUS_NAMES.has(status.toUpperCase());
  }
  return false;
}

/**
 * Resolves the effective status of a trajectory step, taking into account both
 * the top-level status and the latest transition in metadata.internalMetadata.statusTransitions.
 */
export function getStepEffectiveStatus(step: TrajectoryStep): {
  isActive: boolean;
  isTerminal: boolean;
  status: string | number;
} {
  const transitions =
    step.metadata?.internalMetadata?.statusTransitions ||
    step.metadata?.internal_metadata?.status_transitions;

  let latestTransitionStatus: string | number | undefined;
  if (Array.isArray(transitions) && transitions.length > 0) {
    const last = transitions[transitions.length - 1];
    if (last && last.updatedStatus !== undefined && last.updatedStatus !== null) {
      latestTransitionStatus = last.updatedStatus;
    }
  }

  const stepStatus = step.status ?? '';

  // 1. If step.status is terminal, it has reached its terminal lifecycle
  if (isCortexStatusTerminal(stepStatus)) {
    return { isActive: false, isTerminal: true, status: stepStatus };
  }
  if (latestTransitionStatus !== undefined && isCortexStatusTerminal(latestTransitionStatus)) {
    return { isActive: false, isTerminal: true, status: latestTransitionStatus };
  }

  // 2. If step.status or transition is active
  if (isCortexStatusActive(stepStatus)) {
    return { isActive: true, isTerminal: false, status: stepStatus };
  }
  if (latestTransitionStatus !== undefined && isCortexStatusActive(latestTransitionStatus)) {
    return { isActive: true, isTerminal: false, status: latestTransitionStatus };
  }

  return { isActive: false, isTerminal: false, status: stepStatus };
}

/**
 * Parses full GetCascadeTrajectory response into structured tasks and active child session flag.
 *
 * 活跃任务判定（零正则）：
 * taskDetails != null 且最新状态 ∈ 活跃集合 (PENDING=1, RUNNING=2, WAITING=9, GENERATING=8, QUEUED=11)
 *
 * 残余盲区①：
 * subagent 子会话：父帧/轨迹中 has_active_children 布尔或 INVOKE_SUBAGENT 处于活跃状态时，hasActiveChildren 为 true。
 */
export function parseStructuredTrajectoryTasks(
  trajectoryResp: unknown,
  targetCascadeId?: string,
): StructuredCascadeTasksResult {
  const resp = trajectoryResp as TrajectoryResponse | undefined;
  const steps = resp?.trajectory?.steps || (resp as any)?.steps || [];

  let hasActiveChildren = Boolean(
    resp?.hasActiveChildren ||
    resp?.has_active_children ||
    resp?.trajectory?.hasActiveChildren ||
    resp?.trajectory?.has_active_children ||
    (resp?.trajectory?.metadata as any)?.hasActiveChildren ||
    (resp?.trajectory?.metadata as any)?.has_active_children
  );

  const tasksMap = new Map<string, ActiveBackgroundTask & { isActive: boolean }>();
  let hasCanceledStep = false;

  for (const step of steps) {
    const statusInfo = getStepEffectiveStatus(step);

    if (
      statusInfo.status === 'CANCELED' ||
      statusInfo.status === 'CORTEX_STEP_STATUS_CANCELED' ||
      statusInfo.status === 6 ||
      statusInfo.status === 'INTERRUPTED' ||
      statusInfo.status === 'CORTEX_STEP_STATUS_INTERRUPTED' ||
      statusInfo.status === 12
    ) {
      hasCanceledStep = true;
    }

    // 残余盲区①：subagent 子会话。如果 INVOKE_SUBAGENT 步骤或 subtrajectory 处于活跃状态，视为阻塞 settle
    const isSubagentStep =
      step.type === 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT' ||
      step.type === 'INVOKE_SUBAGENT' ||
      step.type === 127 ||
      step.hasSubtrajectory === true ||
      step.has_subtrajectory === true;

    if (isSubagentStep && statusInfo.isActive) {
      hasActiveChildren = true;
    }

    const td = step.taskDetails || step.task_details;
    if (!td || typeof td !== 'object' || !td.id) {
      continue;
    }

    let cascadePrefix: string | undefined;
    let rawTaskId: string;
    const idParts = String(td.id).split('/');
    if (idParts.length === 2) {
      cascadePrefix = idParts[0];
      rawTaskId = idParts[1];
    } else {
      rawTaskId = idParts[0];
    }

    // Cascade isolation
    if (cascadePrefix && targetCascadeId && cascadePrefix !== targetCascadeId) {
      continue;
    }

    const taskId = rawTaskId.toLowerCase();
    if (!/^task-\d+$/.test(taskId)) {
      continue;
    }

    const desc = td.description || td.summary || td.toolSummary || td.tool_summary;
    const description = desc ? String(desc).trim() : undefined;
    const logUri = td.logUri || td.log_uri;
    const startedAt =
      step.metadata?.createdAt ||
      step.metadata?.created_at ||
      (step as any).created_at ||
      (step as any).createdAt;
    const stepIndex = step.stepIndex ?? step.step_index ?? 0;

    tasksMap.set(taskId, {
      taskId,
      description,
      logUri,
      startedAt,
      startStepIndex: stepIndex,
      isActive: statusInfo.isActive,
    });
  }

  const allTasks: (ActiveBackgroundTask & { isActive?: boolean })[] = [];
  const activeTasks: ActiveBackgroundTask[] = [];

  for (const [, item] of tasksMap) {
    allTasks.push({
      taskId: item.taskId,
      description: item.description,
      startedAt: item.startedAt,
      startStepIndex: item.startStepIndex,
      logUri: item.logUri,
      isActive: item.isActive,
    });
    if (item.isActive) {
      activeTasks.push({
        taskId: item.taskId,
        description: item.description,
        startedAt: item.startedAt,
        startStepIndex: item.startStepIndex,
        logUri: item.logUri,
      });
    }
  }

  const cascadeStatus = resp?.status ?? (resp as any)?.trajectoryStatus;
  const isCascadeActive = isCascadeRunStatusActive(cascadeStatus);
  const isCanceled =
    hasCanceledStep ||
    cascadeStatus === 'CANCELING' ||
    cascadeStatus === 'CASCADE_RUN_STATUS_CANCELING' ||
    cascadeStatus === 3;
  const parentConversationId =
    resp?.trajectory?.metadata?.parentConversationId ||
    (resp?.trajectory?.metadata as any)?.parent_conversation_id ||
    (resp as any)?.metadata?.parentConversationId ||
    (resp as any)?.metadata?.parent_conversation_id;

  return {
    activeTasks,
    allTasks,
    hasActiveChildren,
    isCascadeActive,
    isCanceled,
    hasCanceledStep,
    parentConversationId,
    authoritative: true,
  };
}

/**
 * Decodes a protobuf serialized task_details blob from SQLite steps table.
 * Wire format:
 * Field 1: string id
 * Field 2: string log_uri
 * Field 4: string description
 */
export function decodeProtobufTaskDetails(buf: Buffer): {
  id?: string;
  logUri?: string;
  log_uri?: string;
  description?: string;
} {
  let i = 0;
  let id: string | undefined;
  let logUri: string | undefined;
  let description: string | undefined;

  while (i < buf.length) {
    let tag = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const fieldNo = tag >> 3;
    const wireType = tag & 7;

    if (wireType === 2) {
      let len = 0;
      let s2 = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7f) << s2;
        if (!(b & 0x80)) break;
        s2 += 7;
      }
      if (i + len > buf.length) break;
      const str = buf.subarray(i, i + len).toString('utf8');
      i += len;
      if (fieldNo === 1) id = str;
      else if (fieldNo === 2) logUri = str;
      else if (fieldNo === 3 || fieldNo === 4) description = str;
    } else if (wireType === 0) {
      while (i < buf.length && buf[i++] & 0x80) {}
    } else if (wireType === 1) {
      i += 8;
    } else if (wireType === 5) {
      i += 4;
    } else {
      break;
    }
  }

  return { id, logUri, log_uri: logUri, description };
}

/**
 * Reads background tasks directly from SQLite conversation database as a reliable fallback.
 * Path: ~/.gemini/antigravity/conversations/<cascadeId>.db
 */
export function readStructuredTasksFromSqlite(
  cascadeId: string,
  customDbDir?: string,
): StructuredCascadeTasksResult | undefined {
  const dir = customDbDir || join(homedir(), '.gemini', 'antigravity', 'conversations');
  const dbPath = join(dir, `${cascadeId}.db`);

  if (!existsSync(dbPath)) {
    return undefined;
  }

  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          'SELECT idx, step_type, status, has_subtrajectory, task_details, metadata FROM steps WHERE task_details IS NOT NULL OR step_type = 127 OR has_subtrajectory = 1'
        )
        .all() as Array<{
        idx: number;
        step_type: number;
        status: number;
        has_subtrajectory: number;
        task_details: Buffer | null;
        metadata: Buffer | null;
      }>;

      let hasActiveChildren = false;
      const tasksMap = new Map<string, ActiveBackgroundTask & { isActive: boolean }>();

      for (const row of rows) {
        const statusActive = isCortexStatusActive(row.status);
        if ((row.step_type === 127 || row.has_subtrajectory === 1) && statusActive) {
          hasActiveChildren = true;
        }

        if (row.task_details) {
          const td = decodeProtobufTaskDetails(Buffer.from(row.task_details));
          if (!td.id) continue;

          const parts = td.id.split('/');
          const prefix = parts.length === 2 ? parts[0] : undefined;
          const rawId = parts.length === 2 ? parts[1] : parts[0];

          if (prefix && prefix !== cascadeId) continue;
          const taskId = rawId.toLowerCase();
          if (!/^task-\d+$/.test(taskId)) continue;

          tasksMap.set(taskId, {
            taskId,
            description: td.description,
            logUri: td.logUri || td.log_uri,
            startStepIndex: row.idx,
            isActive: statusActive,
          });
        }
      }

      const allTasks: (ActiveBackgroundTask & { isActive?: boolean })[] = [];
      const activeTasks: ActiveBackgroundTask[] = [];

      for (const [, item] of tasksMap) {
        allTasks.push({
          taskId: item.taskId,
          description: item.description,
          startStepIndex: item.startStepIndex,
          logUri: item.logUri,
          isActive: item.isActive,
        });
        if (item.isActive) {
          activeTasks.push({
            taskId: item.taskId,
            description: item.description,
            startStepIndex: item.startStepIndex,
            logUri: item.logUri,
          });
        }
      }

      let hasCanceledStep = false;
      try {
        const canceledRow = db.prepare('SELECT idx FROM steps WHERE status = 6 OR status = 12 LIMIT 1').get();
        if (canceledRow) {
          hasCanceledStep = true;
        }
      } catch {}

      return {
        activeTasks,
        allTasks,
        hasActiveChildren,
        isCascadeActive: false,
        isCanceled: hasCanceledStep,
        hasCanceledStep,
        authoritative: true,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`[antigravity] Failed reading SQLite conversation ${cascadeId}:`, err);
    return undefined;
  }
}

/**
 * Inspects a child subagent's SQLite conversation database to determine whether
 * the child conversation is actively running, provably terminal, or unknown.
 */
export function inspectChildSqliteTerminalState(
  childId: string,
  candidateDbDirs: string[],
): 'running' | 'terminal' | 'unknown' {
  for (const dir of candidateDbDirs) {
    if (!dir) continue;
    const dbPath = join(dir, `${childId}.db`);
    if (!existsSync(dbPath)) continue;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db
          .prepare('SELECT idx, step_type, status, has_subtrajectory, task_details FROM steps ORDER BY idx ASC')
          .all() as Array<{
          idx: number;
          step_type: number;
          status: number;
          has_subtrajectory: number;
          task_details: Buffer | null;
        }>;
        if (rows.length === 0) return 'unknown';

        const activeTaskIds = new Map<string, boolean>();
        for (const row of rows) {
          const active = isCortexStatusActive(row.status);
          if (active) {
            return 'running';
          }
          if (row.task_details) {
            const td = decodeProtobufTaskDetails(Buffer.from(row.task_details));
            if (td.id) {
              const parts = td.id.split('/');
              const rawId = (parts.length === 2 ? parts[1] : parts[0]).toLowerCase();
              if (/^task-\d+$/.test(rawId)) {
                activeTaskIds.set(rawId, active);
              }
            }
          }
        }
        for (const [, isActive] of activeTaskIds) {
          if (isActive) return 'running';
        }

        const lastRow = rows[rows.length - 1];
        if (isCortexStatusTerminal(lastRow.status)) {
          return 'terminal';
        }
        return 'unknown';
      } finally {
        db.close();
      }
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}
