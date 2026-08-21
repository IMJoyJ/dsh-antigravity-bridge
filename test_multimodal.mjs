import { fileToMedia, normalizePromptParts, AntigravityAgent } from './lib/index.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';

async function main() {
  console.log('--- 1. Testing fileToMedia helper ---');
  const sampleFilePath = path.resolve('./package.json');
  const media = await fileToMedia(sampleFilePath, { description: 'Bridge package.json file' });

  console.log('✓ File read and converted to media:');
  console.log('  MIME type:', media.mimeType);
  console.log('  Description:', media.description);
  console.log('  Base64 data length:', media.data.length);

  console.log('\n--- 2. Testing normalizePromptParts ---');
  const parts = await normalizePromptParts([
    'Please inspect this configuration file:',
    media
  ]);

  console.log(`✓ Normalized into ${parts.length} parts:`);
  console.log('  Part 0 (Text):', parts[0].text);
  console.log('  Part 1 (Media):', parts[1].media?.mimeType, `(data bytes: ${parts[1].media?.data.length})`);

  console.log('\n--- 3. Testing Multimodal sendPrompt with agent ---');
  const agent = new AntigravityAgent();

  agent.on('step', (step) => {
    if (step.content) {
      console.log('[STEP CONTENT]', step.content);
    }
  });

  agent.on('error', (err) => {
    console.error('[ERROR]', err);
  });

  try {
    await agent.start({
      systemInstructions: 'You are a concise code assistant.'
    });

    console.log('Sending prompt with attached package.json...');
    await agent.sendPrompt([
      'What is the package name in the attached file? Answer in one short sentence.',
      media
    ]);

    // Wait 10 seconds for response
    await new Promise((r) => setTimeout(r, 10000));
    await agent.close();
    console.log('✓ Multimodal test completed.');
  } catch (err) {
    console.error('✗ Multimodal test error:', err);
    await agent.close();
  }
}

main();
