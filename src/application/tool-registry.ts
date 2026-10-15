import { z } from 'zod';
import type { AuditPort } from './ports.js';
import type { ToolContext } from '../domain/models.js';
export type { ToolContext } from '../domain/models.js';
export interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  invoke: (args: any, ctx: ToolContext) => Promise<unknown>;
}
export class Tools {
  private tools = new Map<string, Tool>();
  constructor(private store: AuditPort) {}
  add(name: string, description: string, schema: z.ZodType, invoke: Tool['invoke']) {
    if (this.tools.has(name)) throw new Error(`Duplicate tool ${name}`);
    this.tools.set(name, { name, description, schema, invoke });
  }
  definitions() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.schema),
    }));
  }
  async call(name: string, args: unknown, context: ToolContext) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error('Unknown tool');
    context.signal.throwIfAborted();
    const input = tool.schema.parse(args),
      start = Date.now();
    try {
      const result = await tool.invoke(input, context);
      this.store.audit(context.jobId, name, true, Date.now() - start);
      return result;
    } catch (error) {
      this.store.audit(context.jobId, name, false, Date.now() - start);
      throw error;
    }
  }
}
export const text = z.string().min(1).max(100_000);
export const optionalText = z.string().optional();
