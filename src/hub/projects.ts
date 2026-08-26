import crypto from 'crypto';
import { fromBinary, toJson } from '@bufbuild/protobuf';
import type { HubClient } from './client.js';
import type { HubInfo } from './discovery.js';
import { getHubRegistry } from './registry.js';
import { encodeGrpcWebFrame, parseGrpcWebFrames } from './transport.js';

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
  projectId: string;
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

      if (!res.body) return;
      const reader = res.body.getReader();
      const { value } = await reader.read();
      reader.cancel().catch(() => {});

      if (!value) return;
      let projectIds: string[] = [];
      for (const f of parseGrpcWebFrames(value)) {
        if (!(f.flag & 0x80)) {
          const msg = fromBinary(method.output, f.data);
          const json = toJson(method.output, msg) as { projectList?: { projectIds?: string[] } };
          if (json?.projectList?.projectIds) {
            projectIds = json.projectList.projectIds;
          }
        }
      }

      // Fetch metadata for all project IDs concurrently
      const fetched = await Promise.all(
        projectIds.map(async (id) => {
          try {
            const resp = (await this.client.call('ReadProject', { id })) as { project?: HubProject };
            if (resp?.project) return resp.project;
          } catch {
            // Project might be stale or not readable
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
      // Hub streaming failed or unauthenticated; fallback quietly
    }
  }

  /**
   * Resolves a folder path, URI, or project UUID:
   * 1. If it is an existing registered project UUID -> returns that project;
   * 2. If it matches an existing registered project's workspace folder -> returns the first matching project;
   * 3. If not matched -> automatically creates a new project on the hub and returns its new UUID.
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
        const resp = (await this.client.call('ReadProject', { id: raw })) as { project?: HubProject };
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

    // Check if any existing project matches this workspace folder (first hit)
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

    // 3. Not found -> Automatically create a new project on the hub
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
    this.cache.set(newId, newProject);

    return {
      projectId: newId,
      workspaceUri: targetFolderUri,
      projectName: folderName,
      created: true,
    };
  }
}
