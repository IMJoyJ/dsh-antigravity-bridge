import crypto from 'crypto';
import { fromBinary, toJson } from '@bufbuild/protobuf';
import type { HubClient } from './client.js';
import type { HubInfo } from './discovery.js';
import { getHubRegistry } from './registry.js';
import { encodeGrpcWebFrame } from './transport.js';

export interface ProjectResource {
  folderUri?: string;
  gitFolder?: {
    folderUri?: string;
    defaultBranch?: string;
  };
  google3?: unknown;
}

export interface HubProject {
  id: string;
  name: string;
  projectResources?: {
    resources?: ProjectResource[];
  };
  updatedAt?: string;
}

export interface ResolvedProject {
  /** Registered project UUID. Undefined when a freshly created project failed
   *  the hub persistence check — callers must then bind via {@link workspaceUri}. */
  projectId?: string;
  workspaceUri: string;
  projectName: string;
  created: boolean;
}

/**
 * Normalizes a file URI or local absolute path into a standard lower-case
 * file:/// URI for consistent comparisons across platforms.
 */
export function normalizeFolderUri(uri?: string): string {
  if (!uri) return '';
  let u = uri.trim().replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(u)) {
    u = 'file:///' + u;
  }
  // Decode %3A in drive letters, lowercase drive prefix, strip trailing slashes
  u = u.replace(/file:\/\/\/([A-Za-z])%3A/i, 'file:///$1:');
  u = u.replace(/file:\/\/\/([A-Za-z]):/i, (_, d) => `file:///${d.toLowerCase()}:`);
  u = u.replace(/\/+$/, '');
  return u.toLowerCase();
}

/**
 * Converts a string into a valid folder URI (file:///...) preserving original casing.
 */
