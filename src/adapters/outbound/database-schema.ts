import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  check,
  foreignKey,
  unique,
  primaryKey,
  customType,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AccessProfile, BotSettings } from '../../domain/access.js';
import type { MemoryMode } from '../../domain/memory.js';
import type { NotificationRule } from '../../domain/notification-rule.js';
import type { IntegrationCredential } from '../../domain/integration-access.js';
import type { ZeroSettings } from '../../application/zero-settings.js';
import type { MemoryPolicy } from '../../domain/assistant-definition.js';

const created = () => timestamp('created', { withTimezone: true }).notNull().defaultNow();

export const jobs = pgTable(
  'jobs',
  {
    id: text().primaryKey(),
    sequence: bigint({ mode: 'bigint' }).generatedByDefaultAsIdentity().unique('jobs_sequence_key'),
    session: text().notNull(),
    dedupe: text().unique('jobs_dedupe_key'),
    payload: jsonb().notNull(),
    status: text().notNull().default('pending'),
    output: text(),
    error: text(),
    created: created(),
  },
  (table) => [
    index('jobs_pending')
      .on(table.sequence)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex('jobs_running_session')
      .on(table.session)
      .where(sql`${table.status} = 'running'`),
  ],
);

export const sessions = pgTable('sessions', {
  id: text().primaryKey(),
  thread: text(),
  historyAfter: bigint('history_after', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  toolPolicy: text('tool_policy'),
});

export const messages = pgTable(
  'messages',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedByDefaultAsIdentity(),
    session: text().notNull(),
    role: text().notNull(),
    text: text().notNull(),
    consolidated: integer().notNull().default(0),
    created: created(),
  },
  (table) => [
    index('messages_session').on(table.session, table.id),
    index('messages_lexical').using('gin', sql`to_tsvector('simple', ${table.text})`),
  ],
);

export const schedules = pgTable('schedules', {
  key: text().primaryKey(),
  created: created(),
});

export const cursors = pgTable('cursors', {
  name: text().primaryKey(),
  value: bigint({ mode: 'number' }).notNull(),
});

export const aiSettings = pgTable(
  'ai_settings',
  {
    id: boolean().primaryKey().default(true),
    revision: integer().notNull(),
    value: text().notNull(),
  },
  (table) => [check('ai_settings_id_check', sql`${table.id}`)],
);

export const aiNextModels = pgTable('ai_next_models', {
  session: text().primaryKey(),
  model: text().notNull(),
});

export const serviceSettings = pgTable(
  'service_settings',
  {
    id: boolean().primaryKey().default(true),
    revision: integer().notNull(),
    value: text().notNull(),
  },
  (table) => [check('service_settings_id_check', sql`${table.id}`)],
);

export const assistantDefinitions = pgTable(
  'assistant_definitions',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    prompt: text(),
    revision: integer().notNull().default(1),
    preset: text().$type<MemoryPolicy>().notNull(),
    builtin: boolean().notNull().default(false),
  },
  (table) => [
    check('assistant_definitions_preset_check', sql`${table.preset} in ('automatic', 'explicit')`),
  ],
);

export const assistantImages = pgTable(
  'assistant_images',
  {
    assistantId: text('assistant_id').primaryKey(),
    image: text(),
    revision: integer().notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: 'assistant_images_assistant_id_fkey',
      columns: [table.assistantId],
      foreignColumns: [assistantDefinitions.id],
    }).onDelete('cascade'),
  ],
);

export const schemaVersion = pgTable('schema_version', {
  version: integer().primaryKey(),
  dimensions: integer().notNull(),
});

export const accessProfiles = pgTable(
  'access_profiles',
  {
    bot: text().notNull(),
    chat_id: text().notNull(),
    kind: text().$type<AccessProfile['kind']>().notNull(),
    label: text().notNull(),
    enabled: boolean().notNull().default(false),
    capabilities: jsonb()
      .$type<AccessProfile['capabilities']>()
      .notNull()
      .default(['web', 'transcription']),
    owner: boolean().notNull().default(false),
    credentials: text(),
    linked_chat_id: text(),
    context: text().notNull().default(''),
    context_revision: integer().notNull().default(0),
    memory_mode: text().$type<MemoryMode>().notNull().default('advanced'),
    timezone: text(),
    voice_replies: boolean().notNull().default(true),
    prompt_preset: text().$type<MemoryPolicy>(),
    assistant_id: text(),
  },
  (table) => [
    primaryKey({ name: 'access_profiles_pkey', columns: [table.bot, table.chat_id] }),
    foreignKey({
      name: 'access_profiles_assistant_id_fkey',
      columns: [table.assistant_id],
      foreignColumns: [assistantDefinitions.id],
    }),
    index('access_profiles_assistant_id').on(table.assistant_id),
    check(
      'access_profiles_memory_mode_check',
      sql`${table.memory_mode} in ('advanced', 'simple', 'none')`,
    ),
    check(
      'access_profiles_prompt_preset_check',
      sql`${table.prompt_preset} in ('explicit', 'automatic')`,
    ),
  ],
);

export const profileDeletions = pgTable(
  'access_profile_deletions',
  {
    bot: text().notNull(),
    chat_id: text().notNull(),
    deleted: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'access_profile_deletions_pkey', columns: [table.bot, table.chat_id] }),
  ],
);

export const managedBots = pgTable(
  'managed_bots',
  {
    id: text().primaryKey(),
    enabled: boolean().notNull().default(false),
    token: text().notNull(),
    webhook_secret: text(),
    webhook_url: text(),
    transport: text().$type<NonNullable<BotSettings['transport']>>(),
    revision: integer().notNull().default(1),
    account_id: text(),
  },
  (table) => [
    uniqueIndex('managed_bot_account_unique')
      .on(table.account_id)
      .where(sql`${table.account_id} IS NOT NULL`),
  ],
);

