import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './adapters/outbound/config.js';
import { Store } from './adapters/outbound/sqlite-store.js';
import { Tools } from './application/tool-registry.js';
import { Codex } from './adapters/outbound/codex-app-server.js';
import { Google } from './adapters/outbound/google.js';
import { HomeAssistant } from './adapters/outbound/home-assistant.js';
import { Memory } from './application/memory.js';
import { Media } from './adapters/outbound/media.js';
import { Telegram } from './adapters/outbound/telegram.js';
import { Assistant } from './application/assistant.js';
import { Scheduler } from './application/scheduler.js';
import { registerSearch } from './adapters/outbound/search.js';
import { createHttpServer } from './adapters/inbound/http-server.js';
import { GeminiEmbeddings } from './adapters/outbound/gemini-embeddings.js';
import { PostgresMemory } from './adapters/outbound/postgres-memory.js';
import { ProcessMessage } from './application/use-cases/process-message.js';
import { ConsolidateMemory } from './application/use-cases/consolidate-memory.js';
import { PrepareNotification } from './application/use-cases/prepare-notification.js';
import {
  registerGoogleTools,
  registerHomeAssistantTools,
  registerMemoryTools,
} from './adapters/inbound/integration-tools.js';

process.umask(0o077);
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const store = new Store(config.dataDir),
  tools = new Tools(store),
  google = new Google(config.google, config.timezone),
  ha = new HomeAssistant(config.homeAssistant),
  legacy = config.memory.postgresUrl ? new PostgresMemory(config.memory.postgresUrl) : undefined,
  memory = new Memory(config.memory, store, new GeminiEmbeddings(config.memory), legacy),
  media = new Media(config),
  telegram = new Telegram(config, media);
registerGoogleTools(tools, google);
registerHomeAssistantTools(tools, ha, config.homeAssistant);
registerMemoryTools(tools, memory);
registerSearch(tools, config.braveApiKey);
let prompts: Record<string, string> = {};
try {
  prompts = JSON.parse(readFileSync(join(config.dataDir, 'prompts.json'), 'utf8'));
} catch {
  /* use default identity */
}
const codex = new Codex(config, store, tools),
  processMessage = new ProcessMessage(config, store, codex, google, memory, telegram, prompts.main),
  consolidateMemory = new ConsolidateMemory(codex, google, memory, prompts.consolidation),
  prepareNotification = new PrepareNotification(config, store, codex, google, ha, prompts),
  assistant = new Assistant(
    config,
    store,
    {
      chat: (job, context) => processMessage.execute(job, context),
      telegram: (job, context) => processMessage.execute(job, context),
      consolidate: (job, context) => consolidateMemory.execute(job, context),
      morning: (job, context) => prepareNotification.execute(job, context),
      event_reminders: (job, context) => prepareNotification.execute(job, context),
      reset: async (job) => {
        store.reset(job.session);
        return { output: 'Zero: Nueva Sesión Iniciada', voice: false };
      },
    },
    media,
    telegram,
  ),
  scheduler = new Scheduler(config, store, memory),
  server = createHttpServer(config, store);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(config.port, config.host, () => {
  assistant.start();
  scheduler.start();
  console.log(
    JSON.stringify({
      event: 'started',
      host: config.host,
      port: config.port,
      tools: tools.definitions().map((t) => t.name),
      schedules: config.schedules.enabled,
    }),
  );
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  scheduler.close();
  server.close();
  const deadline = setTimeout(() => process.exit(1), 15_000);
  deadline.unref();
  await assistant.close();
  codex.close();
  await legacy?.close();
  store.close();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
