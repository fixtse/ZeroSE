import { Worker } from 'node:worker_threads';

export type Mem0Operation =
  | {
      kind: 'add';
      text: string;
      profile: string;
      metadata: Record<string, unknown>;
      expiresAt?: string;
    }
  | { kind: 'search'; query: string; filters: Record<string, unknown> };

/** One isolated OSS operation; terminating the worker also closes SDK-owned PG clients.
 * Embeddings remain owned by Zero's configured provider, with no extra LLM inference.
 */
export async function runMem0(
  connectionString: string,
  dimensions: number,
  vector: number[],
  operation: Mem0Operation,
): Promise<{ id: string; score?: number }[]> {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const worker = new Worker(new URL('./mem0-worker' + extension, import.meta.url), {
    workerData: { connectionString, dimensions, vector, operation },
    env: { MEM0_TELEMETRY: 'false' },
    // SDK diagnostics can contain connection details or memory text. Do not forward them.
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Mem0 operation timed out; do not replay uncertain writes')),
        60000,
      );
      const fail = () => {
        clearTimeout(timer);
        reject(new Error('Mem0 operation failed; inspect staged records before retrying writes'));
      };
      worker.once('error', fail);
      worker.once('exit', fail);
      worker.once(
        'message',
        (message: { ok: boolean; results: { id: string; score?: number }[] }) => {
          clearTimeout(timer);
          if (message.ok) resolve(message.results);
          else fail();
        },
      );
    });
  } finally {
    await worker.terminate();
  }
}
