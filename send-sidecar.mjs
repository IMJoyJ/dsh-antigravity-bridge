// Sidecar: SendUserCascadeMessage to a running Antigravity cascade via grpc-web,
// bypassing the loaded bridge plugin (whose transport throws on empty OK frames).
// Usage: node send-sidecar.mjs <cascadeId> <textFile> <port> <csrf>
import { readFileSync } from 'node:fs';
import { createMutableRegistry, create, toBinary, fromJson } from '@bufbuild/protobuf';
import { fileDesc } from '@bufbuild/protobuf/codegenv2';
import { PACKED_FILES } from './src/hub/descriptors.gen.ts';

const [cascadeId, textFile, port, csrf] = process.argv.slice(2);
if (!cascadeId || !textFile || !port || !csrf) {
  console.error('usage: node send-sidecar.mjs <cascadeId> <textFile> <port> <csrf>');
  process.exit(2);
}

const built = new Map();
for (const f of PACKED_FILES) built.set(f.name, fileDesc(f.b64, f.deps.map((d) => built.get(d))));
const registry = createMutableRegistry();
for (const f of built.values()) registry.addFile(f);

const svc = registry.getService('exa.language_server_pb.LanguageServerService');
const method = svc.methods.find((m) => m.name === 'SendUserCascadeMessage');
const text = readFileSync(textFile, 'utf8');
const reqMsg = fromJson(method.input, { cascadeId, items: [{ text }] });
const payload = toBinary(method.input, reqMsg);
const frame = new Uint8Array(5 + payload.length);
new DataView(frame.buffer).setUint32(1, payload.length, false);
frame.set(payload, 5);

const res = await fetch(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`, {
  method: 'POST',
  headers: {
    'content-type': 'application/grpc-web+proto',
    'x-grpc-web': '1',
    'x-codeium-csrf-token': csrf,
  },
  body: frame,
});
const body = new Uint8Array(await res.arrayBuffer());
let status = '?', msg = '', frames = 0;
for (let pos = 0; pos + 5 <= body.length;) {
  const flag = body[pos];
  const len = new DataView(body.buffer, body.byteOffset + pos).getUint32(1, false);
  if (pos + 5 + len > body.length) break;
  const data = body.subarray(pos + 5, pos + 5 + len);
  if (flag & 0x80) {
    const t = new TextDecoder().decode(data);
    status = t.match(/grpc-status:\s*(\d+)/)?.[1] ?? status;
    msg = decodeURIComponent(t.match(/grpc-message:\s*([^\r\n]+)/)?.[1] ?? '');
  } else frames++;
  pos += 5 + len;
}
console.log(JSON.stringify({ httpStatus: res.status, grpcStatus: status, grpcMessage: msg, dataFrames: frames }));
