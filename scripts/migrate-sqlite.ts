import { loadConfig } from '../src/adapters/outbound/config.js';
import { Store } from '../src/adapters/outbound/postgres-store.js';
import { importSqlite } from '../src/adapters/outbound/sqlite-import.js';
const file = process.argv[2];
if (!file) throw new Error('Usage: pnpm migrate:sqlite /path/to/offline/assistant.sqlite');
const config = loadConfig();
const store = await Store.open(config.database.url, config.memory.embeddingDimensions);
try {
  console.log(
    JSON.stringify({ event: 'sqlite_import_verified', counts: await importSqlite(file, store) }),
  );
} finally {
  await store.close();
}
