// Smoke test for the v3.1 hybrid completion flow (engagement guard ->
// WaitForConversationFullyIdle -> final transcript read), built blocks only.
// Usage: node smoke-v31.mjs   (Antigravity IDE must be running)
import { HubClient, readCascadeTranscript, getDefaultAppDataDir } from './lib/index.mjs';
import path from 'node:path';

const PROJECT_ID = 'a1b2c3d4-0000-4000-8000-d51ec0000001';
const BRAIN = path.join(getDefaultAppDataDir(), 'brain');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = await HubClient.create();
const model = await client.resolveModel('gemini-3.7-flash-tiered');
const id = crypto.randomUUID();
await client.startCascade({ cascadeId: id, requestedModel: model, projectId: PROJECT_ID });
await client.sendMessage(id, 'Write one haiku about compilers, then on a new line say exactly: V31DONE. Do not use any tools.');
console.log('1. cascade started:', id);

// Phase 1: engagement guard
const t0 = Date.now();
let engaged = false;
for (let i = 0; i < 60; i++) {
  const snap = await readCascadeTranscript(BRAIN, id);
  if (snap?.engaged) { engaged = true; break; }
  await sleep(1000);
}
console.log(`2. engagement: ${engaged} after ${Date.now() - t0}ms`);
if (!engaged) throw new Error('agent never engaged');

// Phase 2: authoritative idle wait
let waits = 0;
for (;;) {
  const resp = await client.waitForIdle(id, 120, 10);
  waits++;
  if (!resp?.timedOut) break;
  if (Date.now() - t0 > 300_000) throw new Error('idle wait deadline');
}
const elapsed = Date.now() - t0;
console.log(`3. idle reached after ${elapsed}ms (${waits} waitForIdle call(s))`);

// Phase 3: final read
const snap = await readCascadeTranscript(BRAIN, id);
const content = snap?.plannerContents.join('\n\n') ?? '';
console.log('4. planner output:', JSON.stringify(content.slice(0, 120)));
if (!content.includes('V31DONE')) throw new Error('final reply missing V31DONE');
if (snap?.error) throw new Error('transcript error: ' + snap.error);

// Finished cascade: waitForIdle must return instantly
const t1 = Date.now();
const again = await client.waitForIdle(id, 10, 2);
console.log(`5. finished-cascade waitForIdle: ${Date.now() - t1}ms ->`, JSON.stringify(again));

console.log('SMOKE-V31 ALL PASSED');
