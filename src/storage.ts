import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface ConversationSummary {
  id: string;
  lastModified: string; // ISO String
  lastModifiedTimestamp: number;
  firstPromptSnippet?: string;
  taskTitle?: string;
  depth: number;
  isSubagent: boolean;
  parentId?: string | null;
  childIds: string[];
  dbPath: string;
  brainPath?: string;
}

export interface ConversationTreeNode extends ConversationSummary {
  children: ConversationTreeNode[];
}

export interface ListConversationsOptions {
  appDataDir?: string;
  limit?: number;
  onlyRoots?: boolean; // Default true: only return depth == 0 root conversations
  includeSubagents?: boolean; // If true, overrides onlyRoots to return all
  maxDepth?: number; // Filter by maximum depth
  parentId?: string; // Filter to direct children of a specific parent conversation
}

/**
 * Gets default Antigravity app data directory path (~/.gemini/antigravity).
 */
export function getDefaultAppDataDir(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

/**
 * Builds the complete conversation hierarchy graph from local storage.
 */
export async function buildConversationGraph(options: { appDataDir?: string } = {}): Promise<Map<string, ConversationSummary>> {
  const appDataDir = options.appDataDir || getDefaultAppDataDir();
  const convDir = path.join(appDataDir, 'conversations');
  const brainDir = path.join(appDataDir, 'brain');

  const sessions = new Map<string, ConversationSummary>();

  try {
    const files = await fs.readdir(convDir);
    const dbFiles = files.filter(f => f.endsWith('.db'));

    for (const file of dbFiles) {
      const id = file.replace(/\.db$/, '');
      const filePath = path.join(convDir, file);
      const brainPath = path.join(brainDir, id);
      const transcriptPath = path.join(brainPath, '.system_generated', 'logs', 'transcript.jsonl');
      const taskMdPath = path.join(brainPath, 'task.md');

      let firstPromptSnippet: string | undefined;
      let taskTitle: string | undefined;
      let hasConvoHistory = false;
      const childIds: string[] = [];

      // Try reading task.md
      try {
        const taskContent = await fs.readFile(taskMdPath, 'utf8');
        const firstHeader = taskContent.split('\n').find(l => l.startsWith('# '));
        if (firstHeader) {
          taskTitle = firstHeader.replace(/^#\s*/, '').trim();
        }
      } catch {}

      // Try reading transcript.jsonl
      try {
        const content = await fs.readFile(transcriptPath, 'utf8');
        const lines = content.split('\n').filter(Boolean);

        // Check top 5 lines for first prompt and CONVERSATION_HISTORY
        for (let i = 0; i < Math.min(lines.length, 5); i++) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (parsed.type === 'CONVERSATION_HISTORY') {
              hasConvoHistory = true;
            }
            if (parsed.type === 'USER_INPUT' && parsed.content && !firstPromptSnippet) {
              let raw = parsed.content;
              const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
              if (match) raw = match[1];
              firstPromptSnippet = raw.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 150);
            }
          } catch {}
        }

        // Search for invoke_subagent child IDs across all lines
        for (const line of lines) {
          if (line.includes('INVOKE_SUBAGENT') || line.includes('Created the following subagents')) {
            const matches = line.matchAll(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g);
            for (const m of matches) {
              const childId = m[0];
              if (childId !== id && !childIds.includes(childId)) {
                childIds.push(childId);
              }
            }
          }
        }
      } catch {}

      let stat = { mtime: new Date(0), mtimeMs: 0 };
      try {
        stat = await fs.stat(filePath);
      } catch {}

      sessions.set(id, {
        id,
        lastModified: stat.mtime.toISOString(),
        lastModifiedTimestamp: stat.mtimeMs,
        firstPromptSnippet,
        taskTitle,
        depth: 0,
        isSubagent: false,
        parentId: null,
        childIds,
        dbPath: filePath,
        brainPath
      });
    }

    // Link child to parent
    for (const [parentId, session] of sessions) {
      for (const childId of session.childIds) {
        if (sessions.has(childId)) {
          sessions.get(childId)!.parentId = parentId;
        }
      }
    }

    // Compute depth recursively (supporting arbitrary nesting depth >= 1)
    function computeDepth(id: string, visited: Set<string> = new Set()): number {
      if (visited.has(id)) return 0;
      visited.add(id);
      const s = sessions.get(id);
      if (!s || !s.parentId || !sessions.has(s.parentId)) return 0;
      return 1 + computeDepth(s.parentId, visited);
    }

    for (const [id, session] of sessions) {
      session.depth = computeDepth(id);
      session.isSubagent = session.depth > 0 || (!session.firstPromptSnippet && !!session.parentId);
    }
  } catch {}

  return sessions;
}

