import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface HarnessSessionInfo {
  port: number;
  apiKey: string;
  ws: WebSocket;
  process: ChildProcess;
}

export interface EngineConfig {
  binaryPath?: string;
  protoDir?: string;
  env?: Record<string, string>;
  appDataDir?: string;
}

export class AntigravityEngine {
  private protoRoot?: protobuf.Root;
  private binaryPath: string;
  private protoDir: string;

  constructor(config: EngineConfig = {}) {
    this.binaryPath = config.binaryPath || path.resolve(__dirname, '../bin/localharness.exe');
    this.protoDir = config.protoDir || path.resolve(__dirname, '../proto');
  }

  async loadProtos(): Promise<protobuf.Root> {
    if (this.protoRoot) return this.protoRoot;

    const root = new protobuf.Root();
    const protoFile = path.join(this.protoDir, 'handshake.proto');
    this.protoRoot = await root.load(protoFile, { keepCase: false });
    return this.protoRoot;
  }

  async spawnSession(options: {
    workspaces?: string[];
    appDataDir?: string;
    env?: Record<string, string>;
  } = {}): Promise<HarnessSessionInfo> {
    const root = await this.loadProtos();
    const InputConfig = root.lookupType('antigravity.localharness.InputConfig');
    const OutputConfig = root.lookupType('antigravity.localharness.OutputConfig');

    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`localharness binary not found at: ${this.binaryPath}`);
    }

    const envMap: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(options.env || {})
    };

    const proc = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: envMap
    });

    // Capture stderr for diagnostics.
    proc.stderr.on('data', (chunk: Buffer) => {
      console.error('[localharness stderr]', chunk.toString('utf8'));
    });

    const clientInfo = {
      language: 'nodejs',
      version: '0.1.0',
      languageVersion: process.version,
      os: process.platform,
      osVersion: process.release?.name || ''
    };

    const inputMsg = InputConfig.create({
      storageDirectory: '',
      clientInfo,
      env: options.env || {}
    });

    const serialized = InputConfig.encode(inputMsg).finish();
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(serialized.length, 0);

    // Send 4-byte uint32LE prefix + Protobuf payload to stdin
    proc.stdin.write(Buffer.concat([lenBuf, Buffer.from(serialized)]));

    // Read 4-byte uint32LE prefix + OutputConfig from stdout
    const handshakePromise = new Promise<{ port: number; apiKey: string }>((resolve, reject) => {
      let chunks: Buffer[] = [];
      let totalLen: number | null = null;

      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        const combined = Buffer.concat(chunks);

        if (totalLen === null && combined.length >= 4) {
          totalLen = combined.readUInt32LE(0);
        }

        if (totalLen !== null && combined.length >= 4 + totalLen) {
          proc.stdout.off('data', onData);
          const payload = combined.subarray(4, 4 + totalLen);
          try {
            const decoded = OutputConfig.decode(payload) as any;
            resolve({
              port: decoded.port,
              apiKey: decoded.apiKey || decoded.api_key || ''
            });
          } catch (err) {
            reject(err);
          }
        }
      };

      proc.stdout.on('data', onData);

      proc.on('error', (err) => reject(err));
      proc.on('exit', (code) => {
        reject(new Error(`localharness process exited unexpectedly with code ${code}`));
      });
    });

    const { port, apiKey } = await handshakePromise;

    // Connect WebSocket
    const wsUrl = `ws://127.0.0.1:${port}/`;
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, {
        headers: { 'x-goog-api-key': apiKey },
        maxPayload: 100 * 1024 * 1024
      });

      socket.on('open', () => resolve(socket));
      socket.on('error', (err) => reject(err));
    });

    return {
      port,
      apiKey,
      ws,
      process: proc
    };
  }
}
