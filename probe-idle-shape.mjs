// Probe WaitForConversationFullyIdle: request shape + method kind.
import { createMutableRegistry } from '@bufbuild/protobuf';
import { fileDesc } from '@bufbuild/protobuf/codegenv2';
import { PACKED_FILES } from './src/hub/descriptors.gen.ts';

const built = new Map();
for (const f of PACKED_FILES) built.set(f.name, fileDesc(f.b64, f.deps.map((d) => built.get(d))));
const reg = createMutableRegistry();
for (const f of built.values()) reg.addFile(f);

for (const name of [
  'exa.language_server_pb.WaitForConversationFullyIdleRequest',
  'exa.language_server_pb.WaitForConversationFullyIdleResponse',
]) {
  try {
    const msg = reg.getMessage(name);
    console.log('==', name);
    for (const f of msg.fields) {
      const t = f.fieldKind === 'scalar' ? f.scalar : f.fieldKind === 'enum' ? 'enum:' + f.enum?.name : f.fieldKind === 'message' ? 'msg:' + f.message?.name : f.fieldKind;
      console.log(`  ${f.name} (${t}${f.repeated ? ' repeated' : ''})`);
    }
  } catch (e) {
    console.log('==', name, 'NOT FOUND:', e.message);
  }
}
try {
  const svc = reg.getService('exa.language_server_pb.LanguageServerService');
  const m = svc.methods['WaitForConversationFullyIdle'] ?? svc.methods['waitForConversationFullyIdle'];
  console.log('== method:', m ? `${m.name} in=${m.input.name} out=${m.output.name} clientStream=${m.clientStreaming} serverStream=${m.serverStreaming}` : 'not found');
} catch (e) {
  console.log('service error:', e.message);
}
