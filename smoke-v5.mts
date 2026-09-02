// Smoke v0.2.2: folder-bound start with default sidebarVisible -> source UNSPECIFIED.
import { HubClient } from './lib/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const client = await HubClient.create();
const model = await client.resolveModel('gemini-3.8-flash-high');

const id = crypto.randomUUID();
const resp = await client.startCascade({
  cascadeId: id,
  requestedModel: model,
  workspaceUri: 'file:///d:/VSProjects/CloudPortal',
  // sidebarVisible omitted -> should default to UNSPECIFIED
});
console.log('[start] resp =', JSON.stringify(resp).slice(0, 200));
await client.sendMessage(id, 'Reply with the single word: PONG (smoke v0.2.2)');

let ok = false;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const t = path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
  if (fs.existsSync(t)) {
    const lines = fs.readFileSync(t, 'utf8').split('\n').filter(Boolean);
    const hasPlannerText = lines.some(l => {
      try { const s = JSON.parse(l); return s.type === 'PLANNER_RESPONSE' && s.status === 'DONE' && s.content && !(s.tool_calls?.length); } catch { return false; }
    });
    if (hasPlannerText) {
      ok = true;
      const meta = await client.getConversationMetadata(id);
      console.log('[metadata]', JSON.stringify(meta).slice(0, 600));
      console.log('[smoke] real planner reply detected ✅');
      break;
    }
  }
}
if (!ok) { console.log('[smoke] no planner reply in 30s ❌'); process.exit(1); }
console.log('[done]');
