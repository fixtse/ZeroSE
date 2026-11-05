import { requiredGoogleScopes } from '../../application/google-connection.js';
import {
  and,
  count,
  eq,
  getTableColumns,
  inArray,
  isNull,
  notExists,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  accessProfiles as profiles,
  managedBots as bots,
  profileDeletions,
} from './database-schema.js';
import { databaseErrorCode, type Database, type SqlExecutor } from './database.js';
import { PostgresAssistantDefinitions } from './postgres-assistant-definitions.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AccessRepository } from '../../application/access.js';
import {
  capabilities,
  type AccessProfile,
  type BotId,
  type BotSettings,
} from '../../domain/access.js';
import type { Config } from '../../domain/config.js';

export class PostgresAccess implements AccessRepository {
  private key: Buffer;
  constructor(
    private db: Database,
    secret: string,
  ) {
    if (secret.length < 16)
      throw new Error('Administration API key must have at least 16 characters');
    this.key = createHash('sha256')
      .update('assistant-credentials-v1:' + secret)
      .digest();
  }
  private encrypt(value: unknown, scope: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(scope));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
  }
  private decrypt(value: string, scope: string) {
    const [iv, tag, data] = value.split('.').map((v) => Buffer.from(v, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(scope));
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
  }
  async initialize(config: Config) {
    await new PostgresAssistantDefinitions(this.db).initialize();
    // Saved connection settings and administrator decisions remain authoritative.
    await this.db
      .insert(bots)
      .values({
        id: 'zero',
        enabled: !!config.telegram.token && config.telegram.transport !== 'disabled',
        token: this.encrypt(config.telegram.token, 'bot:zero'),
        webhook_secret: config.telegram.webhookSecret
          ? this.encrypt(config.telegram.webhookSecret, 'webhook:zero')
          : null,
        transport: config.telegram.transport,
        account_id: config.telegram.token.split(':')[0] || null,
      })
      .onConflictDoNothing({ target: bots.id });
    const existing = await this.db
      .select({
        id: bots.id,
        webhook_url: bots.webhook_url,
        token: bots.token,
        account_id: bots.account_id,
      })
      .from(bots);
    for (const row of existing) {
      if (!row.account_id) {
        const account = String(this.decrypt(row.token, `bot:${row.id}`)).split(':')[0];
        if (account)
          await this.db
            .update(bots)
            .set({ account_id: account })
            .where(and(eq(bots.id, row.id), isNull(bots.account_id)));
      }
      try {
        const url = new URL(row.webhook_url || '');
        if (
          url.pathname === '/telegram/webhook' ||
          url.pathname === '/telegram/' + row.id + '/webhook'
        ) {
          url.pathname = '/telegram/assistants/' + row.id + '/webhook';
          await this.db
            .update(bots)
            .set({ webhook_url: url.toString(), revision: sql`${bots.revision} + 1` })
            .where(eq(bots.id, row.id));
        }
      } catch {
        /* Invalid historical URLs require an explicit administrator edit. */
      }
    }
    for (const [index, chatId] of config.telegram.allowedUsers.entries()) {
      if (!/^\d+$/.test(chatId)) continue;
      await this.db
        .insert(profiles)
        .select(
          this.profileSeed({
            bot: 'zero',
            chat_id: chatId,
            kind: 'user',
            label: index === 0 ? 'Administrador de Zero' : chatId,
            enabled: true,
            capabilities: index === 0 ? [...capabilities] : ['web', 'transcription'],
            owner: index === 0,
          }),
        )
        .onConflictDoNothing();
    }
  }
  /** Keep the tombstone check and insert in one statement, including under concurrent discovery. */
  private profileSeed(value: typeof profiles.$inferInsert) {
    const row: typeof profiles.$inferSelect = {
      enabled: false,
      approved: !!value.enabled,
      capabilities: ['web', 'transcription'],
      owner: false,
      credentials: null,
      linked_chat_id: null,
      context: '',
      context_revision: 0,
      memory_mode: 'advanced',
      timezone: null,
      voice_replies: true,
      respond_to_replies: true,
      prompt_preset: null,
      assistant_id: null,
      ...value,
    };
    const columns = getTableColumns(profiles);
    const fields = Object.fromEntries(
      Object.entries(columns).map(([key, column]) => [
        key,
        sql`${sql.param(row[key as keyof typeof row], column)}`.as(key),
      ]),
    ) as Record<keyof typeof row, SQL.Aliased>;
    return this.db
      .select(fields)
      .from(sql`(values (1)) as seed`)
      .where(
        notExists(
          this.db
            .select({ bot: profileDeletions.bot })
            .from(profileDeletions)
            .where(
              and(eq(profileDeletions.bot, value.bot), eq(profileDeletions.chat_id, value.chat_id)),
            ),
        ),
      );
  }
  private decode(row: typeof profiles.$inferSelect): AccessProfile {
    return {
      bot: row.bot,
      chatId: row.chat_id,
      kind: row.kind,
      label: row.label,
      enabled: row.enabled,
      approved: row.approved || row.enabled,
      capabilities: row.capabilities,
      owner: row.owner,
      context: row.context || '',
      contextRevision: row.context_revision || 0,
      memoryMode: row.memory_mode || 'advanced',
      timezone: row.timezone || undefined,
      voiceReplies: row.voice_replies,
      respondToReplies: row.respond_to_replies,
      ...(row.assistant_id ? { assistantId: row.assistant_id } : {}),
      ...(row.prompt_preset ? { memoryPolicy: row.prompt_preset } : {}),
      ...(row.credentials ? this.decrypt(row.credentials, `${row.bot}:${row.chat_id}`) : {}),
    };
  }
  async profile(bot: BotId, chatId: string, database: SqlExecutor = this.db) {
    const [row] = await database
      .select()
      .from(profiles)
      .where(and(eq(profiles.bot, bot), eq(profiles.chat_id, chatId)));
    return row ? this.decode(row) : undefined;
  }
  async replaceGoogleConnection(
    bot: BotId,
    chatId: string,
    expected: Config['google'] | undefined,
    google: Config['google'],
    scopes: string[],
    ownerTaskProvider: string,
  ) {
    return this.db.transaction(async (database) => {
      const [row] = await database
        .select()
        .from(profiles)
        .where(and(eq(profiles.bot, bot), eq(profiles.chat_id, chatId)))
        .for('update');
      if (!row) return false;
      const profile = this.decode(row);
      if (
        JSON.stringify(profile.google) !== JSON.stringify(expected) ||
        JSON.stringify(requiredGoogleScopes(profile, ownerTaskProvider)) !== JSON.stringify(scopes)
      )
        return false;
      // Re-read under the lock to preserve other credentials and profile edits.
      await this.saveProfile({ ...profile, google }, database);
      return true;
    });
  }
  async profiles(search: string, offset: number, limit: number, pending = false) {
    const filter = and(
      isNull(profiles.linked_chat_id),
      sql`position(lower(${search}) in lower(${profiles.label} || ' ' || ${profiles.chat_id})) > 0`,
      pending ? and(eq(profiles.approved, false), eq(profiles.enabled, false)) : undefined,
    );
    const rows = await this.db
      .select({ ...getTableColumns(profiles), total: sql<number>`count(*) over()`.mapWith(Number) })
      .from(profiles)
      .where(filter)
      .orderBy(profiles.bot, profiles.kind, profiles.label, profiles.chat_id)
      .offset(offset)
      .limit(limit);
    const total =
      rows[0]?.total ??
      (await this.db.select({ total: count() }).from(profiles).where(filter))[0].total;
    return { items: rows.map((row) => this.decode(row)), total };
  }
  async pairingProfiles(search: string, offset: number, limit: number) {
    const filter = and(
      isNull(profiles.linked_chat_id),
      eq(profiles.enabled, true),
      inArray(profiles.kind, ['user', 'group']),
      sql`${profiles.chat_id} ~ '^-?[1-9][0-9]{0,15}$'`,
      sql`position(lower(${search}) in lower(${profiles.label} || ' ' || ${profiles.chat_id})) > 0`,
    );
    const items = await this.db
      .select({
        bot: profiles.bot,
        chatId: profiles.chat_id,
        label: profiles.label,
        kind: profiles.kind,
      })
      .from(profiles)
      .where(filter)
      .orderBy(profiles.kind, profiles.label, profiles.chat_id)
      .offset(offset)
      .limit(limit);
    const total = (await this.db.select({ total: count() }).from(profiles).where(filter))[0].total;
    return { items, total };
  }
  async saveProfile(profile: AccessProfile, database: SqlExecutor = this.db) {
    const credentials = this.encrypt(
      {
        google: profile.google,
        homeAssistant: profile.homeAssistant,
        pairedHomeAssistant: profile.pairedHomeAssistant,
        speech: profile.speech,
        replyLanguage: profile.replyLanguage,
        notifications: profile.notifications,
        morningImportAutomation: profile.morningImportAutomation,
        morningCallbackDefault: profile.morningCallbackDefault,
        morningCallbackTrigger: profile.morningCallbackTrigger,
        defaultModel: profile.defaultModel,
        alternateModels: profile.alternateModels,
      },
      `${profile.bot}:${profile.chatId}`,
    );
    await database
      .insert(profiles)
      .values({
        bot: profile.bot,
        chat_id: profile.chatId,
        kind: profile.kind,
        label: profile.label,
        enabled: profile.enabled,
        approved: !!profile.approved || profile.enabled,
        capabilities: profile.capabilities,
        owner: false,
        credentials,
        memory_mode: profile.memoryMode || 'advanced',
        timezone: profile.timezone || null,
        voice_replies: profile.voiceReplies ?? true,
        respond_to_replies: profile.respondToReplies ?? true,
        prompt_preset: profile.memoryPolicy || null,
        assistant_id: profile.assistantId || null,
      })
      .onConflictDoUpdate({
        target: [profiles.bot, profiles.chat_id],
        set: {
          kind: profile.kind,
          label: profile.label,
          enabled: profile.enabled,
          approved: sql`${profiles.approved} OR ${!!profile.approved || profile.enabled}`,
          capabilities: profile.capabilities,
          credentials,
          memory_mode: sql`coalesce(${profile.memoryMode || null}, ${profiles.memory_mode})`,
          timezone: sql`coalesce(${profile.timezone || null}, ${profiles.timezone})`,
          voice_replies: sql`coalesce(${profile.voiceReplies ?? null}, ${profiles.voice_replies})`,
          respond_to_replies: sql`coalesce(${profile.respondToReplies ?? null}, ${profiles.respond_to_replies})`,
          prompt_preset: sql`coalesce(${profile.memoryPolicy || null}, ${profiles.prompt_preset})`,
          assistant_id: profile.assistantId || null,
        },
      });
  }
  async updateContext(
    bot: BotId,
    chatId: string,
    text: string,
    revision: number,
    requireEnabled = true,
  ) {
    const [row] = await this.db
      .update(profiles)
      .set({ context: text, context_revision: sql`${profiles.context_revision} + 1` })
      .where(
        and(
          eq(profiles.bot, bot),
          eq(profiles.chat_id, chatId),
          eq(profiles.context_revision, revision),
          requireEnabled ? eq(profiles.enabled, true) : undefined,
        ),
      )
      .returning({ revision: profiles.context_revision });
    return row?.revision;
  }
  async ensureHomeAssistantUser(userId: string, label: string, config: Config['homeAssistant']) {
    const chatId = 'ha:' + userId;
    const credentials = this.encrypt({ homeAssistant: config }, `zero:${chatId}`);
    await this.db
      .insert(profiles)
      .select(
        this.profileSeed({
          bot: 'zero',
          chat_id: chatId,
          kind: 'user',
          label: label.slice(0, 100),
          enabled: true,
          capabilities: ['web', 'transcription', 'homeAssistant', 'tasks'],
          credentials,
        }),
      )
      .onConflictDoUpdate({
        target: [profiles.bot, profiles.chat_id],
        set: {
          label: sql`case when ${profiles.label} = ${userId} then ${label.slice(0, 100)} else ${profiles.label} end`,
        },
      });
  }
  async mergeHomeAssistantUser(userId: string, chatId: string, database: SqlExecutor) {
    await database
      .select({ chat_id: profiles.chat_id })
      .from(profiles)
      .where(and(eq(profiles.bot, 'zero'), inArray(profiles.chat_id, ['ha:' + userId, chatId])))
      .orderBy(profiles.chat_id)
      .for('update');
    const source = await this.profile('zero', 'ha:' + userId, database);
    const target = await this.profile('zero', chatId, database);
    if (!source || !target) return;
    await database
      .update(profiles)
      .set({ linked_chat_id: chatId })
      .where(and(eq(profiles.bot, 'zero'), eq(profiles.chat_id, 'ha:' + userId)));
    await this.saveProfile(
      {
        ...target,
        ...source,
        bot: target.bot,
        chatId: target.chatId,
        owner: target.owner,
        google: source.google || target.google,
        homeAssistant: {
          ...target.homeAssistant,
          ...source.homeAssistant,
        } as Config['homeAssistant'],
        speech: source.speech || target.speech,
        replyLanguage: source.replyLanguage || target.replyLanguage,
        assistantId: source.assistantId || target.assistantId,
      },
      database,
    );
    await database
      .update(profiles)
      .set({
        context: (source.contextRevision || 0) > 0 ? source.context || '' : target.context || '',
        context_revision: sql`${profiles.context_revision} + 1`,
      })
      .where(and(eq(profiles.bot, 'zero'), eq(profiles.chat_id, chatId)));
  }
  async removeProfile(bot: BotId, chatId: string) {
    return this.db.transaction(async (client) => {
      await client.insert(profileDeletions).values({ bot, chat_id: chatId }).onConflictDoNothing();
      await client.delete(profiles).where(and(eq(profiles.bot, bot), eq(profiles.chat_id, chatId)));
    });
  }
  async migrateGroup(bot: BotId, from: string, to: string) {
    const source = await this.profile(bot, from);
    if (!source || source.kind !== 'group') return;
    const credentials = this.encrypt(
      {
        google: source.google,
        homeAssistant: source.homeAssistant,
        speech: source.speech,
        replyLanguage: source.replyLanguage,
        notifications: source.notifications,
        morningImportAutomation: source.morningImportAutomation,
        morningCallbackDefault: source.morningCallbackDefault,
        morningCallbackTrigger: source.morningCallbackTrigger,
      },
      `${bot}:${to}`,
    );
    // Preserve existing destination decisions and keep the old chat's history intact.
    await this.db
      .insert(profiles)
      .select(
        this.profileSeed({
          bot,
          chat_id: to,
          kind: 'group',
          label: source.label,
          enabled: source.enabled,
          approved: source.approved || source.enabled,
          capabilities: source.capabilities,
          owner: false,
          credentials,
          memory_mode: source.memoryMode || 'advanced',
          timezone: source.timezone || null,
          voice_replies: source.voiceReplies !== false,
          respond_to_replies: source.respondToReplies !== false,
          prompt_preset: source.memoryPolicy || null,
          assistant_id: source.assistantId || null,
          context: source.context || '',
          context_revision: source.contextRevision || 0,
        }),
      )
      .onConflictDoNothing();
  }
  async discover(bot: BotId, chatId: string, label: string, kind: 'user' | 'group' = 'group') {
    await this.db
      .insert(profiles)
      .values({ bot, chat_id: chatId, kind, label })
      .onConflictDoNothing();
  }
  private decodeBot(row: typeof bots.$inferSelect): BotSettings {
    return {
      id: row.id,
      enabled: row.enabled,
      token: this.decrypt(row.token, `bot:${row.id}`),
      webhookSecret: row.webhook_secret
        ? this.decrypt(row.webhook_secret, `webhook:${row.id}`)
        : undefined,
      webhookUrl: row.webhook_url || undefined,
      transport: row.transport || undefined,
      revision: row.revision,
    };
  }
  async bot(id: string) {
    const [row] = await this.db.select().from(bots).where(eq(bots.id, id));
    return row ? this.decodeBot(row) : undefined;
  }
  async bots(): Promise<BotSettings[]> {
    return (await this.db.select().from(bots).orderBy(bots.id)).map((row) => this.decodeBot(row));
  }
  async saveConnection(value: BotSettings, revision: number) {
    const connection = {
      id: value.id,
      enabled: value.enabled,
      token: this.encrypt(value.token, `bot:${value.id}`),
      webhook_secret: value.webhookSecret
        ? this.encrypt(value.webhookSecret, `webhook:${value.id}`)
        : null,
      webhook_url: value.webhookUrl || '',
      transport: value.transport || 'webhook',
      account_id: value.token.split(':')[0] || null,
    };
    try {
      const rows =
        revision === 0
          ? await this.db
              .insert(bots)
              .values(connection)
              .onConflictDoNothing()
              .returning({ id: bots.id })
          : await this.db
              .update(bots)
              .set({ ...connection, revision: sql`${bots.revision} + 1` })
              .where(and(eq(bots.id, value.id), eq(bots.revision, revision)))
              .returning({ id: bots.id });
      return rows.length === 1;
    } catch (error) {
      if (databaseErrorCode(error) === '23505') return false;
      throw error;
    }
  }
  async saveBot(settings: BotSettings) {
    const value = {
      id: settings.id,
      enabled: settings.enabled,
      token: this.encrypt(settings.token, `bot:${settings.id}`),
      webhook_secret: settings.webhookSecret
        ? this.encrypt(settings.webhookSecret, `webhook:${settings.id}`)
        : null,
      webhook_url: settings.webhookUrl || null,
      transport: settings.transport || null,
      account_id: settings.token.split(':')[0] || null,
    };
    await this.db
      .insert(bots)
      .values(value)
      .onConflictDoUpdate({
        target: bots.id,
        set: {
          enabled: value.enabled,
          token: value.token,
          account_id: value.account_id,
          webhook_secret: sql`coalesce(${value.webhook_secret}, ${bots.webhook_secret})`,
          webhook_url: sql`coalesce(${value.webhook_url}, ${bots.webhook_url})`,
          transport: sql`coalesce(${value.transport}, ${bots.transport})`,
          revision: sql`${bots.revision} + 1`,
        },
      });
  }
}
