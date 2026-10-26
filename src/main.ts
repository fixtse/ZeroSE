import { AssistantTelegram } from './application/assistant-telegram.js';
import { AssistantTelegramAdmin } from './adapters/inbound/assistant-telegram-admin.js';
import { PostgresAssistantImages } from './adapters/outbound/postgres-assistant-images.js';
import { AssistantImageAdmin } from './adapters/inbound/assistant-image-admin.js';
import { TelegramAssistantPhoto } from './adapters/outbound/telegram-assistant-photo.js';
import type { Config } from './domain/config.js';
import { withTaskProvider } from './application/task-provider.js';
import { HomeAssistantTasks } from './adapters/outbound/home-assistant-tasks.js';
import { AssistantDefinitions } from './application/assistant-definitions.js';
import { PostgresAssistantDefinitions } from './adapters/outbound/postgres-assistant-definitions.js';
import { AssistantAdmin } from './adapters/inbound/assistant-admin.js';
import { PostgresPairing } from './adapters/outbound/postgres-pairing.js';
import { IntegrationAccess } from './application/integration-access.js';
import { HomeAssistantPairing } from './application/home-assistant-pairing.js';
import {
  PostgresIntegrationAccess,
  credentialCrypto,
} from './adapters/outbound/postgres-integration-access.js';
import { SetupAdmin } from './adapters/inbound/setup-admin.js';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './adapters/outbound/config.js';
import { PostgresZeroSettings } from './adapters/outbound/postgres-zero-settings.js';
import { registerHomeAssistantControl } from './adapters/inbound/ha-control-tools.js';
import { Store } from './adapters/outbound/postgres-store.js';
import { Tools } from './application/tool-registry.js';
import { Codex } from './adapters/outbound/codex-app-server.js';
import { Google } from './adapters/outbound/google.js';
import { HomeAssistant } from './adapters/outbound/home-assistant.js';
import { Memory } from './application/memory.js';
import { HomeAssistantSpeech } from './adapters/outbound/home-assistant-speech.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { Media } from './adapters/outbound/media.js';
import { Telegram } from './adapters/outbound/telegram.js';
import { Assistant } from './application/assistant.js';
import { Scheduler } from './application/scheduler.js';
import { registerSearch } from './adapters/outbound/search.js';
import { NotificationRules } from './application/notification-rules.js';
import { HomeAssistantRuleScheduler } from './adapters/outbound/ha-rule-scheduler.js';
import { SchedulerSE } from './adapters/outbound/schedulerse.js';
import { PostgresRules } from './adapters/outbound/postgres-rules.js';
import { PostgresPersonalData } from './adapters/outbound/postgres-personal-data.js';
import { OpenStreetMapPlaces } from './adapters/outbound/places.js';
import { registerNotificationTools } from './adapters/inbound/notification-tools.js';
import { registerPlacesTools } from './adapters/inbound/places-tools.js';
import { registerPersonalDataTools } from './adapters/inbound/personal-data-tools.js';
import { DeploymentWebhookProxy } from './adapters/inbound/deployment-webhook.js';
import { createHttpServer } from './adapters/inbound/http-server.js';
import { ZeroDiscovery } from './adapters/inbound/zero-discovery.js';
import { VoiceBridge, voiceOwnerSession, voiceUserSession } from './application/voice-bridge.js';
import { WeatherNotification } from './application/weather-notification.js';
import { weatherChangeSchema } from './adapters/inbound/weather-change-schema.js';
import { GeminiEmbeddings } from './adapters/outbound/gemini-embeddings.js';
import { ProcessManagedMessage } from './application/use-cases/process-managed-message.js';
import { ConsolidateMemory } from './application/use-cases/consolidate-memory.js';
import { PrepareNotification } from './application/use-cases/prepare-notification.js';
import { TelegramWebhook } from './adapters/outbound/telegram-webhook.js';
import { TelegramCommands } from './adapters/outbound/telegram-commands.js';
import { TelegramBots } from './adapters/inbound/telegram-bots.js';
import { PostgresAccess } from './adapters/outbound/postgres-access.js';
import { Access, scopedConfig } from './application/access.js';
import { AdminAuth } from './adapters/inbound/admin-auth.js';
import { Admin } from './adapters/inbound/admin.js';
import { localClock } from './domain/time.js';
import { isMemoryTool } from './domain/memory.js';
import { sessionAddress, toolCapability } from './domain/access.js';
import type { Job, ToolContext } from './domain/models.js';
import type { JobResult } from './application/use-cases/contracts.js';
import {
  registerGoogleTools,
  registerHomeAssistantTools,
  registerMemoryTools,
} from './adapters/inbound/integration-tools.js';