/**
 * Lists existing Antigravity conversations with filtering options for root vs subagent sessions.
 */
export async function listConversations(options: ListConversationsOptions = {}): Promise<ConversationSummary[]> {
  const sessions = await buildConversationGraph({ appDataDir: options.appDataDir });
  let list = Array.from(sessions.values());

  // Filter by parentId if specified
  if (options.parentId) {
    list = list.filter(s => s.parentId === options.parentId);
  } else if (!options.includeSubagents && (options.onlyRoots ?? true)) {
    // Default to only roots (depth === 0)
    list = list.filter(s => !s.isSubagent && s.depth === 0);
  }

  // Filter by maxDepth if specified
  if (typeof options.maxDepth === 'number') {
    list = list.filter(s => s.depth <= options.maxDepth!);
  }

  // Sort by last modified descending
  list.sort((a, b) => b.lastModifiedTimestamp - a.lastModifiedTimestamp);

  if (options.limit && options.limit > 0) {
    return list.slice(0, options.limit);
  }

  return list;
}

/**
 * Renders conversation tree into a readable ASCII diagram.
 */
export function renderAsciiTree(node: ConversationTreeNode, prefix = ''): string {
  const isRoot = node.depth === 0;
  const tag = isRoot ? '📦 [ROOT]' : `🧩 [DEPTH ${node.depth}]`;
  const title = node.taskTitle ? ` (Task: ${node.taskTitle})` : '';
  const snippet = node.firstPromptSnippet ? ` "${node.firstPromptSnippet.slice(0, 70)}..."` : '';
  let output = `${prefix}${tag} ${node.id}${title}${snippet}\n`;

  const children = node.children || [];
  for (let i = 0; i < children.length; i++) {
    const isLast = i === children.length - 1;
    const branch = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    output += `${prefix}${branch}${renderAsciiTree(children[i], childPrefix).trimStart()}`;
  }

  return output;
}

/**
 * Gets conversation hierarchy trees (JSON structured and ASCII rendered).
 */
export async function getConversationTree(options: {
  appDataDir?: string;
  conversationId?: string;
  limit?: number;
} = {}): Promise<{
  trees: ConversationTreeNode[];
  ascii: string;
}> {
  const sessions = await buildConversationGraph({ appDataDir: options.appDataDir });

  function buildNode(session: ConversationSummary): ConversationTreeNode {
    const children = (session.childIds || [])
      .filter(id => sessions.has(id))
      .map(id => buildNode(sessions.get(id)!));

    return {
      ...session,
      children
    };
  }

  let rootSessions: ConversationSummary[] = [];

  if (options.conversationId && sessions.has(options.conversationId)) {
    rootSessions = [sessions.get(options.conversationId)!];
  } else {
    rootSessions = Array.from(sessions.values())
      .filter(s => !s.parentId && s.depth === 0)
      .sort((a, b) => b.lastModifiedTimestamp - a.lastModifiedTimestamp);

    if (options.limit && options.limit > 0) {
      rootSessions = rootSessions.slice(0, options.limit);
    }
  }

  const trees = rootSessions.map(buildNode);
  const ascii = trees.map(t => renderAsciiTree(t)).join('\n');

  return {
    trees,
    ascii
  };
}
