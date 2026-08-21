import { AntigravityAgent } from './lib/index.mjs';

async function main() {
  console.log('Testing full agent flow...');
  const agent = new AntigravityAgent();

  agent.on('step', (step) => {
    console.log('[STEP]', step.status, step.content || (step.thought ? `(Thought: ${step.thought})` : ''));
  });

  agent.on('error', (err) => {
    console.error('[ERROR]', err);
  });

  agent.on('rawEvent', (e) => {
    if (e.toolCall) {
      console.log('[TOOL CALL]', e.toolCall);
    }
  });

  try {
    console.log('Starting agent session...');
    await agent.start({
      systemInstructions: 'You are a helpful assistant. Reply concisely.'
    });

    console.log('Sending prompt: "Hello from DeepSeek Harness bridge!"');
    await agent.sendPrompt('Hello from DeepSeek Harness bridge! Reply in one short sentence.');

    // Wait 15 seconds to receive tokens
    await new Promise((r) => setTimeout(r, 15000));

    await agent.close();
    console.log('Test completed.');
  } catch (e) {
    console.error('Fatal error:', e);
    await agent.close();
  }
}

main();
