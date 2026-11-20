import { localToolDefinitions } from '../workspace-tools/definitions.js';
import { memoryRegistry } from '../tools/memory.js';
import { journalRegistry } from '../tools/journal.js';
import type { ToolCard } from './model.js';

const examples: Record<string, unknown> = {
  workspace_search: { query: 'recall' }, git_inspect: { operation: 'status' }, project_check: {}, todo_list: {},
  todo_update: { revision: 0, changes: [{ operation: 'add', title: 'Learn the harness' }] },
};
export function toolCatalog(root: string): ToolCard[] {
  return [...localToolDefinitions, ...memoryRegistry().list(), ...journalRegistry(root).list()].map(tool => ({
    name: tool.name, description: tool.description, effect: tool.effect,
    example: `${tool.name in examples ? `Direct terminal command\n/tool ${tool.name} ${JSON.stringify(examples[tool.name])}`
      : tool.name.startsWith('memory_') ? 'Available to Codex via MCP. Use the Memory view or /memory for direct access.'
        : 'Available to Codex via MCP. Legacy journal tools remain available during migration.'}\n\nInput schema\n${JSON.stringify(tool.inputSchema, null, 2)}`,
  }));
}
