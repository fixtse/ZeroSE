import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './adapters/outbound/config.js';
import { Store } from './adapters/outbound/postgres-store.js';
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
import { DeploymentWebhookProxy } from './adapters/inbound/deployment-webhook.js';
import { createHttpServer } from './adapters/inbound/http-server.js';
import { GeminiEmbeddings } from './adapters/outbound/gemini-embeddings.js';
import { ProcessManagedMessage } from './application/use-cases/process-managed-message.js';
import { ConsolidateMemory } from './application/use-cases/consolidate-memory.js';
import { PrepareNotification } from './application/use-cases/prepare-notification.js';
import { TelegramWebhook } from './adapters/outbound/telegram-webhook.js';
import { TelegramCommands } from './adapters/outbound/telegram-commands.js';
import { TelegramBots } from './adapters/inbound/telegram-bots.js';
import { PostgresAccess } from './adapters/outbound/postgres-access.js';
import { Access, scopedConfig } from './application/access.js';
import { Admin } from './adapters/inbound/admin.js';
import { isMemoryTool } from './domain/memory.js';
import { sessionAddress, toolCapability } from './domain/access.js';
import type { Job, ToolContext } from './domain/models.js';
import type { JobResult } from './application/use-cases/contracts.js';
import {
  registerGoogleTools,
  registerHomeAssistantTools,
  registerMemoryTools,
} from './adapters/inbound/integration-tools.js';

process.umask(0o077);
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const store = await Store.open(config.database.url, config.memory.embeddingDimensions),
  tools = new Tools(store),
  google = new Google(config.google, config.timezone),
  ha = new HomeAssistant(config.homeAssistant),
  memory = new Memory(config.memory, store, new GeminiEmbeddings(config.memory)),
  media = new Media(config),
  telegram = new Telegram(config, media);
