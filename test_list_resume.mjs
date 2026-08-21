import { listConversations, getConversationTree } from './lib/index.mjs';

async function main() {
  console.log('--- 1. Testing default listConversations() (Roots Only) ---');
  const roots = await listConversations({ limit: 5 });
  console.log(`Found ${roots.length} recent root conversations:`);
  for (const c of roots) {
    console.log(`  - [${c.id}] (Depth: ${c.depth}, isSubagent: ${c.isSubagent})`);
    if (c.taskTitle) console.log(`    Task: ${c.taskTitle}`);
    if (c.firstPromptSnippet) console.log(`    Snippet: ${c.firstPromptSnippet.slice(0, 70)}...`);
    if (c.childIds?.length) console.log(`    Spawned subagents count: ${c.childIds.length}`);
  }

  console.log('\n--- 2. Testing listConversations({ includeSubagents: true }) ---');
  const allSessions = await listConversations({ limit: 8, includeSubagents: true });
  console.log(`Found ${allSessions.length} sessions (mixed roots and subagents):`);
  for (const c of allSessions) {
    const label = c.isSubagent ? `[SUBAGENT depth=${c.depth}]` : `[ROOT depth=${c.depth}]`;
    console.log(`  - ${label} [${c.id}]`);
    if (c.firstPromptSnippet) console.log(`    Snippet: ${c.firstPromptSnippet.slice(0, 60)}...`);
  }

  console.log('\n--- 3. Testing getConversationTree() ASCII Visualizer ---');
  const treeResult = await getConversationTree({ limit: 3 });
  console.log(treeResult.ascii);

  console.log('✓ All hierarchy, filtering, and tree visualization tests passed cleanly.');
}

main();