export function toFolderUri(folderOrPath: string): string {
  const v = folderOrPath.trim();
  if (/^file:\/\//i.test(v)) return v;
  if (/^[A-Za-z]:[\\/]/.test(v)) return 'file:///' + v.replace(/\\/g, '/');
  if (v.startsWith('/')) return 'file://' + v;
  return 'file:///' + v.replace(/\\/g, '/');
}

export class ProjectResolver {
  private cache = new Map<string, HubProject>();
  private lastFetched = 0;
  private fetchPromise: Promise<void> | null = null;

  constructor(private client: HubClient) {}

  /** Invalidate the in-memory projects cache */
  invalidate(): void {
    this.cache.clear();
    this.lastFetched = 0;
  }

  /**
   * Fetches all registered project IDs from the hub stream and reads their full definitions.
   */
  async refreshProjects(info: HubInfo): Promise<void> {
    if (this.fetchPromise) return this.fetchPromise;
    this.fetchPromise = this.doRefreshProjects(info).finally(() => {
      this.fetchPromise = null;
    });
    return this.fetchPromise;
  }

  private async doRefreshProjects(info: HubInfo): Promise<void> {
    try {
      const reg = getHubRegistry();
      const svc = reg.getService('exa.language_server_pb.LanguageServerService');
      const method = svc?.methods.find((m) => m.name === 'ProjectUpdatesStream');
      if (!method) return;

      const frame = encodeGrpcWebFrame(new Uint8Array(0));
      const res = await fetch(`http://${info.address}/exa.language_server_pb.LanguageServerService/ProjectUpdatesStream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/grpc-web+proto',
          'x-grpc-web': '1',
          'x-codeium-csrf-token': info.csrfToken,
        },
        body: frame as unknown as BodyInit,
      });

      if (!res.ok) {
        console.warn(`[antigravity] ProjectUpdatesStream refresh: hub answered HTTP ${res.status}; keeping the previous project cache.`);
        return;
      }
      if (!res.body) return;

      // The hub sends the initial project snapshot split across an unknown
      // number of stream chunks (a single read() can end mid-frame and lose
      // every project id after it), then keeps the stream open forever —
      // so read-to-end would hang. Instead: accumulate chunks, decode every
      // complete frame, and stop on an idle gap once a projectIds message
      // has been seen (or when the stream itself ends).
      const reader = res.body.getReader();
      let buffer = new Uint8Array(0);
      let projectIds: string[] = [];
      let sawProjectIds = false;
      let ended = false;
      const deadline = Date.now() + 10_000;

      while (!ended && Date.now() < deadline) {
        const readPromise = reader.read();
        const idleMs = sawProjectIds ? 750 : 3000;
        let step: ReadableStreamReadResult<Uint8Array> | null = null;
        try {
          step = await Promise.race([
            readPromise,
            new Promise<null>((r) => setTimeout(() => r(null), idleMs)),
          ]);
        } catch (err) {
          console.warn('[antigravity] ProjectUpdatesStream read failed; keeping the previous project cache:', err);
          ended = true;
          break;
        }
        if (step === null) {
          if (sawProjectIds) break; // snapshot settled: idle gap reached
          continue; // still waiting for the snapshot within the overall deadline
        }
        if (step.done) { ended = true; break; }
        if (!step.value) continue;

        const merged = new Uint8Array(buffer.length + step.value.length);
        merged.set(buffer);
        merged.set(step.value, buffer.length);
        buffer = merged;

        let pos = 0;
        while (pos + 5 <= buffer.length) {
          const flag = buffer[pos];
          const len = ((buffer[pos + 1] << 24) | (buffer[pos + 2] << 16) | (buffer[pos + 3] << 8) | buffer[pos + 4]) >>> 0;
          if (pos + 5 + len > buffer.length) break;
          const data = buffer.subarray(pos + 5, pos + 5 + len);
          pos += 5 + len;
          if (flag & 0x80) { ended = true; continue; }
          try {
            const json = toJson(method.output, fromBinary(method.output, data)) as {
              projectList?: { projectIds?: string[] };
            };
            if (json?.projectList?.projectIds?.length) {
              projectIds = json.projectList.projectIds;
              sawProjectIds = true;
            }
          } catch (err) {
            console.warn('[antigravity] ProjectUpdatesStream: failed to decode a project frame:', err);
          }
        }
        buffer = buffer.subarray(pos);
      }
      if (!ended) reader.cancel().catch(() => {});

      if (projectIds.length === 0) {
        console.warn('[antigravity] ProjectUpdatesStream refresh decoded no project ids; keeping the previous project cache.');
        return;
      }

      // Fetch metadata for all project IDs concurrently
      const fetched = await Promise.all(
        projectIds.map(async (id) => {
          try {
            const resp = (await this.client.call('ReadProject', { id }, { emptyResponse: 'reject' })) as { project?: HubProject };
            if (resp?.project) return resp.project;
          } catch (err) {
            console.warn(`[antigravity] project cache refresh: ReadProject(${id}) failed, project skipped:`, err);
          }
          return undefined;
        }),
      );

      this.cache.clear();
      for (const p of fetched) {
        if (p?.id) this.cache.set(p.id, p);
      }
      this.lastFetched = Date.now();
    } catch (err) {
      // Hub streaming failed or unauthenticated; keep the previous cache instead
      // of silently pretending the refresh succeeded.
      console.warn('[antigravity] ProjectUpdatesStream refresh failed; keeping the previous project cache:', err);
    }
  }

  /**
   * Resolves a folder path, URI, or project UUID:
   * 1. If it is an existing registered project UUID -> returns that project;
   * 2. If it matches an existing registered project's workspace folder -> returns the first matching project;
   * 3. If not matched -> automatically creates a new project on the hub and returns its new UUID —
   *    but only after verifying the hub actually persisted it; when persistence fails,
   *    {@link ResolvedProject.projectId} is left undefined so callers bind the cascade
   *    to {@link ResolvedProject.workspaceUri} directly (workspaceUris on StartCascade).
   */
  async resolveOrCreateProject(folderOrId?: string, hubInfo?: HubInfo): Promise<ResolvedProject> {
    const raw = folderOrId?.trim() || '';
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);

    if (hubInfo && (Date.now() - this.lastFetched > 30_000 || this.cache.size === 0)) {
      await this.refreshProjects(hubInfo);
    }

    // 1. Direct UUID match
    if (isUuid) {
      const cached = this.cache.get(raw);
      if (cached) {
        const primaryUri = cached.projectResources?.resources?.[0]?.folderUri
          || cached.projectResources?.resources?.[0]?.gitFolder?.folderUri
          || '';
        return {
          projectId: cached.id,
          workspaceUri: primaryUri,
          projectName: cached.name || 'Project',
          created: false,
        };
      }
      try {
        const resp = (await this.client.call('ReadProject', { id: raw }, { emptyResponse: 'reject' })) as { project?: HubProject };
        if (resp?.project) {
          this.cache.set(resp.project.id, resp.project);
          const primaryUri = resp.project.projectResources?.resources?.[0]?.folderUri
            || resp.project.projectResources?.resources?.[0]?.gitFolder?.folderUri
            || '';
          return {
            projectId: resp.project.id,
            workspaceUri: primaryUri,
            projectName: resp.project.name || 'Project',
            created: false,
          };
        }
      } catch {
        // UUID not found on disk, continue to folder resolution/creation
      }
    }

    // 2. Target folder URI normalization & matching
    const targetFolderUri = toFolderUri(raw || process.cwd());
    const normTarget = normalizeFolderUri(targetFolderUri);

    // Check if any existing project matches this workspace folder (first exact hit)
    for (const [id, proj] of this.cache.entries()) {
      const resources = proj.projectResources?.resources || [];
      for (const r of resources) {
        const rUri = r.folderUri || r.gitFolder?.folderUri;
        if (rUri && normalizeFolderUri(rUri) === normTarget) {
          return {
            projectId: id,
            workspaceUri: rUri,
            projectName: proj.name || 'Project',
            created: false,
          };
        }
      }
    }

    // Prefix match: check if targetFolder is a subdirectory inside an existing registered workspace
    let bestPrefixMatch: { id: string; proj: HubProject; rUri: string; prefixLen: number } | null = null;
    for (const [id, proj] of this.cache.entries()) {
      const resources = proj.projectResources?.resources || [];
      for (const r of resources) {
        const rUri = r.folderUri || r.gitFolder?.folderUri;
        if (!rUri) continue;
        const normR = normalizeFolderUri(rUri);
        if (normTarget.startsWith(normR + '/')) {
          if (!bestPrefixMatch || normR.length > bestPrefixMatch.prefixLen) {
            bestPrefixMatch = { id, proj, rUri, prefixLen: normR.length };
          }
        }
      }
    }
    if (bestPrefixMatch) {
      return {
        projectId: bestPrefixMatch.id,
        workspaceUri: bestPrefixMatch.rUri,
        projectName: bestPrefixMatch.proj.name || 'Project',
        created: false,
      };
    }

    // 3. Not found -> Automatically create a new project on the hub. The hub
    // accepts CreateProject (grpc status 0) but does not persist every bare
    // RPC-created project (ReadProject then reports notFoundOnDisk), and a
    // StartCascade for such an id is silently no-op'ed. So verify persistence
    // before handing the id out; on failure fall back to folder binding.
    const newId = crypto.randomUUID();
    const rawPath = targetFolderUri.replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/');
    const folderName = rawPath.split('/').filter(Boolean).pop() || 'Workspace';

    const newProject: HubProject = {
      id: newId,
      name: folderName,
      projectResources: {
        resources: [
          {
            folderUri: targetFolderUri,
          },
        ],
      },
    };

    await this.client.call('CreateProject', { project: newProject });

    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      try {
        const resp = (await this.client.call('ReadProject', { id: newId }, { emptyResponse: 'reject' })) as
          | { project?: HubProject }
          | undefined;
        if (resp && typeof resp === 'object' && resp.project) {
          this.cache.set(newId, resp.project);
          return {
            projectId: newId,
            workspaceUri: targetFolderUri,
            projectName: folderName,
            created: true,
          };
        }
      } catch (err) {
        console.warn(`[antigravity] project persistence check attempt ${attempt + 1} failed for ${newId}:`, err);
      }
    }

    console.warn(
      `[antigravity] CreateProject accepted but "${folderName}" (${newId}) was never persisted on the hub; `
      + 'falling back to direct workspace binding (workspaceUris).',
    );
    return {
      projectId: undefined,
      workspaceUri: targetFolderUri,
      projectName: folderName,
      created: false,
    };
  }
}
