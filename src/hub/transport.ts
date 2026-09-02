import type { DescMethod } from '@bufbuild/protobuf';
import { create, toBinary, fromBinary, toJson, fromJson } from '@bufbuild/protobuf';
import type { Registry } from '@bufbuild/protobuf';

export interface GrpcWebFrame {
  flag: number;
  data: Uint8Array;
}

export type HubTransportErrorKind = 'http' | 'empty';

/**
 * Thrown when the hub answers at the HTTP layer instead of the gRPC-web layer:
 * a non-2xx status, or a 200 whose body carries no gRPC-web frame at all. The
 * hub answers requests with a stale CSRF token (e.g. after an Antigravity
 * restart) with exactly that second shape: HTTP 200 + zero bytes, which used
 * to silently decode into an empty response message.
 */
export class HubTransportError extends Error {
  constructor(
    message: string,
    readonly kind: HubTransportErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HubTransportError';
  }
}

export interface GrpcWebCallOptions {
  /** 'allow' (default): decode a frame-less 200 body as an empty message — the
   *  hub legitimately answers some methods (SendUserCascadeMessage,
   *  CreateProject, WaitForConversationFullyIdle) with an empty response.
   *  'reject': treat the frame-less body as a stale-endpoint signature and
   *  throw {@link HubTransportError} so the caller can rediscover the hub. */
  emptyResponse?: 'allow' | 'reject';
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
  options: GrpcWebCallOptions = {},
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

  if (!res.ok) {
    throw new HubTransportError(
      `Hub returned HTTP ${res.status} ${res.statusText} for ${methodName}`
      + ' (stale hub address or CSRF token after an Antigravity restart?)',
      'http',
      res.status,
    );
  }

  const body = new Uint8Array(await res.arrayBuffer());
  let messageData: Uint8Array | undefined;
  let trailerStatus = '0';
  let trailerMessage = '';
  let frameCount = 0;

  for (const f of parseGrpcWebFrames(body)) {
    frameCount++;
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
  if (frameCount === 0 && options.emptyResponse === 'reject') {
    throw new HubTransportError(
      `Hub returned HTTP 200 with no gRPC-web frame for ${methodName} — the signature of a stale CSRF`
      + ' token after an Antigravity hub restart; rediscover the hub and retry.',
      'empty',
    );
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
