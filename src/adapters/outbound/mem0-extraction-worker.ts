import { parentPort, workerData } from 'node:worker_threads';
import type { MemoryTurn } from '../../application/memory-extraction.js';

const { turn, existing, instructions } = workerData as {
  turn: MemoryTurn;
  existing: string[];
  instructions: string;
};
try {
  const { Memory } = await import('mem0ai/oss');
  const documents: { metadata: Record<string, unknown> }[] = [];
  const engine = new Memory({
    disableHistory: true,
    customInstructions: instructions,
    // Ephemeral inference workspace. Candidates were already scoped and ranked by Zero;
    // this constant vector includes them all. Durable vectors are computed on publication.
    vectorStore: {
      provider: 'langchain',
      config: {
        dimension: 1,
        client: {
          addVectors: async (_vectors: number[][], added: typeof documents) => {
            documents.push(...added);
          },
          similaritySearchVectorWithScore: async (_query: number[], limit: number) =>
            documents.slice(0, limit).map((document) => [document, 1]),
        },
      },
    },
    embedder: {
      provider: 'langchain',
      config: {
        model: {
          embedQuery: async () => [1],
          embedDocuments: async (texts: string[]) => texts.map(() => [1]),
        },
      },
    },
    llm: {
      provider: 'langchain',
      config: {
        model: {
          invoke: async (messages: { content: unknown; _getType(): string }[]) => {
            const response = new Promise<string>((resolve, reject) => {
              parentPort!.once('message', (message: { ok: boolean; content?: string }) => {
                if (message.ok && message.content) resolve(message.content);
                else reject(new Error('Memory inference failed'));
              });
            });
            parentPort!.postMessage({
              kind: 'infer',
              messages: messages.map((message) => ({
                role: message._getType() === 'system' ? 'system' : 'user',
                content: message.content,
              })),
            });
            return { content: await response };
          },
        },
      },
    },
  });
  if (existing.length)
    await engine.add(
      existing.map((content) => ({ role: 'user', content })),
      { userId: 'scoped', infer: false },
    );
  const result = await engine.add(
    turn.messages.map((message) => ({
      role: message.role,
      content: `[${message.created}] ${message.content}`,
    })),
    { userId: 'scoped', infer: true },
  );
  parentPort!.postMessage({ kind: 'done', texts: result.results.map((item) => item.memory) });
} catch {
  parentPort!.postMessage({ kind: 'failed' });
}
