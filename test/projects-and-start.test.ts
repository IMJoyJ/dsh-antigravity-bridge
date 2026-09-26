import { describe, expect, it, vi } from 'vitest';
import { HubClient } from '../src/hub/client.js';
import { ProjectResolver, normalizeFolderUri, toFolderUri } from '../src/hub/projects.js';

describe('ProjectResolver & normalizeFolderUri', () => {
  it('normalizes folder URIs across platform styles', () => {
    expect(normalizeFolderUri('D:\\Git\\deepseek-harness\\')).toBe('file:///d:/git/deepseek-harness');
    expect(normalizeFolderUri('file:///D:/Git/deepseek-harness/')).toBe('file:///d:/git/deepseek-harness');
    expect(normalizeFolderUri('file:///c%3A/Users/JoyJ/repo')).toBe('file:///c:/users/joyj/repo');
  });

  it('resolves exact match and prefix subdirectories to existing projects', async () => {
    const mockClient = {
      call: vi.fn(),
    } as unknown as HubClient;

    const resolver = new ProjectResolver(mockClient);
    const cache = (resolver as unknown as { cache: Map<string, unknown> }).cache;

    cache.set('proj-123', {
      id: 'proj-123',
      name: 'deepseek-harness',
      projectResources: {
        resources: [
          { folderUri: 'file:///D:/Git/deepseek-harness' },
        ],
      },
    });

    // Exact match
    const exact = await resolver.resolveOrCreateProject('D:/Git/deepseek-harness');
    expect(exact.projectId).toBe('proj-123');
    expect(exact.projectName).toBe('deepseek-harness');

    // Prefix match (subdirectory inside workspace)
    const sub = await resolver.resolveOrCreateProject('D:/Git/deepseek-harness/packages/core/src');
    expect(sub.projectId).toBe('proj-123');
    expect(sub.projectName).toBe('deepseek-harness');
    expect(sub.created).toBe(false);
  });
});

describe('HubClient.startCascade payload handling', () => {
  it('sends projectEnvConfig when projectId is provided (agy 2.15.1 sidebar compatibility)', async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const client = new HubClient({ address: '127.0.0.1:9999', csrfToken: 'test' });
    vi.spyOn(client, 'call').mockImplementation(async (method: string, body: unknown) => {
      calls.push({ method, body });
      return { cascadeId: 'casc-123' };
    });

    await client.startCascade({
      cascadeId: 'casc-123',
      requestedModel: 'gemini-3.8-flash-high',
      projectId: 'proj-123',
      workspaceUri: 'file:///d:/git/test',
    });

    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('StartCascade');
    const payload = calls[0].body as Record<string, unknown>;
    expect(payload.projectEnvConfig).toEqual({
      projectId: 'proj-123',
      defaultProjectEnvironment: {},
    });
    // workspaceUris MUST NOT be present when projectEnvConfig is sent
    expect(payload.workspaceUris).toBeUndefined();
    expect(payload.source).toBe('CORTEX_TRAJECTORY_SOURCE_JETBOX');
  });

  it('falls back to workspaceUris if projectId call is rejected with empty response', async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const client = new HubClient({ address: '127.0.0.1:9999', csrfToken: 'test' });
    let attempt = 0;
    vi.spyOn(client, 'call').mockImplementation(async (method: string, body: unknown) => {
      calls.push({ method, body });
      attempt++;
      if (attempt === 1) {
        return {}; // Hub rejected unpersisted projectId
      }
      return { cascadeId: 'casc-123' };
    });

    await client.startCascade({
      cascadeId: 'casc-123',
      requestedModel: 'gemini-3.8-flash-high',
      projectId: 'stale-proj-uuid',
      workspaceUri: 'file:///d:/git/test',
    });

    expect(calls.length).toBe(2);
    // First attempt had projectEnvConfig
    expect((calls[0].body as Record<string, unknown>).projectEnvConfig).toBeDefined();
    // Second attempt fell back to workspaceUris
    const secondPayload = calls[1].body as Record<string, unknown>;
    expect(secondPayload.projectEnvConfig).toBeUndefined();
    expect(secondPayload.workspaceUris).toEqual(['file:///d:/git/test']);
  });

  it('sends workspaceUris directly when no projectId is provided', async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const client = new HubClient({ address: '127.0.0.1:9999', csrfToken: 'test' });
    vi.spyOn(client, 'call').mockImplementation(async (method: string, body: unknown) => {
      calls.push({ method, body });
      return { cascadeId: 'casc-123' };
    });

    await client.startCascade({
      cascadeId: 'casc-123',
      requestedModel: 'gemini-3.8-flash-high',
      workspaceUri: 'file:///d:/git/test',
    });

    expect(calls.length).toBe(1);
    const payload = calls[0].body as Record<string, unknown>;
    expect(payload.projectEnvConfig).toBeUndefined();
    expect(payload.workspaceUris).toEqual(['file:///d:/git/test']);
  });
});