function taskServices(value: Config) {
  const direct = new Google(value.google, value.timezone);
  return value.homeAssistant.taskProvider === 'home_assistant'
    ? withTaskProvider(direct, new HomeAssistantTasks(value.homeAssistant))
    : direct;
}

process.umask(0o077);
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const store = await Store.open(config.database.url, config.memory.embeddingDimensions),
  tools = new Tools(store),
  google = taskServices(config),
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
const assistantImages = new PostgresAssistantImages(store.pool);
await assistantImages.initialize();
const assistantDefinitions = new AssistantDefinitions(
  new PostgresAssistantDefinitions(store.pool),
  randomUUID,
);
const adminAuth = new AdminAuth(
  store.pool,
  process.env.ASSISTANT_ADMIN_URL || `http://127.0.0.1:${config.port}`,
  process.env.ASSISTANT_SECRETS_KEY || config.apiKey,
  {
    async recipient() {
      const chat = config.telegram.allowedUsers[0];
      if (!(await bots.isEnabled('zero')) || !chat || !/^[1-9]\d*$/.test(chat)) return undefined;
      const profile = await accessRepository.profile('zero', chat);
      return profile?.owner && profile.enabled && profile.kind === 'user' ? chat : undefined;
    },
    async send(chat, code) {
      const zeroBot = await bots.get('zero');
      await zeroBot.call(
        'sendMessage',
        {
          chat_id: chat,
          text:
            'Código para restablecer la contraseña de administración de Zero: ' +
            code +
            '\nCaduca en 10 minutos. Si no lo has solicitado, ignora este mensaje.',
        },
        AbortSignal.timeout(10000),
      );
    },
  },
);
await adminAuth.initialize();
const integrationRepository = new PostgresIntegrationAccess(store.pool);
await integrationRepository.initialize();
const integrationAccess = new IntegrationAccess(integrationRepository, credentialCrypto);

const access: Access = new Access(accessRepository, store, (bot) => bots.username(bot));
const bots = new TelegramBots(
  config,
  media,
  telegram,
  store,
  access,
  async (id) => (await assistantDefinitions.get(id))?.name || 'Assistant',
);
const ruleRepository = new PostgresRules(store.pool);
await ruleRepository.initialize();
const places = new OpenStreetMapPlaces(
  process.env.ASSISTANT_PHOTON_URL,
  process.env.ASSISTANT_OSRM_URL,
);
const assistantTelegram = new AssistantTelegram(
  accessRepository,
  config.telegram,
  adminAuth.origin,
  assistantDefinitions,
  async (token) => {
    const candidate = new Telegram({ ...config, telegram: { ...config.telegram, token } }, media);
    await candidate.call('getMe', {}, AbortSignal.timeout(10000));
  },
  () => randomBytes(32).toString('hex'),
  new TelegramWebhook(
    (settings) =>
      new Telegram({ ...config, telegram: { ...config.telegram, token: settings.token } }, media),
  ),
  (id) => bots.reconfigure(id),
);