registerGoogleTools(tools, google);
registerHomeAssistantTools(tools, ha, config.homeAssistant);
registerMemoryTools(tools, memory, config.memory.mode);
registerSearch(tools, config.braveApiKey);
const accessRepository = new PostgresAccess(
  store.pool,
  process.env.ASSISTANT_SECRETS_KEY || config.apiKey,
);
await accessRepository.initialize(config);
const access: Access = new Access(accessRepository, store, () => bots.salemUsername());
const bots = new TelegramBots(config, media, telegram, store, access);
async function canRespond(job: Job) {
  const address = sessionAddress(job.session);
  if (!address) return true; // HTTP chat already requires the administrator API key.
  const profile = await access.forSession(job.session);
  return !!profile?.enabled && (await bots.isEnabled(address.bot));
}
async function services(context: ToolContext) {
  const address = sessionAddress(context.session);
  const profile = await access.forSession(context.session);
  if (address && !profile?.enabled) throw new Error('Chat is not permitted');
  const scoped = profile ? scopedConfig(config, profile) : config;
  context.capabilities = profile?.capabilities;
  context.memoryMode = scoped.memory.mode || 'advanced';
  const google = new Google(scoped.google, scoped.timezone);
  const ha = new HomeAssistant(scoped.homeAssistant);
  const memory = new Memory(scoped.memory, store, new GeminiEmbeddings(scoped.memory));
  const permitted = (name: string) => {
    if (isMemoryTool(name) && scoped.memory.mode === 'none') return false;
    const capability = toolCapability(name);
    return !profile || !capability || profile.capabilities.includes(capability);
  };
  const tools = new Tools(
    store,
    async (name) => {
      if (!address) return true;
      const current = await access.forSession(context.session);
      const capability = toolCapability(name);
      return (
        !!current?.enabled &&
        !(isMemoryTool(name) && current.memoryMode === 'none') &&
        (await bots.isEnabled(address.bot)) &&
        (!capability || current.capabilities.includes(capability))
      );
    },
    permitted,
  );
  registerGoogleTools(tools, google);
  registerHomeAssistantTools(tools, ha, scoped.homeAssistant);
  registerMemoryTools(tools, memory, scoped.memory.mode);
  registerSearch(tools, scoped.braveApiKey);
  return { config: scoped, google, ha, memory, tools, profile };
}
let prompts: Record<string, string> = {};
try {
  prompts = JSON.parse(readFileSync(join(config.dataDir, 'prompts.json'), 'utf8'));
} catch {
  /* use default identity */
}
const codex = new Codex(config, store, tools, async (context) => (await services(context)).tools),
  processManagedMessage = new ProcessManagedMessage(
    store,
    codex,
    services,
    (bot) => bots.get(bot),
    canRespond,
    prompts.main,
  ),
  assistant = new Assistant(
    config,
    store,
    {
      chat: (job, context) => processManagedMessage.execute(job, context),
      telegram: (job, context) => processManagedMessage.execute(job, context),
      consolidate: async (job, context) => {
        if (!(await canRespond(job))) return { output: '', deliver: false };
        const scope = await services(context);
        if (scope.config.memory.mode === 'none') return { output: '', deliver: false };
        return new ConsolidateMemory(
          codex,
          scope.google,
          scope.memory,
          scope.profile && !scope.profile.owner ? '' : prompts.consolidation,
          scope.config.memory.categories,
          scope.config.timezone,
          async () => {
            const current = await services(context);
            return current.config.memory.mode === 'none' ? undefined : current.memory;
          },
        ).execute(job, context);
      },
      morning: notify,
      event_reminders: notify,
      reset: async (job) => {
        await store.reset(job.session);
        const profile = await access.forSession(job.session);
        return profile?.owner && (await canRespond(job))
          ? { output: 'Zero: Nueva Sesión Iniciada', voice: false }
          : { output: '', deliver: false };
      },
    },
    media,
    telegram,
    (job) => bots.get(sessionAddress(job.session)?.bot || 'zero'),
    canRespond,
    async (job) => (await access.forSession(job.session))?.voiceReplies !== false,
  ),
  scheduler = new Scheduler(config, store, memory, async (session) => {
    const address = sessionAddress(session);
    const profile = await access.forSession(session);
    return {
      enabled: !address || !!profile?.enabled,
      timezone: profile?.timezone || config.timezone,
      memoryMode: profile?.memoryMode || config.memory.mode || 'advanced',
    };
  }),
  admin = new Admin(
    config,
    accessRepository,
    async (token) => {
      const candidate = new Telegram(
        { ...config, telegram: { ...config.telegram, token } },
        media,
        'Salem',
      );
      await candidate.call('getMe', {}, AbortSignal.timeout(10000));
    },
    new TelegramWebhook(
      (settings) =>
        new Telegram(
          { ...config, telegram: { ...config.telegram, token: settings.token } },
          media,
          'Salem',
        ),
    ),
    new TelegramCommands((bot) => bots.get(bot)),
  ),
  server = createHttpServer(
    config,
    store,
    readFileSync('assets/icon.png'),
    { access, admin },
    process.env.ASSISTANT_DEPLOY_WEBHOOK_URL
      ? new DeploymentWebhookProxy(process.env.ASSISTANT_DEPLOY_WEBHOOK_URL)
      : undefined,
  );

async function notify(job: Job, context: ToolContext): Promise<JobResult> {
  if (!(await canRespond(job))) return { output: '', deliver: false };
  const scope = await services(context);
  if (
    scope.profile &&
    (!scope.profile.owner ||
      !scope.profile.capabilities.includes('calendar') ||
      !scope.profile.capabilities.includes('tasks'))
  )
    return { output: '', deliver: false };
  return new PrepareNotification(
    scope.config,
    store,
    codex,
    scope.google,
    scope.ha,
    prompts,
  ).execute(job, context);
}

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(config.port, config.host, () => {
  assistant.start();
  scheduler.start();
  bots.start();
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
  await bots.close();
  server.close();
  const deadline = setTimeout(() => process.exit(1), 15_000);
  deadline.unref();
  await assistant.close();
  codex.close();
  await store.close();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
