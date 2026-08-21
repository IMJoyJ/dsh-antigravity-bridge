import type { DescMethod } from '@bufbuild/protobuf';
import { create, toBinary, fromBinary, toJson, fromJson } from '@bufbuild/protobuf';
import type { Registry } from '@bufbuild/protobuf';

export interface GrpcWebFrame {
  flag: number;
  data: Uint8Array;
}

export function encodeGrpcWebFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0x00;
  const view = new DataView(frame.buffer, frame.byteOffset);
  view.setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

export function* parseGrpcWebFrames(buffer: Uint8Array): Generator<GrpcWebFrame> {
  let pos = 0;
  while (pos + 5 <= buffer.length) {
    const flag = buffer[pos];
    const view = new DataView(buffer.buffer, buffer.byteOffset + pos);
    const len = view.getUint32(1, false);
    if (pos + 5 + len > buffer.length) break;
    yield { flag, data: buffer.subarray(pos + 5, pos + 5 + len) };
    pos += 5 + len;
  }
}

export async function grpcWebCall(
  registry: Registry,
  address: string,
  csrfToken: string,
  serviceName: string,
  methodName: string,
  requestJson: Record<string, unknown>,
): Promise<unknown> {
  const svc = registry.getService(serviceName);
  if (!svc) throw new Error(`Service not found: ${serviceName}`);
  const method = svc.methods.find((m: DescMethod) => m.name === methodName);
  if (!method) throw new Error(`Method not found: ${methodName}`);

  const reqMsg = fromJson(method.input, requestJson as any);
  const payload = toBinary(method.input, reqMsg);
  const frame = encodeGrpcWebFrame(payload);

  const res = await fetch(`http://${address}/${serviceName}/${methodName}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      'x-codeium-csrf-token': csrfToken,
    },
    body: frame as unknown as BodyInit,
  });

  const body = new Uint8Array(await res.arrayBuffer());
  let messageData: Uint8Array | undefined;
  let trailerStatus = '0';
  let trailerMessage = '';

  for (const f of parseGrpcWebFrames(body)) {
    if (f.flag & 0x80) {
      const text = new TextDecoder().decode(f.data);
      const statusMatch = text.match(/grpc-status:\s*(\d+)/);
      if (statusMatch) trailerStatus = statusMatch[1];
      const msgMatch = text.match(/grpc-message:\s*([^\r\n]+)/);
      if (msgMatch) trailerMessage = decodeURIComponent(msgMatch[1]);
    } else {
      messageData = f.data;
    }
  }

  if (trailerStatus !== '0') {
    throw new Error(`gRPC error ${trailerStatus}: ${trailerMessage || 'unknown'}`);
  }
  // An OK response without a data frame is a valid empty message (the hub does
  // this for e.g. SendUserCascadeMessage on a running cascade): decode the
  // empty payload as the output type's default instance instead of throwing.
  const respMsg = fromBinary(method.output, messageData ?? new Uint8Array(0));
  try {
    return toJson(method.output, respMsg, { registry });
  } catch {
    // If toJson encounters an unregistered Any typeUrl or invalid encoding,
    // fallback gracefully so the RPC call doesn't throw a fake error.
    return respMsg;
  }
}

export async function* callServerStream(
  _registry: Registry,
  _address: string,
  _csrfToken: string,
  _serviceName: string,
  _methodName: string,
  _requestJson: Record<string, unknown>,
): AsyncGenerator<unknown> {
  throw new Error('Server-streaming not yet implemented');
}
