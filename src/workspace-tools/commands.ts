import type { TerminalUI } from '../terminal.js';
import { workspaceRegistry } from '../tools/workspace.js';
import { localToolDefinitions } from './definitions.js';
import type { WorkspaceTools } from './service.js';

export function listWorkspaceTools(ui: TerminalUI): void {
  ui.rule('WORKSPACE TOOLS / OFFLINE OR MCP');
  for (const tool of localToolDefinitions) {
    ui.fields(tool.name, { effect: tool.effect, description: tool.description });
    ui.body(JSON.stringify(tool.inputSchema, null, 2));
  }
}
export async function runTerminalTool(name: string, json: string, service: WorkspaceTools, ui: TerminalUI, writable: boolean, signal?: AbortSignal): Promise<unknown> {
  let args: unknown;
  try { args = JSON.parse(json); } catch { throw new Error('Tool arguments must be a JSON object'); }
  const registry = workspaceRegistry((tool, input) => service.call(tool, input, {
    origin: 'user', writable, signal,
    confirm: async (operation, details) => { ui.fields(operation === 'project_check' ? 'RUN PROJECT CHECK' : 'TASK CHANGES', details as Record<string, unknown>); return true; },
  }));
  const result = await registry.call(name, args);
  const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
  if (result.isError) throw new Error(String(data.error));
  ui.rule(name); ui.body(JSON.stringify(data, null, 2));
  return data;
}
