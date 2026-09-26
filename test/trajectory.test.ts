import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import {
  CORTEX_ACTIVE_STATUS_CODES,
  CORTEX_TERMINAL_STATUS_CODES,
  isCortexStatusActive,
  isCortexStatusTerminal,
  getStepEffectiveStatus,
  parseStructuredTrajectoryTasks,
  decodeProtobufTaskDetails,
  readStructuredTasksFromSqlite,
} from '../src/hub/trajectory.js';

describe('Structured Trajectory & SQLite Task Tracking (Phase 2)', () => {
  describe('CortexStepStatus Mapping', () => {
    it('correctly maps active status codes and names', () => {
      // Numerical codes: 1 (PENDING), 2 (RUNNING), 8 (GENERATING), 9 (WAITING), 11 (QUEUED)
      for (const code of [1, 2, 8, 9, 11]) {
        expect(isCortexStatusActive(code)).toBe(true);
        expect(isCortexStatusTerminal(code)).toBe(false);
      }
      expect(isCortexStatusActive('RUNNING')).toBe(true);
      expect(isCortexStatusActive('CORTEX_STEP_STATUS_RUNNING')).toBe(true);
      expect(isCortexStatusActive('WAITING')).toBe(true);
      expect(isCortexStatusActive('2')).toBe(true);
    });

    it('correctly maps terminal status codes and names', () => {
      // Numerical codes: 3 (DONE), 5 (CLEARED), 6 (CANCELED), 7 (ERROR), 12 (INTERRUPTED)
      for (const code of [3, 5, 6, 7, 12]) {
        expect(isCortexStatusTerminal(code)).toBe(true);
        expect(isCortexStatusActive(code)).toBe(false);
      }
      expect(isCortexStatusTerminal('DONE')).toBe(true);
      expect(isCortexStatusTerminal('CORTEX_STEP_STATUS_DONE')).toBe(true);
      expect(isCortexStatusTerminal('CANCELLED')).toBe(true);
      expect(isCortexStatusTerminal('ERROR')).toBe(true);
      expect(isCortexStatusTerminal('3')).toBe(true);
    });
  });

  describe('getStepEffectiveStatus', () => {
    it('returns initial step status when statusTransitions is empty', () => {
      const step = { status: 2 };
      expect(getStepEffectiveStatus(step).status).toBe(2);
      expect(getStepEffectiveStatus(step).isActive).toBe(true);
    });

    it('returns latest transition status from metadata.internalMetadata.statusTransitions', () => {
      const step = {
        status: 2, // initially RUNNING
        metadata: {
          internalMetadata: {
            statusTransitions: [
              { updatedStatus: 2, timestamp: '2026-09-27T00:00:00Z' },
              { updatedStatus: 3, timestamp: '2026-09-27T00:01:00Z' }, // transitioned to DONE
            ],
          },
        },
      };
      expect(getStepEffectiveStatus(step).status).toBe(3);
      expect(getStepEffectiveStatus(step).isTerminal).toBe(true);
    });

    it('returns latest transition status from snake_case internal_metadata', () => {
      const step = {
        status: 'RUNNING',
        metadata: {
          internal_metadata: {
            status_transitions: [
              { updatedStatus: 'DONE', timestamp: '2026-09-27T00:01:00Z' },
            ],
          },
        },
      };
      expect(getStepEffectiveStatus(step).status).toBe('DONE');
      expect(getStepEffectiveStatus(step).isTerminal).toBe(true);
    });
  });

  describe('parseStructuredTrajectoryTasks', () => {
    it('parses active and terminal tasks without regex reliance', () => {
      const resp = {
        trajectory: {
          cascadeId: 'target-cid',
          steps: [
            {
              stepIndex: 1,
              status: 2, // RUNNING
              taskDetails: {
                id: 'target-cid/task-101',
                description: 'pnpm test',
                logUri: 'file:///log1.txt',
              },
            },
            {
              stepIndex: 2,
              status: 2, // RUNNING
              taskDetails: {
                id: 'target-cid/task-102',
                description: 'build project',
              },
              metadata: {
                internalMetadata: {
                  statusTransitions: [
                    { updatedStatus: 3 }, // transitioned to DONE (terminal)
                  ],
                },
              },
            },
            {
              stepIndex: 3,
              status: 2, // RUNNING
              taskDetails: {
                id: 'other-cid/task-999', // foreign cascade
                description: 'foreign task',
              },
            },
          ],
        },
      };

      const result = parseStructuredTrajectoryTasks(resp, 'target-cid');
      expect(result.allTasks).toHaveLength(2);
      expect(result.activeTasks).toHaveLength(1);
      expect(result.activeTasks[0].taskId).toBe('task-101');
      expect(result.activeTasks[0].description).toBe('pnpm test');
      expect(result.hasActiveChildren).toBe(false);
    });

    it('detects active subagents (hasActiveChildren)', () => {
      const resp = {
        trajectory: {
          cascadeId: 'target-cid',
          steps: [
            {
              stepIndex: 1,
              type: 127, // Subagent step type
              status: 2, // RUNNING
            },
          ],
        },
      };

      const result = parseStructuredTrajectoryTasks(resp, 'target-cid');
      expect(result.hasActiveChildren).toBe(true);
    });

    it('detects hasActiveChildren from trajectory metadata flag', () => {
      const resp = {
        trajectory: {
          cascadeId: 'target-cid',
          hasActiveChildren: true,
          steps: [],
        },
      };

      const result = parseStructuredTrajectoryTasks(resp, 'target-cid');
      expect(result.hasActiveChildren).toBe(true);
    });
  });

  describe('decodeProtobufTaskDetails', () => {
    it('decodes binary protobuf task_details accurately', () => {
      // Construct a valid protobuf buffer with:
      // Field 1 (id): "target-cid/task-42" (tag: 0x0A)
      // Field 2 (log_uri): "file:///logs/task.log" (tag: 0x12)
      // Field 3 (description): "run test suite" (tag: 0x1A)
      const idStr = Buffer.from('target-cid/task-42', 'utf8');
      const uriStr = Buffer.from('file:///logs/task.log', 'utf8');
      const descStr = Buffer.from('run test suite', 'utf8');

      const buf = Buffer.concat([
        Buffer.from([0x0a, idStr.length]),
        idStr,
        Buffer.from([0x12, uriStr.length]),
        uriStr,
        Buffer.from([0x1a, descStr.length]),
        descStr,
      ]);

      const decoded = decodeProtobufTaskDetails(buf);
      expect(decoded.id).toBe('target-cid/task-42');
      expect(decoded.log_uri).toBe('file:///logs/task.log');
      expect(decoded.description).toBe('run test suite');
    });
  });

  describe('readStructuredTasksFromSqlite', () => {
    it('reads structured tasks and subagents from SQLite database', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'agy-db-test-'));
      const dbPath = join(tempDir, 'test-cid.db');

      try {
        const db = new DatabaseSync(dbPath);
        db.exec(`
          CREATE TABLE steps (
            idx integer PRIMARY KEY,
            step_type integer NOT NULL DEFAULT 0,
            status integer NOT NULL DEFAULT 0,
            has_subtrajectory numeric NOT NULL DEFAULT 0,
            metadata blob,
            error_details blob,
            permissions blob,
            task_details blob,
            render_info blob,
            step_payload blob,
            step_format integer NOT NULL DEFAULT 0
          );
        `);

        // Task 1: active (status = 2)
        const id1 = Buffer.from('test-cid/task-1', 'utf8');
        const desc1 = Buffer.from('active background job', 'utf8');
        const blob1 = Buffer.concat([
          Buffer.from([0x0a, id1.length]),
          id1,
          Buffer.from([0x1a, desc1.length]),
          desc1,
        ]);

        // Task 2: finished (status = 3)
        const id2 = Buffer.from('test-cid/task-2', 'utf8');
        const desc2 = Buffer.from('finished job', 'utf8');
        const blob2 = Buffer.concat([
          Buffer.from([0x0a, id2.length]),
          id2,
          Buffer.from([0x1a, desc2.length]),
          desc2,
        ]);

        const insert = db.prepare(`
          INSERT INTO steps (idx, step_type, status, has_subtrajectory, task_details)
          VALUES (?, ?, ?, ?, ?)
        `);

        insert.run(1, 0, 2, 0, blob1);
        insert.run(2, 0, 3, 0, blob2);
        // Step 3: active subagent
        insert.run(3, 127, 2, 1, null);

        db.close();

        const result = readStructuredTasksFromSqlite('test-cid', tempDir);
        expect(result).toBeDefined();
        expect(result!.allTasks).toHaveLength(2);
        expect(result!.activeTasks).toHaveLength(1);
        expect(result!.activeTasks[0].taskId).toBe('task-1');
        expect(result!.activeTasks[0].description).toBe('active background job');
        expect(result!.hasActiveChildren).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('verifies real SQLite conversation DB if present', () => {
      const realCid = '84b2a576-3cdb-4add-b05f-05675911acdd';
      const realPath = join('C:/Users/JoyJ/.gemini/antigravity/conversations', `${realCid}.db`);
      if (!existsSync(realPath)) return;

      const result = readStructuredTasksFromSqlite(realCid);
      expect(result).toBeDefined();
      expect(result!.allTasks.length).toBeGreaterThan(10);
      expect(result!.activeTasks).toEqual([]);
      expect(result!.hasActiveChildren).toBe(false);
    });
  });
});
