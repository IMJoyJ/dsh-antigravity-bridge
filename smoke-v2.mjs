// Live smoke test for the hub backend, exercising the built bundle.
// Usage: node smoke-v2.mjs   (Antigravity IDE must be running)
import { HubClient, pollTranscript, discoverHub, getDefaultAppDataDir } from './lib/index.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT_ID = 'a1b2c3d4-0000-4000-8000-d51ec0000001';
const BRAIN = path.join(getDefaultAppDataDir(), 'brain');

let step = 'discoverHub';
try {
  const hub = await discoverHub();
  console.log('1. discovery OK:', hub.address, 'csrf', hub.csrfToken.slice(0, 8) + '...');

  step = 'getAvailableModels';
  const client = await HubClient.create();
  const models = await client.getAvailableModels();
  const count = Object.keys(models.response.models).length;
  console.log('2. GetAvailableModels OK:', count, 'models');

  step = 'resolveModel';
  const placeholder = await client.resolveModel('gemini-3.7-flash-tiered');
  console.log('3. resolveModel OK:', placeholder);
  if (!placeholder) throw new Error('resolveModel returned undefined');

  step = 'createProject';
  const { projectId } = await client.createProject('dsh-smoke-tmp', pathToFileURL(process.cwd()).href);
  console.log('4. createProject OK:', projectId);

  step = 'deleteProject';
  await client.deleteProject(projectId);
  console.log('5. deleteProject OK');

  step = 'startCascade';
  const cascadeId = crypto.randomUUID();
  await client.startCascade({ cascadeId, requestedModel: placeholder, projectId: PROJECT_ID });
  console.log('6. startCascade OK:', cascadeId);

  step = 'sendMessage';
  await client.sendMessage(cascadeId, 'Reply with exactly the word: SMOKETEST. Do nothing else.');
  console.log('7. sendMessage OK');

  step = 'pollTranscript';
  const result = await pollTranscript(BRAIN, cascadeId, 120_000);
  console.log('8. pollTranscript:', JSON.stringify(result).slice(0, 300));
  if (result.error) throw new Error(result.error);
  if (!result.content.includes('SMOKETEST')) throw new Error('unexpected content: ' + result.content);

  console.log('\nALL SMOKE TESTS PASSED');
} catch (err) {
  console.error(`FAILED at ${step}:`, err.message || err);
  process.exit(1);
}
