import { HubClient } from './lib/index.mjs';
import { fromJson, toBinary, fromBinary, toJson } from '@bufbuild/protobuf';

const client = await HubClient.create({
  address: '127.0.0.1:7778',
  csrfToken: 'b4d14c85-5ac9-4b6b-9b28-d8049591bedb',
});
const reg = client.registry;
const info = client.info;

const svc = reg.getService('exa.language_server_pb.LanguageServerService');
const method = svc.methods.find(m => m.name === 'GetCascadeTrajectory');

const reqMsg = fromJson(method.input, { cascadeId: 'ed414fea-72d4-4342-bb12-c28df96874e8' });
const payload = toBinary(method.input, reqMsg);

const frame = new Uint8Array(5 + payload.length);
new DataView(frame.buffer).setUint32(1, payload.length, false);
frame.set(payload, 5);

const res = await fetch(`http://${info.address}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory`, {
  method: 'POST',
  headers: {
    'content-type': 'application/grpc-web+proto',
    'x-grpc-web': '1',
    'x-codeium-csrf-token': info.csrfToken,
  },
  body: frame,
});

const body = new Uint8Array(await res.arrayBuffer());
let pos = 0;
let messageData;
while (pos + 5 <= body.length) {
  const flag = body[pos];
  const len = new DataView(body.buffer, body.byteOffset + pos).getUint32(1, false);
  if (!(flag & 0x80)) messageData = body.subarray(pos + 5, pos + 5 + len);
  pos += 5 + len;
}

const respMsg = fromBinary(method.output, messageData);
const steps = respMsg.trajectory?.steps;
console.log(`Total steps: ${steps.length}`);
console.log("Last 5 steps summary:");
for (let i = steps.length - 5; i < steps.length; i++) {
  const s = steps[i];
  console.log(`[Step ${i}] type=${s.type}, status=${s.status}, keys=${Object.keys(s).filter(k => !k.startsWith('$'))}`);
}
