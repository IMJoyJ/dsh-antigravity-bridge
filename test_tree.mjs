import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function buildHierarchy(appDataDir) {
  const brainDir = path.join(appDataDir, 'brain');
  const convDir = path.join(appDataDir, 'conversations');

  const files = await fs.readdir(convDir);
  const dbFiles = files.filter(f => f.endsWith('.db'));

  const sessions = new Map();

  for (const file of dbFiles) {
    const id = file.replace(/\.db$/, '');
    const brainPath = path.join(brainDir, id);
    const transcriptPath = path.join(brainPath, '.system_generated', 'logs', 'transcript.jsonl');
    const taskMdPath = path.join(brainPath, 'task.md');

    let firstPromptSnippet = '';
    let taskTitle = '';
    let hasConvoHistory = false;
    const childIds = [];

    try {
      const taskContent = await fs.readFile(taskMdPath, 'utf8');
      const firstHeader = taskContent.split('\n').find(l => l.startsWith('# '));
      if (firstHeader) taskTitle = firstHeader.replace(/^#\s*/, '').trim();
    } catch {}

    try {
      const content = await fs.readFile(transcriptPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);

      for (let i = 0; i < Math.min(lines.length, 5); i++) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.type === 'CONVERSATION_HISTORY') hasConvoHistory = true;
          if (parsed.type === 'USER_INPUT' && parsed.content && !firstPromptSnippet) {
            let raw = parsed.content;
            const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (match) raw = match[1];
            firstPromptSnippet = raw.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 100);
          }
        } catch {}
      }

      // Find invoke_subagent child conversationIds in whole transcript
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

    const stat = await fs.stat(path.join(convDir, file)).catch(() => ({ mtime: new Date(0), mtimeMs: 0 }));

    sessions.set(id, {
      id,
      lastModified: stat.mtime.toISOString(),
      lastModifiedTimestamp: stat.mtimeMs,
      firstPromptSnippet,
      taskTitle,
      hasConvoHistory,
      childIds,
      parentId: null,
      depth: 0
    });
  }

  // Link children to parents
  for (const [parentId, session] of sessions) {
    for (const childId of session.childIds) {
      if (sessions.has(childId)) {
        sessions.get(childId).parentId = parentId;
      }
    }
  }

  // Calculate depths recursively
  function getDepth(id, visited = new Set()) {
    if (visited.has(id)) return 0;
    visited.add(id);
    const s = sessions.get(id);
    if (!s || !s.parentId || !sessions.has(s.parentId)) return 0;
    return 1 + getDepth(s.parentId, visited);
  }

  for (const [id, session] of sessions) {
    session.depth = getDepth(id);
    session.isSubagent = session.depth > 0 || (!session.hasConvoHistory && !!session.parentId);
  }

  return sessions;
}

async function main() {
  const agyDir = path.join(os.homedir(), '.gemini', 'antigravity');
  const sessions = await buildHierarchy(agyDir);

  const list = Array.from(sessions.values()).sort((a, b) => b.lastModifiedTimestamp - a.lastModifiedTimestamp);

  console.log(`Total sessions analyzed: ${list.length}`);
  const roots = list.filter(s => !s.parentId);
  console.log(`Root conversations: ${roots.length}`);
  const subagents = list.filter(s => s.parentId);
  console.log(`Subagents: ${subagents.length}\n`);

  console.log('--- Top 5 Recent Root Conversations & Subagent Trees ---');
  for (const root of roots.slice(0, 5)) {
    printTree(root, sessions, '');
    console.log();
  }
}

function printTree(node, sessions, prefix) {
  const tag = node.depth === 0 ? '📦 [ROOT]' : `🧩 [DEPTH ${node.depth}]`;
  const title = node.taskTitle ? ` (Task: ${node.taskTitle})` : '';
  const snippet = node.firstPromptSnippet ? ` "${node.firstPromptSnippet.slice(0, 60)}..."` : '';
  console.log(`${prefix}${tag} ${node.id}${title}${snippet}`);

  const children = (node.childIds || [])
    .filter(id => sessions.has(id))
    .map(id => sessions.get(id));

  for (let i = 0; i < children.length; i++) {
    const isLast = i === children.length - 1;
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    const branch = isLast ? '└── ' : '├── ';
    process.stdout.write(prefix + branch);
    printTree(children[i], sessions, childPrefix);
  }
}

main();
