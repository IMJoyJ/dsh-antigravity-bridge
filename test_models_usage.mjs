import {
  ANTIGRAVITY_MODELS,
  normalizeModelName,
  AntigravityAgent
} from './lib/index.mjs';

async function main() {
  console.log('--- 1. Testing Model Catalog & Alias Normalization ---');
  console.log(`Registered models count: ${ANTIGRAVITY_MODELS.length}`);
  for (const m of ANTIGRAVITY_MODELS) {
    console.log(`  - [${m.id}] (${m.name}) | Group: ${m.group} | Context: ${m.contextWindow}`);
    console.log(`    Aliases: ${m.aliases.join(', ')}`);
    console.log(`    Note: ${m.description}`);
  }

  console.log('\n--- 2. Testing normalizeModelName helper ---');
  const testAliases = ['flash', '3.7-flash', 'opus', 'opus-4.6', 'pro', 'unknown-model'];
  for (const alias of testAliases) {
    console.log(`  "${alias}"  ==>  "${normalizeModelName(alias)}"`);
  }

  console.log('\n--- 3. Testing AntigravityAgent with explicit model & token usage ---');
  const agent = new AntigravityAgent();

  agent.on('usage', (usage) => {
    console.log('✓ Received real-time usage update:');
    console.log(`  Prompt tokens: ${usage.promptTokens}, Thought tokens: ${usage.thoughtsTokens}, Candidates tokens: ${usage.candidatesTokens}, Total: ${usage.totalTokens}`);
  });

  agent.on('step', (step) => {
    if (step.content) {
      console.log(`[MODEL CONTENT] ${step.content.slice(0, 100)}...`);
    }
  });

  try {
    await agent.start({
      model: 'gemini-3.7-flash'
    });

    console.log(`✓ Agent started with model: ${agent.model}`);
    await agent.sendPrompt('Calculate 12345 * 67890. Answer with only the result number.');

    // Wait 8 seconds
    await new Promise(r => setTimeout(r, 8000));
    console.log('✓ Final latestUsage snapshot:', agent.latestUsage);
    await agent.close();
    console.log('✓ Models & usage test passed.');
  } catch (err) {
    console.error('✗ Test error:', err);
    await agent.close();
  }
}

main();
