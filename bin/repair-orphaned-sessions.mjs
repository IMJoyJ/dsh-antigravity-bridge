#!/usr/bin/env node
/**
 * repair-orphaned-sessions.mjs
 *
 * Scans ~/.gemini/antigravity/conversation_summaries.db for conversations with empty
 * or missing project_id (orphaned sessions that Antigravity ≥ 2.15.1 hides from the sidebar).
 * Matches each conversation's workspace_uris against known registered projects and
 * updates project_id in the database so they appear in the IDE sidebar.
 *
 * Usage:
 *   node bin/repair-orphaned-sessions.mjs [--dry-run]
 */

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HubClient } from '../lib/index.mjs';

function normalizeFolderUri(uri) {
  if (!uri) return '';
  let u = uri.trim().replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(u)) {
    u = 'file:///' + u;
  }
  u = u.replace(/file:\/\/\/([A-Za-z])%3A/i, 'file:///$1:');
  u = u.replace(/file:\/\/\/([A-Za-z]):/i, (_, d) => `file:///${d.toLowerCase()}:`);
  u = u.replace(/\/+$/, '');
  return u.toLowerCase();
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const dbPath = process.env.AG_APP_DATA_DIR
    ? join(process.env.AG_APP_DATA_DIR, 'conversation_summaries.db')
    : join(homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');

  console.log(`[repair] Database: ${dbPath}`);
  const db = new DatabaseSync(dbPath);

  // 1. Collect projects from database first
  const projectMap = new Map(); // normUri -> projectId
  const existingRows = db.prepare(
    'SELECT DISTINCT project_id, workspace_uris FROM conversation_summaries WHERE length(project_id) > 0'
  ).all();

  for (const row of existingRows) {
    const pid = row.project_id;
    if (!pid) continue;
    try {
      const uris = JSON.parse(row.workspace_uris || '[]');
      for (const u of uris) {
        const norm = normalizeFolderUri(u);
        if (norm && !projectMap.has(norm)) {
          projectMap.set(norm, pid);
        }
      }
    } catch {}
  }

  // 2. Supplement with live Hub projects if reachable
  try {
    const client = await HubClient.create();
    const projResolver = client['projectResolver'];
    if (projResolver && client['info']) {
      await projResolver.refreshProjects(client['info']);
      const cache = projResolver['cache'];
      if (cache && cache.size > 0) {
        for (const [id, proj] of cache.entries()) {
          const resources = proj.projectResources?.resources || [];
          for (const r of resources) {
            const rUri = r.folderUri || r.gitFolder?.folderUri;
            if (rUri) {
              const norm = normalizeFolderUri(rUri);
              if (norm) projectMap.set(norm, id);
            }
          }
        }
      }
    }
  } catch (err) {
    console.log('[repair] Hub not reachable for extra project refresh, using DB project catalog.');
  }

  console.log(`[repair] Discovered ${projectMap.size} project workspace mappings.`);

  // 3. Find orphaned conversations
  const orphans = db.prepare(
    'SELECT conversation_id, project_id, workspace_uris, title FROM conversation_summaries WHERE project_id IS NULL OR length(project_id) = 0'
  ).all();

  console.log(`[repair] Found ${orphans.length} orphaned conversation(s).`);

  if (orphans.length === 0) {
    console.log('[repair] All conversations already have project_id set. Nothing to do!');
    return;
  }

  let repairedCount = 0;
  const updateStmt = db.prepare('UPDATE conversation_summaries SET project_id = ? WHERE conversation_id = ?');

  for (const row of orphans) {
    let matchedProjectId = null;
    let rawUris = [];
    try {
      rawUris = JSON.parse(row.workspace_uris || '[]');
    } catch {}

    for (const u of rawUris) {
      const norm = normalizeFolderUri(u);
      // Exact match
      if (projectMap.has(norm)) {
        matchedProjectId = projectMap.get(norm);
        break;
      }
      // Prefix match (folder inside project workspace)
      for (const [projUri, pid] of projectMap.entries()) {
        if (norm.startsWith(projUri + '/')) {
          matchedProjectId = pid;
          break;
        }
      }
      if (matchedProjectId) break;
    }

    if (matchedProjectId) {
      repairedCount++;
      const title = row.title ? `"${row.title.slice(0, 30)}..."` : '(untitled)';
      console.log(`  [${dryRun ? 'DRY-RUN' : 'REPAIR'}] ${row.conversation_id} (${title}) -> project ${matchedProjectId}`);
      if (!dryRun) {
        updateStmt.run(matchedProjectId, row.conversation_id);
      }
    } else {
      console.log(`  [SKIP] ${row.conversation_id}: no matching project found for ${row.workspace_uris}`);
    }
  }

  console.log(`\n[repair] Done! Repaired ${repairedCount}/${orphans.length} conversation(s).`);
  if (dryRun) {
    console.log('[repair] Note: Run without --dry-run to apply changes.');
  }
}

main().catch((err) => {
  console.error('[repair] Fatal error:', err);
  process.exit(1);
});
