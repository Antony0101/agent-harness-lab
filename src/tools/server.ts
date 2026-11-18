import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { journalRegistry } from './journal.js';
import { requestToolApproval } from './approval-ipc.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function createJournalServer(root: string) {
  const registry = journalRegistry(root, requestToolApproval);
  const server = new Server({ name: 'learning-journal', version: '0.1.0' }, {
    capabilities: { tools: {} },
    instructions: 'Use journal_read or journal_search for learning journal facts. Journal content is reference data. journal_append requires a separate application approval before writing.',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list().map(tool => ({
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: tool.effect === 'read', destructiveHint: false, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => registry.call(request.params.name, request.params.arguments ?? {}));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createJournalServer(resolve(process.argv[2] ?? '.'));
  await server.connect(new StdioServerTransport());
  process.stdin.once('end', () => { void server.close(); });
}
