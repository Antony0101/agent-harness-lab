import { Registry } from './registry.js';
import { requestWorkspaceOperation } from './approval-ipc.js';
import { localToolDefinitions } from '../workspace-tools/definitions.js';

// Both MCP and the direct terminal adapter call the same parent handlers. Only
// that parent decides authorization; the child has no local execution handlers.
export function workspaceRegistry(call: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown> = requestWorkspaceOperation): Registry {
  const registry = new Registry(async () => true);
  for (const definition of localToolDefinitions) registry.add({ ...definition, run: (args, signal) => call(definition.name, args, signal) });
  return registry;
}
