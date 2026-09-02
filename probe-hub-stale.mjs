// Diagnostic probe: reproduce the "empty model list after Antigravity restart" issue.
// Run from the plugin root: node probe-hub-stale.mjs
import { pathToFileURL } from 'node:url';

const libUrl = new URL('./lib/index.mjs', import.meta.url).href;
const lib = await import(libUrl);

console.log('=== 1. Fresh discovery (clearHubCache + discoverHub) ===');
lib.clearHubCache();
const info = await lib.discoverHub({});
console.log('FRESH HUB INFO:', JSON.stringify(info));

console.log('\n=== 2. Fresh HubClient.getAvailableModels (correct csrf, live hub) ===');
const client = new lib.HubClient(info);
const resp = await client.getAvailableModels();
const models = resp?.response?.models ?? {};
console.log('TOP-LEVEL KEYS:', Object.keys(resp ?? {}));
console.log('MODEL COUNT:', Object.keys(models).length);
console.log('MODEL IDS:', Object.keys(models).slice(0, 8).join(', '));

console.log('\n=== 3. Raw fetch with WRONG csrf (simulates stale token after restart) ===');
const wrong = await fetch(`http://${info.address}/exa.language_server_pb.LanguageServerService/GetAvailableModels`, {
  method: 'POST',
  headers: {
    'content-type': 'application/grpc-web+proto',
    'x-grpc-web': '1',
    'x-codeium-csrf-token': '00000000-0000-0000-0000-000000000000',
  },
  body: Buffer.from([0, 0, 0, 0, 0]),
});
console.log('WRONG CSRF HTTP STATUS:', wrong.status, wrong.statusText);
const wrongBody = Buffer.from(await wrong.arrayBuffer());
console.log('WRONG CSRF BODY len=', wrongBody.length, 'head=', JSON.stringify(wrongBody.subarray(0, 160).toString('utf8')));

console.log('\n=== 4. Raw fetch to a dead port (simulates hub moved away) ===');
try {
  await fetch('http://127.0.0.1:59999/', { signal: AbortSignal.timeout(3000) });
  console.log('unexpected success');
} catch (e) {
  console.log('DEAD PORT err.name=', e?.name, '| err.message=', JSON.stringify(e?.message), '| err.cause?.message=', JSON.stringify(e?.cause?.message ?? e?.cause?.code));
}

console.log('\n=== 5. HubClient pointed at a dead address (tests reconnect path end-to-end) ===');
const dead = new lib.HubClient({ address: '127.0.0.1:59999', csrfToken: 'dead' });
try {
  const r = await dead.getAvailableModels();
  const n = Object.keys(r?.response?.models ?? {}).length;
  console.log('DEAD CLIENT CALL RETURNED models=', n, '(>0 means the heal path fired)');
} catch (e) {
  console.log('DEAD CLIENT CALL THREW:', e?.name, '|', JSON.stringify(e?.message));
}

console.log('\n=== 6. HubClient with a STALE csrf token on the live port (the reported bug) ===');
// Fresh hub info, but a client created with a bogus csrf token: before the fix
// this returned {} silently (hub answers stale-csrf with HTTP 200 + 0 bytes).
const stale = new lib.HubClient({ address: info.address, csrfToken: '00000000-0000-0000-0000-000000000000' });
try {
  const r = await stale.getAvailableModels();
  const n = Object.keys(r?.response?.models ?? {}).length;
  console.log('STALE CSRF CLIENT RETURNED models=', n, '(>0 means the heal path fired)');
} catch (e) {
  console.log('STALE CSRF CLIENT THREW:', e?.name, '|', JSON.stringify(e?.message));
}