export const zeroSettings = pgTable(
  'zero_settings',
  {
    id: integer().primaryKey(),
    revision: integer().notNull(),
    value: jsonb().$type<Omit<ZeroSettings, 'revision'>>().notNull(),
  },
  (table) => [check('zero_settings_id_check', sql`${table.id} = 1`)],
);

export const integrationCredentials = pgTable('integration_credentials', {
  id: uuid().primaryKey(),
  digest: text().notNull().unique('integration_credentials_digest_key'),
  value: jsonb().$type<IntegrationCredential>().notNull(),
});

export const notificationRules = pgTable(
  'notification_rules',
  {
    id: text().primaryKey(),
    session: text().notNull(),
    value: jsonb().$type<NotificationRule>().notNull(),
    version: integer().notNull().default(0),
    created: created(),
  },
  (table) => [
    index('notification_rules_session').on(table.session, table.created, table.id),
    uniqueIndex('notification_rules_owner_weather')
      .on(table.session)
      .where(sql`${table.value}->>'managed'='owner_weather'`),
  ],
);

export const ruleEvents = pgTable(
  'notification_rule_events',
  {
    id: text().primaryKey(),
    rule_id: text().notNull(),
    created: created(),
  },
  (table) => [
    foreignKey({
      name: 'notification_rule_events_rule_id_fkey',
      columns: [table.rule_id],
      foreignColumns: [notificationRules.id],
    }),
  ],
);

// Dimensions are configured and checked by Store; this column also supports unembedded memories.
const embedding = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => JSON.parse(value) as number[],
});

export const memories = pgTable(
  'memories',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedByDefaultAsIdentity(),
    session: text().notNull(),
    text: text().notNull(),
    category: text().notNull(),
    tags: jsonb().$type<string[]>().notNull(),
    embedding: embedding(),
    source: text().unique('memories_source_key'),
    created: created(),
    embedding_space: text(),
    summary: text(),
    forgotten_at: timestamp({ withTimezone: true }),
    superseded_by: bigint({ mode: 'bigint' }),
  },
  (table) => [
    foreignKey({
      name: 'memories_superseded_by_fkey',
      columns: [table.superseded_by],
      foreignColumns: [table.id],
    }),
    index('memories_session').on(table.session, table.category, table.created),
    index('memories_lexical').using(
      'gin',
      sql`to_tsvector('simple', ${table.text} || ' ' || ${table.tags}::text)`,
    ),
  ],
);

/** Mem0 OSS's native pgvector payload. Numeric handles stay stable in Zero's tools. */
export const mem0Vectors = pgTable(
  'zero_mem0_vectors',
  {
    id: uuid().primaryKey(),
    vector: embedding(),
    payload: jsonb().$type<Record<string, unknown>>(),
  },
  (table) => [
    index('zero_mem0_vectors_scope').on(
      sql`(${table.payload}->>'user_id')`,
      sql`(${table.payload}->>'active')`,
    ),
  ],
);

export const mem0Records = pgTable(
  'zero_mem0_records',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedByDefaultAsIdentity(),
    session: text().notNull(),
    mem0_id: uuid().unique('zero_mem0_records_mem0_id_key'),
    source: text(),
    status: text().notNull().default('pending'),
    created: created(),
    superseded_by: bigint({ mode: 'bigint' }),
  },
  (table) => [
    uniqueIndex('zero_mem0_records_source').on(table.session, table.source),
    index('zero_mem0_records_session').on(table.session, table.status, table.created),
    check(
      'zero_mem0_records_status_check',
      sql`${table.status} in ('pending', 'ready', 'forgotten')`,
    ),
    foreignKey({
      name: 'zero_mem0_records_superseded_by_fkey',
      columns: [table.superseded_by],
      foreignColumns: [table.id],
    }),
  ],
);

export const audit = pgTable('audit', {
  id: bigint({ mode: 'bigint' }).primaryKey().generatedByDefaultAsIdentity(),
  job: text(),
  tool: text(),
  success: integer(),
  duration: integer(),
  created: created(),
});

export const imports = pgTable('imports', {
  key: text().primaryKey(),
  created: created(),
});

export const deploymentRuns = pgTable(
  'deployment_runs',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    run_id: text().notNull(),
    attempt: integer().notNull(),
    run_number: bigint({ mode: 'number' }).notNull(),
    sha: text().notNull(),
    status: text().notNull().default('pending'),
    detail: text(),
    created: created(),
    finished: timestamp({ withTimezone: true }),
  },
  (table) => [
    unique('deployment_runs_run_id_attempt_key').on(table.run_id, table.attempt),
    check(
      'deployment_runs_status_check',
      sql`${table.status} in ('pending', 'running', 'done', 'failed')`,
    ),
  ],
);

export const groupMembers = pgTable(
  'group_members',
  {
    bot: text().notNull(),
    chat_id: text().notNull(),
    user_id: text().notNull(),
    name: text().notNull(),
    username: text().notNull().default(''),
    present: boolean().notNull().default(true),
    observed: boolean().notNull().default(false),
    location_entity: text().notNull().default(''),
    geocoded_location_entity: text().notNull().default(''),
  },
  (table) => [
    primaryKey({ name: 'group_members_pkey', columns: [table.bot, table.chat_id, table.user_id] }),
    foreignKey({
      name: 'group_members_profile_fkey',
      columns: [table.bot, table.chat_id],
      foreignColumns: [accessProfiles.bot, accessProfiles.chat_id],
    }).onDelete('cascade'),
  ],
);
