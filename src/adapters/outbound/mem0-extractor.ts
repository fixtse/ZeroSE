import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { MemoryExtractionPort, MemoryTurn } from '../../application/memory-extraction.js';
import type { AgentPort } from '../../application/ports.js';
import type { MemoryFragment, ToolContext } from '../../domain/models.js';

const responseSchema = z.object({
  memory: z
    .array(
      z.object({
        id: z.string(),
        text: z.string().min(1).max(8000),
        attributed_to: z.enum(['user', 'assistant']),
        category: z.string().min(1).max(100),
        tags: z.array(z.string().max(100)).max(12),
        summary: z.string().min(1).max(480),
        entities: z.array(z.string().trim().min(2).max(120)).max(16),
        relations: z
          .array(
            z.object({
              subject: z.string().trim().min(2).max(120),
              predicate: z.string().trim().min(1).max(120),
              object: z.string().trim().min(2).max(120),
            }),
          )
          .max(16),
        expiresAt: z.iso.datetime({ offset: true }).nullable(),
      }),
    )
    .max(40),
});

/** Mem0 owns inference; Zero supplies the approved AI model and publishes stable handles.
 * No DB credentials, integrations or persistent secondary memory are exposed to this worker.
 */
export class Mem0Extractor implements MemoryExtractionPort {
  constructor(private agent: AgentPort) {}
  async extract(turn: MemoryTurn, existing: string[], instructions: string, context: ToolContext) {
    context.signal.throwIfAborted();
    const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const worker = new Worker(new URL('./mem0-extraction-worker' + extension, import.meta.url), {
      workerData: { turn, existing, instructions },
      env: { MEM0_TELEMETRY: 'false' },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const fragments = new Map<string, MemoryFragment>();
    try {
      return await new Promise<MemoryFragment[]>((resolve, reject) => {
        const fail = () =>
          reject(new Error('Automatic memory extraction failed; the job was not retried'));
        const abort = () => {
          controller.abort();
          fail();
        };
        const timer = setTimeout(abort, 120_000);
        signal.addEventListener('abort', fail, { once: true });
        worker.once('error', fail);
        worker.once('exit', fail);
        worker.on(
          'message',
          (message: {
            kind: string;
            messages?: { role: string; content: string }[];
            texts?: string[];
          }) => {
            if (message.kind === 'infer') {
              void (async () => {
                const messages = message.messages || [];
                const raw = await this.agent.run(
                  `system:memory:${context.jobId}`,
                  JSON.stringify(messages.filter((item) => item.role !== 'system')),
                  messages
                    .filter((item) => item.role === 'system')
                    .map((item) => item.content)
                    .join('\n') +
                    '\nReturn category, tags, summary, attributed_to, entities (explicit named people, places, organizations or projects), relations (subject/predicate/object with explicit attribution), and expiresAt (null by default) for every memory. Return empty arrays for entities and relations when none apply. Never infer relationships. Set expiresAt only when the user explicitly requests forgetting or expiration at a stated time; resolve using message timestamps and timezone. Do not expire historical memories merely because an event is past.',
                  { ...context, signal, userQuestion: false },
                  [],
                  z.toJSONSchema(responseSchema),
                  false,
                );
                const parsed = responseSchema.parse(JSON.parse(raw));
                for (const item of parsed.memory)
                  fragments.set(item.text, {
                    text: item.text,
                    category: item.category,
                    tags: item.tags,
                    summary: item.summary,
                    entities: [
                      ...new Set([
                        ...item.entities,
                        ...item.relations.flatMap((r) => [r.subject, r.object]),
                      ]),
                    ].slice(0, 48),
                    relations: item.relations,
                    expiresAt: item.expiresAt,
                  });
                worker.postMessage({ ok: true, content: JSON.stringify(parsed) });
              })().catch(() => {
                fail();
                worker.postMessage({ ok: false });
              });
            } else {
              clearTimeout(timer);
              signal.removeEventListener('abort', fail);
              if (
                message.kind !== 'done' ||
                !message.texts ||
                message.texts.some((text) => !fragments.has(text))
              )
                fail();
              else resolve(message.texts.map((text) => fragments.get(text)!));
            }
          },
        );
        // Also clear timeout/listeners if the worker or caller fails before a result.
        signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
        worker.once('exit', () => clearTimeout(timer));
      });
    } finally {
      controller.abort();
      await worker.terminate();
    }
  }
}
