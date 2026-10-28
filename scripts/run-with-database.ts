import { fileURLToPath } from 'node:url';
import { startDatabaseRuntime } from '../src/adapters/outbound/pglite-runtime.js';

// Administrative commands must run with Zero stopped when using embedded storage.
const target = process.argv.splice(2, 1)[0];
if (!target || !/^\.\/[a-z-]+\.ts$/.test(target)) throw new Error('Expected a script filename');
process.argv[1] = fileURLToPath(new URL(target, import.meta.url));
const runtime = await startDatabaseRuntime();
try {
  await import(target);
} finally {
  await runtime?.close();
}
