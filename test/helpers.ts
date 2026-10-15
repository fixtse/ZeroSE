import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../src/adapters/outbound/config.js';
import { Store } from '../src/adapters/outbound/sqlite-store.js';
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fixt-assistant-'));
  const config = ConfigSchema.parse({
    apiKey: 'test-key-that-is-long-enough',
    dataDir: dir,
    codex: { home: join(dir, 'codex') },
  });
  const store = new Store(dir);
  return {
    dir,
    config,
    store,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export async function until(condition: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Test condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
