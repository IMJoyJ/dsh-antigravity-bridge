import { createMutableRegistry } from '@bufbuild/protobuf';
import { fileDesc } from '@bufbuild/protobuf/codegenv2';
import { PACKED_FILES } from './descriptors.gen.js';

let registry: ReturnType<typeof createMutableRegistry> | undefined;

export function getHubRegistry() {
  if (registry) return registry;
  const built = new Map<string, ReturnType<typeof fileDesc>>();
  for (const f of PACKED_FILES) {
    built.set(f.name, fileDesc(f.b64, f.deps.map((d) => built.get(d)!)));
  }
  registry = createMutableRegistry();
  for (const f of built.values()) {
    // MutableRegistry.addFile exists at runtime but is not in public TS types
    (registry as any).addFile(f);
  }
  return registry;
}
