import { z } from 'zod';
import { message } from '../util.js';

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
export type Tool = {
  name: string; description: string; effect: 'read' | 'write' | 'execute'; schema: z.ZodTypeAny;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; additionalProperties: false; required?: string[] };
  run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  maxOutputCharacters?: number;
};
export class Registry {
  private tools = new Map<string, Tool>();
  constructor(private confirm: (name: string, args: unknown, signal?: AbortSignal) => Promise<boolean> = async () => false) {}
  add(tool: Tool): this {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool); return this;
  }
  list(): Tool[] { return [...this.tools.values()]; }
  async call(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    try {
      signal?.throwIfAborted();
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const args = tool.schema.parse(input) as Record<string, unknown>;
      if (tool.effect !== 'read' && !await this.confirm(name, args, signal)) throw new Error('Operation denied by application policy');
      signal?.throwIfAborted();
      const result = await tool.run(args, signal);
      const text = JSON.stringify(result);
      const limit = tool.maxOutputCharacters ?? 12000;
      if (text.length > limit) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'Tool result exceeds output limit; request a smaller result', truncated: true }) }] };
      return { content: [{ type: 'text', text }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message(error).slice(0, 2000) }) }] }; }
  }
}
