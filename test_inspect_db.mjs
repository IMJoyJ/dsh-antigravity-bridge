import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const agyDir = path.join(os.homedir(), '.gemini', 'antigravity');
const dbPath = path.join(agyDir, 'conversations', '3121d686-55a3-416d-a857-718188a3d2f4.db');

try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables in DB:', tables);

  for (const t of tables) {
    const info = db.prepare(`PRAGMA table_info(${t.name})`).all();
    console.log(`\nTable [${t.name}] schema:`, info);
    const count = db.prepare(`SELECT count(*) as cnt FROM ${t.name}`).get();
    console.log(`Table [${t.name}] row count:`, count);
    const samples = db.prepare(`SELECT * FROM ${t.name} LIMIT 2`).all();
    console.log(`Table [${t.name}] samples:`, samples);
  }
} catch (e) {
  console.error('Error inspecting sqlite:', e);
}
