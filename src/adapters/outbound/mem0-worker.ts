import { parentPort, workerData } from 'node:worker_threads';
import type { Mem0Operation } from './mem0-engine.js';

const { connectionString, dimensions, vector, operation } = workerData as {
  connectionString: string;
  dimensions: number;
  vector: number[];
  operation: Mem0Operation;
};

try {
  // The worker environment disables telemetry before the SDK is loaded.
  const { Memory } = await import('mem0ai/oss');
  const engine = new Memory({
    disableHistory: true,
    // Zero supplies structural adapters. LangChain's message/document APIs are unused
    // because extraction stays in Zero and the vector store is native pgvector.
    embedder: {
      provider: 'langchain',
      config: {
        model: {
          embedQuery: async () => vector,
          embedDocuments: async (texts: string[]) => texts.map(() => vector),
        },
      },
    },
    llm: {
      provider: 'langchain',
      config: {
        model: {
          invoke: async () => {
            throw new Error('Zero owns memory extraction');
          },
        },
      },
    },
    vectorStore: {
      provider: 'pgvector',
      config: {
        connectionString,
        collectionName: 'zero_mem0_vectors',
        dimension: dimensions,
        embeddingModelDims: dimensions,
      },
    },
  });
  const result =
    operation.kind === 'add'
      ? await engine.add(operation.text, {
          userId: operation.profile,
          metadata: operation.metadata,
          infer: false,
          ...(operation.expiresAt
            ? { expirationDate: new Date(operation.expiresAt).toISOString().slice(0, 10) }
            : {}),
        })
      : await engine.search(operation.query, {
          filters: operation.filters,
          topK: 50,
          threshold: 0,
        });
  parentPort!.postMessage({
    ok: true,
    results: result.results.map(({ id, score }) => ({ id, score })),
  });
} catch {
  parentPort!.postMessage({ ok: false, results: [] });
}
