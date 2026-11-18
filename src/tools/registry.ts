import { z } from 'zod';
import { message } from '../util.js';

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
export type Tool = {
  name: string; description: string; effect: 'read' | 'write'; schema: z.ZodTypeAny;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; additionalProperties: false; required?: string[] };
  run: (args: Record<string, unknown>) => Promise<unknown>;
};
export class Registry {
  private tools = new Map<string, Tool>();
  constructor(private confirm: (name: string, args: unknown) => Promise<boolean> = async () => false) {}
  add(tool: Tool): this {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool); return this;
  }
  list(): Tool[] { return [...this.tools.values()]; }
  async call(name: string, input: unknown): Promise<ToolResult> {
    try {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const args = tool.schema.parse(input) as Record<string, unknown>;
      if (tool.effect === 'write' && !await this.confirm(name, args)) throw new Error('Write denied by application policy');
      const result = await tool.run(args);
      const text = JSON.stringify(result);
      return { content: [{ type: 'text', text: text.length > 12000 ? text.slice(0, 12000) + '\n[truncated]' : text }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: message(error).slice(0, 2000) }] }; }
  }
}
