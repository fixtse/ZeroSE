import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
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
    private pool: pg.Pool,
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
    await this.pool.query(`CREATE TABLE IF NOT EXISTS access_profiles (
      bot TEXT NOT NULL, chat_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT false, capabilities JSONB NOT NULL DEFAULT '["web","transcription"]',
      owner BOOLEAN NOT NULL DEFAULT false, credentials TEXT, PRIMARY KEY(bot,chat_id));
      ALTER TABLE access_profiles ADD COLUMN IF NOT EXISTS memory_mode TEXT NOT NULL DEFAULT 'advanced' CHECK(memory_mode IN ('advanced','simple','none'));
      ALTER TABLE access_profiles ADD COLUMN IF NOT EXISTS timezone TEXT;
      ALTER TABLE access_profiles ADD COLUMN IF NOT EXISTS voice_replies BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE access_profiles ADD COLUMN IF NOT EXISTS prompt_preset TEXT CHECK(prompt_preset IN ('salem','standard'));
      CREATE TABLE IF NOT EXISTS managed_bots(id TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT false, token TEXT NOT NULL);
      ALTER TABLE managed_bots ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
      ALTER TABLE managed_bots ADD COLUMN IF NOT EXISTS webhook_url TEXT;`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS access_profile_deletions (
      bot TEXT NOT NULL, chat_id TEXT NOT NULL, deleted TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(bot,chat_id));`);
    // Seed exactly once, so disabling an existing owner survives a restart.
    for (const [index, chatId] of config.telegram.allowedUsers.entries()) {
      if (!/^\d+$/.test(chatId)) continue;
      await this.pool.query(
        `INSERT INTO access_profiles(bot,chat_id,kind,label,enabled,capabilities,owner)
        SELECT 'zero',$1,'user',$2,true,$3,$4 WHERE NOT EXISTS (
          SELECT 1 FROM access_profile_deletions WHERE bot='zero' AND chat_id=$1)
        ON CONFLICT DO NOTHING`,
        [
          chatId,
          index === 0 ? 'Propietario de Zero' : chatId,
          JSON.stringify(index === 0 ? capabilities : ['web', 'transcription']),
          index === 0,
        ],
      );
    }
  }
  private decode(row: any): AccessProfile {
    return {
      bot: row.bot,
      chatId: row.chat_id,
      kind: row.kind,
      label: row.label,
      enabled: row.enabled,
      capabilities: row.capabilities,
      owner: row.owner,
      memoryMode: row.memory_mode || 'advanced',
      timezone: row.timezone || undefined,
      voiceReplies: row.voice_replies,
      ...(row.prompt_preset ? { promptPreset: row.prompt_preset } : {}),
      ...(row.credentials ? this.decrypt(row.credentials, `${row.bot}:${row.chat_id}`) : {}),
    };
  }
  async profile(bot: BotId, chatId: string, database: Pick<pg.Pool, 'query'> = this.pool) {
    const { rows } = await database.query(
      'SELECT * FROM access_profiles WHERE bot=$1 AND chat_id=$2',
      [bot, chatId],
    );
    return rows[0] ? this.decode(rows[0]) : undefined;
  }
  async profiles(search: string, offset: number, limit: number, pending = false) {
    const { rows } = await this.pool.query(
      `SELECT *, count(*) OVER() AS total FROM access_profiles WHERE position(lower($1) in lower(label || ' ' || chat_id)) > 0 AND (NOT $4 OR NOT enabled) ORDER BY bot,kind,label,chat_id OFFSET $2 LIMIT $3`,
      [search, offset, limit, pending],
    );
    const total = rows[0]
      ? Number(rows[0].total)
      : Number(
          (
            await this.pool.query(
              `SELECT count(*) FROM access_profiles WHERE position(lower($1) in lower(label || ' ' || chat_id)) > 0 AND (NOT $2 OR NOT enabled)`,
              [search, pending],
            )
          ).rows[0].count,
        );
    return { items: rows.map((row) => this.decode(row)), total };
  }
  async saveProfile(profile: AccessProfile, database: Pick<pg.Pool, 'query'> = this.pool) {
    const credentials = this.encrypt(
      { google: profile.google, homeAssistant: profile.homeAssistant, speech: profile.speech },
      `${profile.bot}:${profile.chatId}`,
    );
    await database.query(
      `INSERT INTO access_profiles(bot,chat_id,kind,label,enabled,capabilities,owner,credentials,memory_mode,timezone,voice_replies,prompt_preset) VALUES($1,$2,$3,$4,$5,$6,false,$7,COALESCE($8,'advanced'),$9,COALESCE($10,true),$11)
      ON CONFLICT(bot,chat_id) DO UPDATE SET kind=EXCLUDED.kind,label=EXCLUDED.label,enabled=EXCLUDED.enabled,capabilities=EXCLUDED.capabilities,credentials=EXCLUDED.credentials,memory_mode=COALESCE($8,access_profiles.memory_mode),timezone=COALESCE($9,access_profiles.timezone),voice_replies=COALESCE($10,access_profiles.voice_replies),prompt_preset=COALESCE($11,access_profiles.prompt_preset)`,
      [
        profile.bot,
        profile.chatId,
        profile.kind,
        profile.label,
        profile.enabled,
        JSON.stringify(profile.capabilities),
        credentials,
        profile.memoryMode || null,
        profile.timezone || null,
        profile.voiceReplies ?? null,
        profile.promptPreset || null,
      ],
    );
  }
  async removeProfile(bot: BotId, chatId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO access_profile_deletions(bot,chat_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [bot, chatId],
      );
      await client.query('DELETE FROM access_profiles WHERE bot=$1 AND chat_id=$2', [bot, chatId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async migrateGroup(bot: BotId, from: string, to: string) {
    const source = await this.profile(bot, from);
    if (!source || source.kind !== 'group') return;
    const credentials = this.encrypt(
      { google: source.google, homeAssistant: source.homeAssistant, speech: source.speech },
      `${bot}:${to}`,
    );
    // Preserve existing destination decisions and keep the old chat's history intact.
    await this.pool.query(
      `INSERT INTO access_profiles(bot,chat_id,kind,label,enabled,capabilities,owner,credentials,memory_mode,timezone,voice_replies,prompt_preset)
       SELECT $1,$2,'group',$3,$4,$5,false,$6,$7,$8,$9,$10 WHERE NOT EXISTS (
         SELECT 1 FROM access_profile_deletions WHERE bot=$1 AND chat_id=$2)
       ON CONFLICT DO NOTHING`,
      [
        bot,
        to,
        source.label,
        source.enabled,
        JSON.stringify(source.capabilities),
        credentials,
        source.memoryMode || 'advanced',
        source.timezone || null,
        source.voiceReplies !== false,
        source.promptPreset || null,
      ],
    );
  }
  async discover(bot: BotId, chatId: string, label: string, kind: 'user' | 'group' = 'group') {
    await this.pool.query(
      `INSERT INTO access_profiles(bot,chat_id,kind,label) VALUES($1,$2,$4,$3) ON CONFLICT DO NOTHING`,
      [bot, chatId, label, kind],
    );
  }
  async bots(): Promise<BotSettings[]> {
    const { rows } = await this.pool.query('SELECT * FROM managed_bots ORDER BY id');
    return rows.map((row) => ({
      id: row.id,
      enabled: row.enabled,
      token: this.decrypt(row.token, `bot:${row.id}`),
      webhookSecret: row.webhook_secret
        ? this.decrypt(row.webhook_secret, `webhook:${row.id}`)
        : undefined,
      webhookUrl: row.webhook_url || undefined,
    }));
  }
  async saveBot(settings: BotSettings) {
    await this.pool.query(
      'INSERT INTO managed_bots(id,enabled,token,webhook_secret,webhook_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled,token=EXCLUDED.token,webhook_secret=COALESCE(EXCLUDED.webhook_secret,managed_bots.webhook_secret),webhook_url=COALESCE(EXCLUDED.webhook_url,managed_bots.webhook_url)',
      [
        settings.id,
        settings.enabled,
        this.encrypt(settings.token, `bot:${settings.id}`),
        settings.webhookSecret
          ? this.encrypt(settings.webhookSecret, `webhook:${settings.id}`)
          : null,
        settings.webhookUrl || null,
      ],
    );
  }
}
