import { replyText } from './domain/language.js';
import { defaultZeroPrompt } from './application/prompts.js';
import { PersonalLocation } from './application/personal-location.js';
import { RuleRetention } from './application/rule-retention.js';
import { PostgresHomeAssistantConnections } from './adapters/outbound/postgres-home-assistant-connections.js';
import { PublicConnection } from './application/public-connection.js';
import { migrateProfileSchedules } from './application/migrate-profile-schedules.js';
import { HomeAssistantMorningTriggers } from './adapters/outbound/ha-morning-triggers.js';
import { MorningTriggers, importMorningTrigger } from './application/morning-triggers.js';
import { profileNotifications, notificationServices } from './application/profile-notifications.js';
import { startDatabaseRuntime } from './adapters/outbound/pglite-runtime.js';
import { HomeAssistantConnections } from './application/home-assistant-connections.js';
import { homeAssistantBinding } from './application/zero-settings.js';
import { GoogleDestinations } from './application/google-destinations.js';
import { GoogleConnection } from './application/google-connection.js';
import { GoogleOAuth } from './adapters/outbound/google-oauth.js';
import { GoogleOAuthAdmin, googleCallbackPath } from './adapters/inbound/google-oauth-admin.js';
import { httpRerank } from './adapters/outbound/http-reranker.js';
import { ModelMemoryReranker } from './application/memory-reranker.js';
import { ReprocessMemory } from './application/reprocess-memory.js';
import { HomeAssistantMobileRecovery } from './adapters/outbound/home-assistant-mobile-recovery.js';
import { PostgresServiceSettings } from './adapters/outbound/postgres-service-settings.js';
import {
  LocalDeadlineWorker,
  LocalRuleScheduler,
  selectRuleScheduler,
} from './application/local-rule-scheduler.js';
import { EdgeSpeechCatalog } from './adapters/outbound/edge-speech-catalog.js';
import { ServiceSettingsAdmin } from './adapters/inbound/service-settings-admin.js';
import { ServiceConfigSchema } from './adapters/outbound/config-schema.js';
import { ConfiguredEmbeddings } from './application/configured-embeddings.js';
import { memoryEmbeddings, embeddingCatalog } from './adapters/outbound/memory-embeddings.js';
import { EmbeddingAdmin } from './adapters/inbound/embedding-admin.js';
import { aiModelCatalog } from './adapters/outbound/ai-model-catalog.js';
import { HomeAssistantAI } from './adapters/outbound/home-assistant-ai.js';
import { AIAdmin } from './adapters/inbound/ai-admin.js';
import { PostgresAI } from './adapters/outbound/postgres-ai.js';
import { AIAgent } from './application/ai-agent.js';
import { HttpAIAgent } from './adapters/outbound/http-ai-agent.js';
import { homeAssistantUserName } from './adapters/outbound/home-assistant-user-name.js';
import { homeAssistantCommand } from './adapters/outbound/home-assistant-socket.js';
import { UserContext } from './application/user-context.js';
import { AssistantTelegram } from './application/assistant-telegram.js';
import { AssistantTelegramAdmin } from './adapters/inbound/assistant-telegram-admin.js';
import { PostgresAssistantImages } from './adapters/outbound/postgres-assistant-images.js';
import { ProviderAssistantImageGenerator } from './adapters/outbound/assistant-image-generator.js';
import { AssistantImageAdmin } from './adapters/inbound/assistant-image-admin.js';
import { TelegramAssistantPhoto } from './adapters/outbound/telegram-assistant-photo.js';
import type { Config } from './domain/config.js';
import { modelAllowsApplicationTool } from './domain/ai-tools.js';
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
import { loadRuntimeConfig } from './adapters/outbound/runtime-config.js';
import { PostgresZeroSettings } from './adapters/outbound/postgres-zero-settings.js';
import { registerHomeAssistantControl } from './adapters/inbound/ha-control-tools.js';
import { Store } from './adapters/outbound/postgres-store.js';
import { Tools } from './application/tool-registry.js';
import { Codex } from './adapters/outbound/codex-app-server.js';
import { Google } from './adapters/outbound/google.js';
import { HomeAssistantExposure } from './adapters/outbound/home-assistant-exposure.js';
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
import { PostgresRules } from './adapters/outbound/postgres-rules.js';
import { PostgresPersonalData } from './adapters/outbound/postgres-personal-data.js';
import { Mem0Repository, withMem0PersonalData } from './adapters/outbound/mem0-repository.js';
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
import { ExtractMemory } from './application/memory-extraction.js';
import { Mem0Extractor } from './adapters/outbound/mem0-extractor.js';
import { PrepareNotification } from './application/use-cases/prepare-notification.js';
import { TelegramWebhook } from './adapters/outbound/telegram-webhook.js';
import { TelegramCommands } from './adapters/outbound/telegram-commands.js';
import { TelegramBots } from './adapters/inbound/telegram-bots.js';
import { PostgresAccess } from './adapters/outbound/postgres-access.js';
import { Access, scopedConfig } from './application/access.js';
import { AdminAuth } from './adapters/inbound/admin-auth.js';
import { Admin } from './adapters/inbound/admin.js';
import { GroupMembers } from './application/group-members.js';
import { PostgresGroupMembers } from './adapters/outbound/postgres-group-members.js';
import { GroupMembersAdmin } from './adapters/inbound/group-members-admin.js';
import { ProfileMemoryAdmin } from './adapters/inbound/profile-memory-admin.js';
import { ProfileMemories, memoryProfile } from './application/profile-memories.js';
import { localClock } from './domain/time.js';
import { isMemoryTool } from './domain/memory.js';
import {
  sessionAddress,
  telegramSession,
  toolCapability,
  type AccessProfile,
} from './domain/access.js';
import type { Job, ToolContext } from './domain/models.js';
import type { JobResult } from './application/use-cases/contracts.js';
import {
  registerGoogleTools,
  registerContextTools,
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
const databaseRuntime = await startDatabaseRuntime();
const exposeLocationEntities = (
  connection: Config['homeAssistant'],
  entities: string[],
  confirmed: boolean,
) => new HomeAssistantExposure(connection).locations(entities, confirmed);
const config = await loadRuntimeConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const store = await Store.open(
  config.database.url,
  config.memory.embeddingDimensions,
  'public',
  new GeminiEmbeddings(config.memory).space,
);
const serviceSettings = new PostgresServiceSettings(
  store.db,
  process.env.ASSISTANT_SECRETS_KEY || config.apiKey,
);
const edgeSpeechCatalog = new EdgeSpeechCatalog();
const aiSettings = new PostgresAI(store.db, process.env.ASSISTANT_SECRETS_KEY || config.apiKey);
await aiSettings.initialize(config.codex.model);
const configuredEmbeddings = new ConfiguredEmbeddings(aiSettings, (settings, providers) =>
  memoryEmbeddings(config.memory, settings, providers),
);
const memoryReranker: ModelMemoryReranker = new ModelMemoryReranker(
  aiSettings,
  (provider, model) =>
    provider.kind === 'codex'
      ? codexCli
      : new HttpAIAgent(provider, model, store, async () => new Tools(store)),
  httpRerank,
);
const memoryRepository = new Mem0Repository(store.pool, config.memory.embeddingDimensions, store);
await memoryRepository.assertMigrated();
const tools = new Tools(store),
  google = taskServices(config),
  ha = new HomeAssistant(config.homeAssistant),
  memory = new Memory(config.memory, memoryRepository, configuredEmbeddings, memoryReranker),
  media = new Media(config),
  telegram = new Telegram(config, media);
registerGoogleTools(tools, google);
registerHomeAssistantTools(tools, ha, config.homeAssistant);
registerMemoryTools(tools, memory, config.memory.mode);
registerSearch(tools, config.braveApiKey, config.reader);
const accessRepository = new PostgresAccess(
  store.db,
  process.env.ASSISTANT_SECRETS_KEY || config.apiKey,
);
await accessRepository.initialize(config);
const morningTriggerPort = new HomeAssistantMorningTriggers();
const morningTriggers = new MorningTriggers(morningTriggerPort, store);
const retiredServices = await serviceSettings.read();
await migrateProfileSchedules(
  retiredServices.value,
  config,
  accessRepository,
  store,
  morningTriggerPort,
);
if (
  'schedules' in retiredServices.value &&
  !(await serviceSettings.update(
    retiredServices.revision,
    ServiceConfigSchema.parse(retiredServices.value),
  ))
)
  throw new Error(
    'Service settings changed while importing profile schedules. Restart after inspecting the saved profile preferences.',
  );
const userContext = new UserContext(accessRepository);
async function homeAssistantConnection() {
  if (config.homeAssistant.token) return config.homeAssistant;
  const bindings = (await zeroSettings.read()).homeAssistantUsers || {};
  for (const chatId of new Set(Object.values(bindings))) {
    const binding = homeAssistantBinding(chatId);
    const profile = binding && (await accessRepository.profile(binding.bot, binding.chatId));
    if (profile?.enabled && profile.homeAssistant?.token) return profile.homeAssistant;
  }
  return config.homeAssistant;
}
async function ensureHomeAssistantUser(userId: string, label = userId) {
  if (!/^[a-f0-9]{32}$/.test(userId)) return;
  if (Object.hasOwn((await zeroSettings.read()).homeAssistantUsers || {}, userId)) return;
  await accessRepository.ensureHomeAssistantUser(userId, label, await homeAssistantConnection());
}
async function discoverHomeAssistantUsers() {
  const connection = await homeAssistantConnection();
  if (!connection.url || !connection.token) return;
  const users = await homeAssistantCommand(
    connection,
    { type: 'config/auth/list' },
    AbortSignal.timeout(15000),
  );
  if (!Array.isArray(users)) throw new Error('Invalid Home Assistant users response');
  const bindings = (await zeroSettings.read()).homeAssistantUsers || {};
  for (const user of users)
    if (user.is_active && !user.system_generated && !Object.hasOwn(bindings, user.id))
      await ensureHomeAssistantUser(user.id, user.name || user.id);
}
const assistantImages = new PostgresAssistantImages(store.db);
await assistantImages.initialize();
const assistantDefinitions = new AssistantDefinitions(
  new PostgresAssistantDefinitions(store.db),
  randomUUID,
);
const adminAuth = new AdminAuth(
  store.db,
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
  {
    enabled: process.env.ASSISTANT_HA_INGRESS === '1',
    async isAdministrator(id) {
      const token = process.env.SUPERVISOR_TOKEN;
      if (!token) return false;
      const users = await homeAssistantCommand(
        { ...config.homeAssistant, url: 'http://supervisor/core', token },
        { type: 'config/auth/list' },
        AbortSignal.timeout(10000),
      );
      return (
        Array.isArray(users) &&
        users.some(
          (user) =>
            user.id === id &&
            user.is_active &&
            !user.system_generated &&
            (user.is_owner || user.group_ids?.includes('system-admin')),
        )
      );
    },
  },
  new HomeAssistantMobileRecovery(async (chatId) => {
    const profile = await accessRepository.profile('zero', chatId);
    if (
      !profile?.enabled ||
      profile.kind !== 'user' ||
      !profile.capabilities.includes('homeAssistant') ||
      !profile.homeAssistant?.token
    )
      return undefined;
    const bindings = (await zeroSettings.read()).homeAssistantUsers || {};
    const userId = chatId.startsWith('ha:')
      ? chatId.slice(3)
      : Object.entries(bindings).find(([, chat]) => chat === chatId)?.[0];
    return userId ? { userId, config: profile.homeAssistant } : undefined;
  }),
  (language, transaction) => zeroSettings.initializeLanguage(language, transaction),
);
await adminAuth.initialize();
const integrationRepository = new PostgresIntegrationAccess(store.db);
await integrationRepository.initialize();
const integrationAccess = new IntegrationAccess(integrationRepository, credentialCrypto);

const groupMembers = new PostgresGroupMembers(store.db);
const groupMemberService = new GroupMembers(groupMembers);
const access: Access = new Access(
  accessRepository,
  store,
  (bot) => bots.username(bot),
  groupMemberService,
);
const bots = new TelegramBots(
  config,
  media,
  telegram,
  store,
  access,
  async (id) => (await assistantDefinitions.get(id))?.name || 'Assistant',
);
const ruleRepository = new PostgresRules(store.db);
await ruleRepository.initialize();
const localRuleScheduler = new LocalRuleScheduler(ruleRepository);
const places = new OpenStreetMapPlaces(config.places?.photonUrl, config.places?.osrmUrl);
const connectionUrl = () => config.connectionUrl || adminAuth.origin;
const assistantTelegram = new AssistantTelegram(
  accessRepository,
  config.telegram,
  connectionUrl,
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

const personalData = withMem0PersonalData(memoryRepository, new PostgresPersonalData(store.db));
const rules = new NotificationRules(
  ruleRepository,
  async (session, kind, schedulerKey) => {
    const address = sessionAddress(session);
    const profile = await access.forSession(session);
    const scoped = profile ? scopedConfig(config, profile) : config;
    const homeAssistantScheduler =
      kind !== 'alert'
        ? new HomeAssistantRuleScheduler(config.homeAssistant)
        : profile?.capabilities.includes('homeAssistant') && scoped.homeAssistant.token
          ? new HomeAssistantRuleScheduler(scoped.homeAssistant)
          : undefined;
    const scheduler = selectRuleScheduler(
      kind,
      schedulerKey,
      localRuleScheduler,
      homeAssistantScheduler,
    );
    return {
      enabled:
        !!address &&
        !!profile?.enabled &&
        (await bots.isEnabled(address.bot)) &&
        (kind !== 'alert' ||
          (profile.capabilities.includes('homeAssistant') && !!scoped.homeAssistant.token)),
      scheduler,
    };
  },
  async (session) => {
    const profile = await access.forSession(session);
    return {
      enabled: !!profile?.enabled && profileNotifications(profile).morning.mode === 'entity',
      date: localClock(new Date(), profile?.timezone || config.timezone).day,
    };
  },
);
const localDeadlineWorker = new LocalDeadlineWorker(
  ruleRepository,
  (event) => rules.receive(event, true),
  (rule) => rules.canNotify(rule),
  () => credentialCrypto.id(),
  () => new Date(),
  () => console.error(JSON.stringify({ event: 'local_deadline_worker_failed' })),
);
const ruleRetention = new RuleRetention(
  ruleRepository,
  () => new Date(),
  () => console.error(JSON.stringify({ event: 'rule_retention_failed' })),
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
      rule.assistant_request !== job.payload.assistantRequest ||
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
  const memory = new Memory(scoped.memory, memoryRepository, configuredEmbeddings, memoryReranker);
  const settings = await zeroSettings.read();
  const permitted = (name: string) => {
    if (!modelAllowsApplicationTool(context.aiModel, name)) return false;
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
      if (!modelAllowsApplicationTool(context.aiModel, name)) return false;
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
  registerContextTools(tools, userContext, profile?.contextRevision || 0, !!profile);
  registerHomeAssistantTools(
    tools,
    ha,
    scoped.homeAssistant,
    profile?.kind === 'group'
      ? {
          async list(search, offset, limit) {
            const page = await groupMembers.list(
              profile.bot,
              profile.chatId,
              search,
              offset,
              limit,
            );
            return {
              ...page,
              items: page.items.map(
                ({ userId, name, username, present, locationEntity, geocodedLocationEntity }) => ({
                  userId,
                  name,
                  username,
                  present,
                  locationAssigned: !!(locationEntity || geocodedLocationEntity),
                }),
              ),
            };
          },
          async location(userId, signal) {
            const entities = await groupMemberService.locationEntities(
              profile.bot,
              profile.chatId,
              userId,
            );
            return new HomeAssistant({ ...scoped.homeAssistant, ...entities }).location(signal);
          },
        }
      : undefined,
    profile?.kind === 'user'
      ? (entity, confirmed) =>
          new PersonalLocation(
            accessRepository,
            config.homeAssistant,
            exposeLocationEntities,
          ).assign(context.session, entity, confirmed)
      : undefined,
  );
  if (profile?.owner) registerHomeAssistantControl(tools, ha, zeroSettings);
  registerMemoryTools(tools, memory, scoped.memory.mode);
  registerSearch(tools, scoped.braveApiKey, scoped.reader);
  registerNotificationTools(
    tools,
    rules,
    scoped.homeAssistant.token ? ha : undefined,
    profile?.kind === 'user' ? () => scoped.homeAssistant.locationEntity : undefined,
  );
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
const zeroSettings = new PostgresZeroSettings(store.db, accessRepository);
const pairing = new HomeAssistantPairing(
  accessRepository,
  new PostgresPairing(store.db, accessRepository, zeroSettings),
  credentialCrypto,
  config.homeAssistant,
  adminAuth.origin,
  undefined,
  connectionUrl,
);
await zeroSettings.initialize(prompts.main || defaultZeroPrompt);
const codexCli = new Codex(
  config,
  store,
  tools,
  async (context) => (await services(context)).tools,
);
const codex = new AIAgent(
    aiSettings,
    (session) => access.forSession(session),
    codexCli,
    (provider, model) =>
      provider.kind === 'home_assistant'
        ? new HomeAssistantAI(
            model.model,
            store,
            async (context) => (await services(context)).config.homeAssistant,
            async (context) => (await services(context)).tools,
          )
        : new HttpAIAgent(
            provider,
            model,
            store,
            async (context) => (await services(context)).tools,
          ),
    async (session, model) => {
      const address = sessionAddress(session);
      return address ? accessRepository.selectModel(address.bot, address.chatId, model) : false;
    },
  ),
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
      // Old queued consolidation jobs are retired without replaying historical messages.
      consolidate: async () => ({ output: 'Scheduled consolidation retired', deliver: false }),
      memory_extract: (job, context) =>
        new ExtractMemory(new Mem0Extractor(codex), async () => {
          const scope = await services(context);
          return {
            memory: scope.memory,
            profile: scope.config.memory.sharedProfile || job.session,
            timezone: scope.config.timezone,
            enabled: scope.config.memory.mode !== 'none' && (await canRespond(job)),
          };
        }).execute(job.payload.turn, context),
      morning: notify,
      event_reminders: notify,
      rule_notification: async (job, context) =>
        rules.notification(
          job,
          async (pending) => {
            const change = weatherChangeSchema.safeParse(pending || job.payload.weather);
            if (!change.success) return { output: '', deliver: false };
            const scoped = await services(context);
            return new WeatherNotification(codex, undefined, scoped.profile?.replyLanguage).update(
              change.data,
              job.payload.firedAt,
              scoped.config.timezone,
              context,
              scoped.profile?.capabilities.includes('calendar') ? scoped.google : undefined,
              (reported) => rules.weatherDelivered(job, reported),
            );
          },
          (await access.forSession(job.session))?.replyLanguage,
          (request) => processManagedMessage.executeNotification(job, context, request),
        ),
      reset: async (job) => {
        await store.reset(job.session);
        const profile = await access.forSession(job.session);
        return profile?.enabled &&
          profileNotifications(profile).reset.enabled &&
          (await canRespond(job))
          ? {
              output: replyText(
                profile?.replyLanguage,
                'Zero: Nueva Sesión Iniciada',
                'Zero: New Session Started',
              ),
              voice: false,
            }
          : { output: '', deliver: false };
      },
    },
    media,
    telegram,
    (job) => bots.get(sessionAddress(job.session)?.bot || 'zero', job.session),
    canRespond,
    async (job) => (await access.forSession(job.session))?.voiceReplies !== false,
  ),
  scheduler = new Scheduler(
    store,
    async (session) => {
      const address = sessionAddress(session);
      const profile = await access.forSession(session);
      const scoped = profile ? scopedConfig(config, profile) : config;
      return {
        enabled: !address || !!profile?.enabled,
        timezone: profile?.timezone || config.timezone,
        notifications: profileNotifications(profile),
        calendar: notificationServices(scoped, profile).calendar,
      };
    },
    async () => {
      const sessions: string[] = [];
      const wakeProfiles: { profile: AccessProfile; config: Config }[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await accessRepository.profiles('', offset, 100);
        for (const profile of page.items)
          await importMorningTrigger(
            profile,
            scopedConfig(config, profile),
            accessRepository,
            morningTriggerPort,
          );
        wakeProfiles.push(
          ...page.items.map((profile) => ({ profile, config: scopedConfig(config, profile) })),
        );
        sessions.push(
          ...page.items
            .filter((p) => p.enabled && !p.chatId.startsWith('ha:'))
            .map((p) => telegramSession(p.bot, p.chatId)),
        );
        if (offset + page.items.length >= page.total || !page.items.length) break;
      }
      morningTriggers.refresh(wakeProfiles);
      return sessions;
    },
  ),
  admin = new Admin(
    config,
    accessRepository,
    async (token) => {
      const candidate = new Telegram(
        { ...config, telegram: { ...config.telegram, token } },
        media,
        'Assistant',
      );
      await candidate.call('getMe', {}, AbortSignal.timeout(10000));
    },
    new TelegramWebhook(
      (settings) =>
        new Telegram(
          { ...config, telegram: { ...config.telegram, token: settings.token } },
          media,
          'Assistant',
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
    async (bot, chatId) =>
      chatId.startsWith('ha:') ? undefined : (await bots.get(bot))?.profilePhoto(chatId),
    userContext,
    discoverHomeAssistantUsers,
    new AIAdmin(
      aiSettings,
      async (query, signal) =>
        HomeAssistantAI.catalog(await homeAssistantConnection(), query, signal),
      aiModelCatalog(
        (cursor, limit) => codexCli.models(cursor, limit),
        async (_provider, query, signal) => {
          return HomeAssistantAI.catalog(await homeAssistantConnection(), query, signal);
        },
      ),
      new EmbeddingAdmin(
        {
          model: config.memory.embeddingModel,
          apiKey: config.memory.geminiApiKey,
          dimensions: config.memory.embeddingDimensions,
        },
        (settings, query, signal, provider) =>
          embeddingCatalog(settings, query, signal, fetch, provider),
        async (settings, provider) => {
          const vector = await memoryEmbeddings(
            config.memory,
            settings,
            provider ? [provider] : [],
          ).embed('Embedding connection test.', 'RETRIEVAL_QUERY', AbortSignal.timeout(15000));
          return { dimensions: vector.length };
        },
      ),
      new ReprocessMemory(memoryRepository, configuredEmbeddings),
      async () => {
        const ranker = new ModelMemoryReranker(
          aiSettings,
          (provider, model) =>
            provider.kind === 'codex'
              ? codexCli
              : new HttpAIAgent(provider, model, store, async () => new Tools(store)),
          httpRerank,
          true,
        );
        const metadata = { category: 'Test', tags: [], created_at: new Date().toISOString() };
        await ranker.rank(
          'system:reranking-test',
          'Which document mentions an apple?',
          [
            {
              id: '1',
              text: 'An apple is a fruit.',
              summary: null,
              superseded_by: null,
              similarity: 0,
              metadata,
            },
            {
              id: '2',
              text: 'A bicycle has two wheels.',
              summary: null,
              superseded_by: null,
              similarity: 0,
              metadata,
            },
          ],
          AbortSignal.timeout(15000),
        );
      },
      () => codexCli.available(),
    ),
    (scoped) => new Google(scoped.google, scoped.timezone),
    new ProfileMemoryAdmin(
      accessRepository,
      new ProfileMemories(memoryRepository, personalData, async (profile) => {
        const effective = await memoryProfile(
          profile,
          accessRepository,
          async () => (await zeroSettings.read()).homeAssistantUsers || {},
        );
        const scoped = scopedConfig(config, effective);
        return {
          key: scoped.memory.sharedProfile || telegramSession(effective.bot, effective.chatId),
          enabled: scoped.memory.mode !== 'none',
          shared: !!scoped.memory.sharedProfile,
          linked: effective !== profile,
          memory: new Memory(scoped.memory, memoryRepository, configuredEmbeddings, memoryReranker),
        };
      }),
    ),
    new GroupMembersAdmin(
      accessRepository,
      groupMembers,
      exposeLocationEntities,
      (profile) => scopedConfig(config, profile).homeAssistant,
    ),
    rules,
  )
    .withLocationExposure(exposeLocationEntities)
    .withHomeAssistantConnection(homeAssistantConnection)
    .withHomeAssistantConnections(
      new HomeAssistantConnections(
        zeroSettings,
        accessRepository,
        new PostgresHomeAssistantConnections(store.db, accessRepository),
      ),
    )
    .withGoogleDestinations(
      new GoogleDestinations(
        accessRepository,
        config,
        (scoped) => new Google(scoped.google, scoped.timezone),
      ),
    ),
  server = createHttpServer(
    config,
    store,
    readFileSync('assets/icon.png'),
    {
      access,
      admin,
      auth: adminAuth,
      googleOAuth: new GoogleOAuthAdmin(
        new GoogleConnection(
          accessRepository,
          new GoogleOAuth(),
          () => connectionUrl() + googleCallbackPath,
          config.google,
          config.homeAssistant.taskProvider,
        ),
        adminAuth.origin,
      ),
    },
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
      async (userId) => {
        await ensureHomeAssistantUser(userId);
        return voiceUserSession(userId, zeroSettings, access, haClient);
      },
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
          new ProviderAssistantImageGenerator(
            aiSettings,
            fetch,
            (model, prompt, signal, references) =>
              codexCli.generateAvatar(model, prompt, signal, references),
          ),
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
      new ServiceSettingsAdmin(
        serviceSettings,
        async (saved) => {
          // Normalize optional persisted settings to the same defaults used at startup.
          const value = ServiceConfigSchema.parse(saved);
          // Replace only infrastructure settings. In-flight scoped jobs keep their snapshot.
          config.connectionUrl = value.connectionUrl;
          config.timezone = value.timezone;
          config.concurrency = value.concurrency;
          // Polling clients share this object; scoped jobs copy it when they start.
          Object.assign(config.media, structuredClone(value.media));
          if (!value.media.speech) delete config.media.speech;
          Object.assign(config.reader, value.reader);
          config.braveApiKey = value.braveApiKey;
          config.places = {
            photonUrl:
              process.env.ASSISTANT_PHOTON_URL ||
              value.places?.photonUrl ||
              'https://photon.komoot.io',
            osrmUrl:
              process.env.ASSISTANT_OSRM_URL ||
              value.places?.osrmUrl ||
              'https://router.project-osrm.org',
          };
          places.configure(config.places.photonUrl, config.places.osrmUrl);
        },
        (kind, language, query, signal) => edgeSpeechCatalog.page(kind, language, query, signal),
        () => adminAuth.origin,
      ),
      async (userId, bot, chatId) => {
        const profile = await accessRepository.profile(bot, chatId);
        const connection =
          profile?.pairedHomeAssistant || profile?.homeAssistant || config.homeAssistant;
        return homeAssistantUserName(connection, userId);
      },
      connectionUrl,
    ),
    new PublicConnection(
      serviceSettings,
      (url) => {
        config.connectionUrl = url;
      },
      adminAuth.origin,
      process.env.ASSISTANT_ADMIN_URL || '',
    ),
  );

async function notify(job: Job, context: ToolContext): Promise<JobResult> {
  if (!(await canRespond(job))) return { output: '', deliver: false };
  const scope = await services(context);
  if (
    scope.profile &&
    ((job.payload.kind === 'event_reminders' &&
      (!scope.profile.capabilities.includes('calendar') ||
        !profileNotifications(scope.profile).eventReminders)) ||
      (job.payload.kind === 'morning' && scope.profile.notifications?.morning.mode === 'off'))
  )
    return { output: '', deliver: false };
  const source = job.payload.morningTrigger;
  if (
    source &&
    scope.profile &&
    (scope.profile.notifications?.morning.mode !== 'entity' ||
      source.entity !== scope.profile.notifications.morning.entity ||
      source.state !== scope.profile.notifications.morning.state)
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
    scope.profile?.context || '',
    notificationServices(scope.config, scope.profile),
    scope.profile?.label,
    profileNotifications(scope.profile).eventReminderMinutes,
    scope.memory,
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
  localDeadlineWorker.start();
  ruleRetention.start();
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
    }),
  );
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  scheduler.close();
  morningTriggers.close();
  await localDeadlineWorker.close();
  await ruleRetention.close();
  await discovery.close();
  await bots.close();
  server.close();
  const deadline = setTimeout(() => process.exit(1), 15_000);
  deadline.unref();
  await assistant.close();
  codexCli.close();
  await store.close();
  await databaseRuntime?.close();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
