import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromJson, toBinary } from '@bufbuild/protobuf';
import { encodeGrpcWebFrame, grpcWebCall, HubTransportError } from '../src/hub/transport.js';
import type { GrpcWebCallOptions } from '../src/hub/transport.js';
import { getHubRegistry } from '../src/hub/registry.js';
import { HubClient, isStaleHubError } from '../src/hub/client.js';

const discoveryMocks = vi.hoisted(() => ({
  discoverHub: vi.fn(),
  clearHubCache: vi.fn(),
}));
vi.mock('../src/hub/discovery.js', () => discoveryMocks);

const SERVICE = 'exa.language_server_pb.LanguageServerService';
const FRESH_HUB_INFO = { address: '127.0.0.1:9604', csrfToken: 'fresh-csrf' };

/** Encodes a minimal but valid GetAvailableModels response body. */
function modelsResponseBody(): Uint8Array {
  const reg = getHubRegistry();
  const svc = reg.getService(SERVICE);
  if (!svc) throw new Error('hub registry missing LanguageServerService');
  const method = svc.methods.find((m) => m.name === 'GetAvailableModels');
  if (!method) throw new Error('hub registry missing GetAvailableModels');
  const msg = fromJson(
    method.output,
    { response: { models: { 'gemini-test': { displayName: 'Test Model' } } } } as never,
  );
  return encodeGrpcWebFrame(toBinary(method.output, msg));
}

function trailerFrame(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0x80;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

function connectionRefusedError(): TypeError {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9604'), { code: 'ECONNREFUSED' }),
  });
}

async function callGetModels(address = '127.0.0.1:9604', csrf = 'csrf', options?: GrpcWebCallOptions): Promise<unknown> {
  return grpcWebCall(getHubRegistry(), address, csrf, SERVICE, 'GetAvailableModels', {}, options);
}

describe('grpcWebCall transport guards', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws HubTransportError (http) on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401, statusText: 'Unauthorized' })));
    await expect(callGetModels()).rejects.toMatchObject({
      name: 'HubTransportError',
      kind: 'http',
      status: 401,
    } satisfies Partial<HubTransportError>);
  });

  it('throws HubTransportError (empty) on a frame-less 200 when emptyResponse is reject', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(0), { status: 200 })));
    await expect(callGetModels('127.0.0.1:9604', 'csrf', { emptyResponse: 'reject' })).rejects.toMatchObject({
      name: 'HubTransportError',
      kind: 'empty',
    } satisfies Partial<HubTransportError>);
  });

  it('decodes a frame-less 200 as an empty message by default (empty-tolerant methods)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(0), { status: 200 })));
    await expect(callGetModels()).resolves.toEqual({});
  });

  it('decodes a normal data frame into the response JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(modelsResponseBody() as unknown as BodyInit, { status: 200 })));
    await expect(callGetModels()).resolves.toEqual({
      response: { models: { 'gemini-test': { displayName: 'Test Model' } } },
    });
  });

  it('throws the grpc error for a non-OK trailer', async () => {
    const body = trailerFrame('grpc-status: 5\r\ngrpc-message: not found\r\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body as unknown as BodyInit, { status: 200 })));
    await expect(callGetModels()).rejects.toThrow('gRPC error 5: not found');
  });
});

describe('isStaleHubError', () => {
  it('matches fetch failures whose ECONNREFUSED lives in the cause', () => {
    expect(isStaleHubError(connectionRefusedError())).toBe(true);
  });

  it('matches AggregateError causes with an inner ECONNREFUSED', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9604'), { code: 'ECONNREFUSED' });
    const err = new TypeError('fetch failed', { cause: new AggregateError([inner], 'multiple') });
    expect(isStaleHubError(err)).toBe(true);
  });

  it('matches the legacy 401 / Unauthenticated message conventions', () => {
    expect(isStaleHubError(new Error('HTTP 401'))).toBe(true);
    expect(isStaleHubError(new Error('gRPC error 16: Unauthenticated'))).toBe(true);
  });

  it('matches HubTransportError instances', () => {
    expect(isStaleHubError(new HubTransportError('boom', 'empty'))).toBe(true);
  });

  it('rejects ordinary errors and non-Error values', () => {
    expect(isStaleHubError(new Error('gRPC error 5: not found'))).toBe(false);
    expect(isStaleHubError(new Error('GetAvailableModels returned an unexpected shape'))).toBe(false);
    expect(isStaleHubError('fetch failed')).toBe(false);
    expect(isStaleHubError(undefined)).toBe(false);
  });
});

describe('HubClient self-healing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    discoveryMocks.discoverHub.mockReset();
    discoveryMocks.clearHubCache.mockReset();
  });

  it('rediscovers the hub once and retries after a connection-refused fetch failure', async () => {
    let fetchCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCalls++;
      if (fetchCalls === 1) throw connectionRefusedError();
      return new Response(modelsResponseBody() as unknown as BodyInit, { status: 200 });
    }));
    discoveryMocks.clearHubCache.mockReturnValue(undefined);
    discoveryMocks.discoverHub.mockResolvedValue(FRESH_HUB_INFO);

    const client = new HubClient({ address: '127.0.0.1:1', csrfToken: 'stale' });
    await expect(client.getAvailableModels()).resolves.toEqual({
      response: { models: { 'gemini-test': { displayName: 'Test Model' } } },
    });
    expect(discoveryMocks.clearHubCache).toHaveBeenCalledTimes(1);
    expect(discoveryMocks.discoverHub).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toBe(2);
  });

  it('rediscovers the hub once when GetAvailableModels answers 200 with no gRPC frame', async () => {
    let fetchCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCalls++;
      if (fetchCalls === 1) return new Response(new Uint8Array(0), { status: 200 });
      return new Response(modelsResponseBody() as unknown as BodyInit, { status: 200 });
    }));
    discoveryMocks.clearHubCache.mockReturnValue(undefined);
    discoveryMocks.discoverHub.mockResolvedValue(FRESH_HUB_INFO);

    const client = new HubClient({ address: '127.0.0.1:9604', csrfToken: 'stale-csrf' });
    await expect(client.getAvailableModels()).resolves.toEqual({
      response: { models: { 'gemini-test': { displayName: 'Test Model' } } },
    });
    expect(discoveryMocks.discoverHub).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toBe(2);
  });

  it('does not rediscover on ordinary gRPC errors', async () => {
    const body = trailerFrame('grpc-status: 5\r\ngrpc-message: not found\r\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body as unknown as BodyInit, { status: 200 })));

    const client = new HubClient({ address: '127.0.0.1:9604', csrfToken: 'csrf' });
    await expect(client.getAvailableModels()).rejects.toThrow('gRPC error 5: not found');
    expect(discoveryMocks.clearHubCache).not.toHaveBeenCalled();
    expect(discoveryMocks.discoverHub).not.toHaveBeenCalled();
  });
});
