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
      CREATE TABLE IF NOT EXISTS managed_bots(id TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT false, token TEXT NOT NULL);
      ALTER TABLE managed_bots ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
      ALTER TABLE managed_bots ADD COLUMN IF NOT EXISTS webhook_url TEXT;`);
    // Seed exactly once, so disabling an existing owner survives a restart.
    for (const [index, chatId] of config.telegram.allowedUsers.entries()) {
      if (!/^\d+$/.test(chatId)) continue;
      await this.pool.query(
        `INSERT INTO access_profiles(bot,chat_id,kind,label,enabled,capabilities,owner)
        VALUES('zero',$1,'user',$2,true,$3,$4) ON CONFLICT DO NOTHING`,
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
      ...(row.credentials ? this.decrypt(row.credentials, `${row.bot}:${row.chat_id}`) : {}),
    };
  }
  async profile(bot: BotId, chatId: string) {
    const { rows } = await this.pool.query(
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
  async saveProfile(profile: AccessProfile) {
    const credentials = this.encrypt(
      { google: profile.google, homeAssistant: profile.homeAssistant },
      `${profile.bot}:${profile.chatId}`,
    );
    await this.pool.query(
      `INSERT INTO access_profiles(bot,chat_id,kind,label,enabled,capabilities,owner,credentials) VALUES($1,$2,$3,$4,$5,$6,false,$7)
      ON CONFLICT(bot,chat_id) DO UPDATE SET kind=EXCLUDED.kind,label=EXCLUDED.label,enabled=EXCLUDED.enabled,capabilities=EXCLUDED.capabilities,credentials=EXCLUDED.credentials`,
      [
        profile.bot,
        profile.chatId,
        profile.kind,
        profile.label,
        profile.enabled,
        JSON.stringify(profile.capabilities),
        credentials,
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
