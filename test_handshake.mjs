import { AntigravityEngine } from './lib/index.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('Testing AntigravityEngine spawn & handshake...');
  const engine = new AntigravityEngine({
    binaryPath: path.resolve(__dirname, 'bin/localharness.exe'),
    protoDir: path.resolve(__dirname, 'proto')
  });

  try {
    const session = await engine.spawnSession({
      workspaces: ['D:/Git/dsh_plugins/dsh-antigravity-bridge']
    });

    console.log('✓ Handshake success!');
    console.log('  Port:', session.port);
    console.log('  ApiKey length:', session.apiKey.length);
    console.log('  WebSocket readyState:', session.ws.readyState);

    session.ws.close();
    session.process.kill();
    console.log('✓ Test passed cleanly.');
  } catch (err) {
    console.error('✗ Test failed:', err);
    process.exit(1);
  }
}

main();
