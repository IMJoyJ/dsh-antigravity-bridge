// Smoke: built lib — folder-bound StartCascade via workspaceUri + empty-response rejection.
import { HubClient } from './lib/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const client = await HubClient.create();
const model = await client.resolveModel('gemini-3.7-flash-tiered');

// 1. folder-bound start succeeds
const id1 = crypto.randomUUID();
const resp1 = await client.startCascade({ cascadeId: id1, requestedModel: model, workspaceUri: 'file:///d:/VSProjects/CloudPortal' });
console.log('[folder-bound] resp =', JSON.stringify(resp1).slice(0, 200));
await client.sendMessage(id1, 'Reply with the single word: PONG (smoke folder-bound)');
let ok = false;
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 1000));
  if (fs.existsSync(path.join(brainDir, id1))) { ok = true; console.log(`[folder-bound] brain dir after ${i + 1}s ✅`); break; }
}
if (!ok) { console.log('[folder-bound] no brain dir ❌'); process.exit(1); }

// 2. bogus projectId now throws instead of silently no-op
let threw = false;
try {
  await client.startCascade({ cascadeId: crypto.randomUUID(), requestedModel: model, projectId: crypto.randomUUID() });
} catch (e) {
  threw = true;
  console.log('[bogus-project] threw as expected ✅:', e.message.slice(0, 120));
}
if (!threw) { console.log('[bogus-project] did NOT throw ❌'); process.exit(1); }

// 3. createProject honestly reports non-persistence
try {
  const r = await client.createProject('smoke-nonpersist', 'file:///d:/VSProjects/CloudPortal');
  console.log('[createProject] unexpectedly persisted:', JSON.stringify(r));
} catch (e) {
  console.log('[createProject] honest error ✅:', e.message.slice(0, 120));
}
console.log('[smoke done]');