const personalData = new PostgresPersonalData(store.pool);
const rules = new NotificationRules(
  ruleRepository,
  async (session, kind, schedulerKey) => {
    const address = sessionAddress(session);
    const profile = await access.forSession(session);
    const scoped = profile ? scopedConfig(config, profile) : config;
    const external =
      profile?.owner &&
      config.schedulerSE &&
      (schedulerKey ? schedulerKey.startsWith('schedulerse:') : config.schedulerSE.enabled);
    return {
      enabled:
        !!address &&
        !!profile?.enabled &&
        (await bots.isEnabled(address.bot)) &&
        (kind !== 'alert' ||
          (profile.capabilities.includes('homeAssistant') && !!scoped.homeAssistant.token)),
      scheduler:
        kind !== 'alert'
          ? external && config.schedulerSE
            ? new SchedulerSE(
                {
                  ...config.schedulerSE,
                  callbackUrl:
                    config.schedulerSE.callbackUrl ||
                    `http://127.0.0.1:${config.port}/v1/triggers/schedulerse-events`,
                },
                (id) => ruleRepository.byId(id),
              )
            : new HomeAssistantRuleScheduler(config.homeAssistant)
          : profile?.capabilities.includes('homeAssistant') && scoped.homeAssistant.token
            ? new HomeAssistantRuleScheduler(scoped.homeAssistant)
            : undefined,
    };
  },
  config.schedules.enabled && config.telegram.notificationChatId
    ? 'telegram:' + config.telegram.notificationChatId
    : undefined,
  async () => {
    const profile = await access.forSession('telegram:' + config.telegram.notificationChatId);
    return localClock(new Date(), profile?.timezone || config.timezone).day;
  },
);
registerNotificationTools(tools, rules, config.homeAssistant.token ? ha : undefined);
registerPlacesTools(tools, places);
registerPersonalDataTools(
  tools,
  personalData,
  config.memory.mode !== 'none',
  config.memory.sharedProfile,
);
const haClient = { isEnabled: async (bot: string) => bot === 'zero' };
async function canRespond(job: Job, result?: JobResult) {
  const address = sessionAddress(job.session);
  if (
    job.payload.source === 'home_assistant_voice' &&
    job.payload.haUserId !== undefined &&
    (typeof job.payload.haUserId !== 'string' ||
      (await voiceUserSession(job.payload.haUserId, zeroSettings, access, haClient)) !==
        job.session)
  )
    return false;
  if (!address) return true; // HTTP chat already requires the administrator API key.
  if (
    job.payload.kind === 'telegram' &&
    !(await bots.matchesAccount(address.bot, job.payload.accountId))
  )
    return false;
  const profile = await access.forSession(job.session);
  if (
    result?.requiredCapabilities?.some((capability) => !profile?.capabilities.includes(capability))
  )
    return false;
  if (job.payload.kind === 'rule_notification') {
    const rule = await ruleRepository.read(job.session, job.payload.ruleId);
    if (
      !rule ||
      rule.generation !== job.payload.generation ||
      ['paused', 'cancelled', 'expired'].includes(rule.status)
    )
      return false;
    if (
      rule.kind === 'alert' &&
      (!profile?.capabilities.includes('homeAssistant') ||
        !scopedConfig(config, profile).homeAssistant.token)
    )
      return false;
    if (!(await rules.canNotify(rule))) return false;
  }
  return (
    !!profile?.enabled &&
    ((job.payload.source === 'home_assistant_voice' && address.bot === 'zero') ||
      (await bots.isEnabled(address.bot)))
  );
}
async function services(context: ToolContext) {
  const address = sessionAddress(context.session);
  const profile = await access.forSession(context.session);
  if (address && !profile?.enabled) throw new Error('Chat is not permitted');
  const scoped = profile ? scopedConfig(config, profile) : config;
  context.capabilities = profile?.capabilities;
  context.memoryMode = scoped.memory.mode || 'advanced';
  const google = taskServices(scoped);
  const ha = new HomeAssistant(scoped.homeAssistant);
  const memory = new Memory(scoped.memory, store, new GeminiEmbeddings(scoped.memory));
  const settings = await zeroSettings.read();
  const permitted = (name: string) => {
    if (
      profile?.owner &&
      !settings.homeAssistant &&
      (toolCapability(name) === 'homeAssistant' ||
        (toolCapability(name) === 'tasks' &&
          scoped.homeAssistant.taskProvider === 'home_assistant'))
    )
      return false;
    if (isMemoryTool(name) && scoped.memory.mode === 'none') return false;
    const capability = toolCapability(name);
    return !profile || !capability || profile.capabilities.includes(capability);
  };
  const tools = new Tools(
    store,
    async (name) => {
      if (
        profile?.owner &&
        (toolCapability(name) === 'homeAssistant' ||
          (toolCapability(name) === 'tasks' &&
            scoped.homeAssistant.taskProvider === 'home_assistant')) &&
        !(await zeroSettings.read()).homeAssistant
      )
        return false;
      if (!address) return true;
      const current = await access.forSession(context.session);
      const capability = toolCapability(name);
      if (capability === 'tasks' && current) {
        const currentHA = scopedConfig(config, current).homeAssistant;
        if (
          (currentHA.taskProvider || 'google') !==
            (scoped.homeAssistant.taskProvider || 'google') ||
          currentHA.taskListEntity !== scoped.homeAssistant.taskListEntity
        )
          return false;
        if (
          currentHA.taskProvider === 'home_assistant' &&
          (!current.capabilities.includes('homeAssistant') ||
            !currentHA.token ||
            currentHA.token !== scoped.homeAssistant.token ||
            currentHA.url !== scoped.homeAssistant.url)
        )
          return false;
      }
      return (
        !!current?.enabled &&
        !(isMemoryTool(name) && current.memoryMode === 'none') &&
        ((context.source === 'home_assistant_voice' && address.bot === 'zero') ||
          (await bots.isEnabled(address.bot))) &&
        (!capability || current.capabilities.includes(capability))
      );
    },
    permitted,
  );
  registerGoogleTools(tools, google);
  registerHomeAssistantTools(tools, ha, scoped.homeAssistant);
  if (profile?.owner) registerHomeAssistantControl(tools, ha, zeroSettings);
  registerMemoryTools(tools, memory, scoped.memory.mode);
  registerSearch(tools, scoped.braveApiKey);
  registerNotificationTools(tools, rules, scoped.homeAssistant.token ? ha : undefined);
  registerPlacesTools(tools, places);
  registerPersonalDataTools(
    tools,
    personalData,
    scoped.memory.mode !== 'none',
    scoped.memory.sharedProfile,
  );
  return { config: scoped, google, ha, memory, tools, profile };
}
let prompts: Record<string, string> = {};
try {
  prompts = JSON.parse(readFileSync(join(config.dataDir, 'prompts.json'), 'utf8'));
} catch {
  /* use default identity */
}
const zeroSettings = new PostgresZeroSettings(store.pool);
const pairing = new HomeAssistantPairing(
  accessRepository,
  new PostgresPairing(store.pool, accessRepository, zeroSettings),
  credentialCrypto,
  config.homeAssistant,
  adminAuth.origin,
);
await zeroSettings.initialize(
  prompts.main || 'Eres Zero, un asistente personal. Responde en español.',
);
const codex = new Codex(config, store, tools, async (context) => (await services(context)).tools),
  processManagedMessage = new ProcessManagedMessage(
    store,
    codex,
    services,
    (bot, session) => bots.get(bot, session),
    canRespond,
    async () => (await zeroSettings.read()).prompt,
    assistantDefinitions,
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
      rule_notification: (job, context) =>
        rules.notification(job, async () => {
          const change = weatherChangeSchema.safeParse(job.payload.weather);
          if (!change.success)
            return '🌦️ Se actualizó la previsión, pero esta notificación no incluye los valores anteriores y nuevos; no puedo precisar el cambio.';
          const scoped = await services(context);
          return new WeatherNotification(codex).update(
            change.data,
            job.payload.firedAt,
            scoped.config.timezone,
            context,
            scoped.profile?.capabilities.includes('calendar') ? scoped.google : undefined,
          );
        }),
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
    (job) => bots.get(sessionAddress(job.session)?.bot || 'zero', job.session),
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
    (scoped) => new HomeAssistantSpeech(scoped.homeAssistant, scoped.media.maxBytes),
    async (scoped, text, signal) => {
      const media = new Media(scoped),
        job = 'preview-' + randomUUID();
      try {
        return await media.voice(text, job, signal);
      } finally {
        await media.cleanup(job);
      }
    },
    (scoped) => {
      const homeAssistant = new HomeAssistant(scoped.homeAssistant);
      return {
        entities: (query, signal) => homeAssistant.entityCatalog(query, signal),
        services: (query, signal) => homeAssistant.serviceCatalog(query, signal),
      };
    },
    rules.repository,
  ),
  server = createHttpServer(
    config,
    store,
    readFileSync('assets/icon.png'),
    { access, admin, auth: adminAuth },
    process.env.ASSISTANT_DEPLOY_WEBHOOK_URL
      ? new DeploymentWebhookProxy(process.env.ASSISTANT_DEPLOY_WEBHOOK_URL)
      : undefined,
    rules,
    new VoiceBridge(
      store,
      config.homeAssistant.voiceSatellite || '',
      () =>
        voiceOwnerSession(
          config.telegram.allowedUsers[0] || config.telegram.notificationChatId,
          access,
          haClient,
        ),
      (userId) => voiceUserSession(userId, zeroSettings, access, haClient),
      assistantDefinitions,
    ),
    zeroSettings,
    integrationAccess,
    pairing,
    new SetupAdmin(
      integrationAccess,
      pairing,
      zeroSettings,
      accessRepository,
      adminAuth.origin,
      new AssistantAdmin(
        assistantDefinitions,
        accessRepository,
        new AssistantImageAdmin(
          assistantDefinitions,
          assistantImages,
          new TelegramAssistantPhoto(async (id) => (await bots.settings(id)).token),
        ),
        new AssistantTelegramAdmin(assistantTelegram),
      ),
      async () => {
        if (config.homeAssistant.token) return true;
        // This discovery is admin-only, never part of a conversation's instructions.
        for (let offset = 0; ; offset += 50) {
          const page = await accessRepository.profiles('', offset, 50);
          if (page.items.some((profile) => !!profile.homeAssistant?.token)) return true;
          if (offset + page.items.length >= page.total || !page.items.length) return false;
        }
      },
      async () => {
        if (config.homeAssistant.token)
          return {
            entities: (query, signal) => ha.entityCatalog(query, signal),
            services: (query, signal) => ha.serviceCatalog(query, signal),
          };
        for (let offset = 0; ; offset += 50) {
          const page = await accessRepository.profiles('', offset, 50);
          const profile = page.items.find((item) => !!item.homeAssistant?.token);
          if (profile) {
            const client = new HomeAssistant(scopedConfig(config, profile).homeAssistant);
            return {
              entities: (query, signal) => client.entityCatalog(query, signal),
              services: (query, signal) => client.serviceCatalog(query, signal),
            };
          }
          if (offset + page.items.length >= page.total || !page.items.length)
            throw new Error('No Home Assistant connection');
        }
      },
    ),
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
    ruleRepository,
  ).execute(job, context);
}

const discovery = new ZeroDiscovery();
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(config.port, config.host, () => {
  if (process.env.ASSISTANT_DISCOVERY !== 'false')
    discovery.start(config.host, config.port, process.env.ASSISTANT_ADMIN_URL);
  assistant.start();
  scheduler.start();
  void rules
    .migrateLegacy()
    .then(async () => {
      const chat = config.telegram.allowedUsers[0] || config.telegram.notificationChatId;
      if (chat && (await access.forSession('telegram:' + chat))?.owner)
        await rules.ensureOwnerWeather('telegram:' + chat);
    })
    .catch(() => console.error(JSON.stringify({ event: 'notification_rule_startup_failed' })));
  void bots.start().catch(() =>
    console.error(
      JSON.stringify({
        event: 'telegram_start_failed',
        reason: 'Check saved assistant connections',
      }),
    ),
  );
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
  await discovery.close();
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
