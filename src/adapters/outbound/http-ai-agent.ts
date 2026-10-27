import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AIModel, AIProvider } from '../../domain/ai.js';
import type { AgentPort, ConversationStore } from '../../application/ports.js';
import type { ToolContext } from '../../domain/models.js';
import type { Tools } from '../../application/tool-registry.js';

const endpoints = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  compatible: '',
  ollama: 'http://localhost:11434/v1',
  anthropic: 'https://api.anthropic.com/v1',
  codex: '',
  home_assistant: '',
};
export class HttpAIAgent implements AgentPort {
  constructor(
    private provider: AIProvider,
    private model: AIModel,
    private store: ConversationStore,
    private resolveTools: (context: ToolContext) => Promise<Tools>,
    private request: typeof fetch = fetch,
  ) {}
  async run(
    session: string,
    prompt: string,
    instructions: string,
    context: ToolContext,
    images: string[] = [],
    schema?: unknown,
    toolsEnabled = true,
  ) {
    const tools = await this.resolveTools(context);
    const definitions = toolsEnabled ? tools.definitions() : [];
    const anthropic = this.provider.kind === 'anthropic';
    const responses = this.provider.kind === 'openai';
    const history = await this.store.history(session);
    const thread = await this.store.thread(session);
    if (thread) await this.store.setThread(session, thread, 'ai-external');
    // The application owns history across providers. Avoid duplicating the current message
    // and history already included by the use case when no Codex thread exists.
    const previous = prompt.startsWith('Previous conversation (data):')
      ? ''
      : `Previous conversation (data):\n${JSON.stringify(history.slice(0, context.userQuestion ? -1 : undefined))}\n\n`;
    const content: any[] = [{ type: responses ? 'input_text' : 'text', text: previous + prompt }];
    for (const path of images) {
      const mime = (
        {
          '.png': 'image/png',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
        } as Record<string, string>
      )[extname(path).toLowerCase()];
      if (!mime) throw new Error('Unsupported image format for AI provider');
      const data = (await readFile(path)).toString('base64');
      content.push(
        anthropic
          ? { type: 'image', source: { type: 'base64', media_type: mime, data } }
          : responses
            ? { type: 'input_image', image_url: `data:${mime};base64,${data}` }
            : { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } },
      );
    }
    const messages: any[] = [{ role: 'user', content }];
    if (!anthropic && !responses) messages.unshift({ role: 'system', content: instructions });
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(300_000)]);
    const toolResult = async (name: string, args: unknown) => {
      signal.throwIfAborted();
      if (!toolsEnabled) throw new Error('Provider requested a tool in a turn with tools disabled');
      try {
        return JSON.stringify(await tools.call(name, args, context)) ?? 'null';
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : 'Tool failed' });
      }
    };
    for (let round = 0; round < 32; round++) {
      signal.throwIfAborted();
      const body: any = { model: this.model.model };
      if (this.model.effort) {
        if (responses) body.reasoning = { effort: this.model.effort };
        else if (!anthropic) body.reasoning_effort = this.model.effort;
      }
      if (responses) {
        Object.assign(body, { instructions, input: messages, store: false });
        if (definitions.length)
          body.tools = definitions.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
            strict: false,
          }));
        if (schema)
          body.text = { format: { type: 'json_schema', name: 'result', schema, strict: true } };
      } else if (anthropic) {
        Object.assign(body, { system: instructions, messages, max_tokens: 8192 });
        if (definitions.length)
          body.tools = definitions.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          }));
        if (schema) body.output_config = { format: { type: 'json_schema', schema } };
      } else {
        body.messages = messages;
        if (definitions.length)
          body.tools = definitions.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          }));
        if (schema)
          body.response_format = {
            type: 'json_schema',
            json_schema: { name: 'result', schema, strict: true },
          };
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (anthropic) {
        headers['x-api-key'] = this.provider.apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else if (this.provider.apiKey) headers.Authorization = 'Bearer ' + this.provider.apiKey;
      const base = this.provider.baseUrl || endpoints[this.provider.kind];
      const response = await this.request(
        base.replace(/\/$/, '') +
          (responses ? '/responses' : anthropic ? '/messages' : '/chat/completions'),
        { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' },
      );
      // Never return upstream bodies: they can echo keys, prompts or private tool data.
      if (!response.ok)
        throw new Error(
          `AI provider request failed (HTTP ${response.status}); no automatic retry was made. Check completed tool effects before retrying.`,
        );
      const value: any = await response.json();
      if (responses) {
        if (!Array.isArray(value.output) || value.status !== 'completed')
          throw new Error('AI provider did not complete the response');
        messages.push(...value.output);
        const calls = value.output.filter((item: any) => item.type === 'function_call');
        if (!calls.length)
          return this.final(
            value.output
              .flatMap((item: any) => item.content || [])
              .filter((item: any) => item.type === 'output_text')
              .map((item: any) => item.text)
              .join(''),
          );
        for (const call of calls)
          messages.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: await toolResult(call.name, JSON.parse(call.arguments)),
          });
      } else if (anthropic) {
        if (!Array.isArray(value.content)) throw new Error('Invalid AI provider response');
        if (!['end_turn', 'tool_use'].includes(value.stop_reason))
          throw new Error('AI provider response was interrupted');
        messages.push({ role: 'assistant', content: value.content });
        const calls = value.content.filter((item: any) => item.type === 'tool_use');
        if (!calls.length)
          return this.final(
            value.content
              .filter((item: any) => item.type === 'text')
              .map((item: any) => item.text)
              .join(''),
          );
        const results = [];
        for (const call of calls)
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: await toolResult(call.name, call.input),
          });
        messages.push({ role: 'user', content: results });
      } else {
        const choice = value.choices?.[0];
        if (!choice?.message || !['stop', 'tool_calls'].includes(choice.finish_reason))
          throw new Error('AI provider response was interrupted');
        const message = choice.message;
        messages.push(message);
        if (!message.tool_calls?.length) return this.final(message.content);
        for (const call of message.tool_calls)
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: await toolResult(call.function.name, JSON.parse(call.function.arguments)),
          });
      }
    }
    throw new Error(
      'AI provider tool-call limit reached; inspect completed actions before retrying',
    );
  }
  private final(text: unknown): string {
    if (typeof text !== 'string' || !text.trim())
      throw new Error('AI provider returned no final response');
    return text;
  }
}
