import { and, eq, sql } from 'drizzle-orm';
import { zeroSettings as settingsTable, accessProfiles as profiles } from './database-schema.js';
import { type Database, type SqlExecutor } from './database.js';
import type { PostgresAccess } from './postgres-access.js';
import type { ZeroSettings, ZeroSettingsPort } from '../../application/zero-settings.js';

export class PostgresZeroSettings implements ZeroSettingsPort {
  constructor(
    private db: Database,
    private profiles?: PostgresAccess,
  ) {}
  async initialize(prompt: string) {
    await this.db
      .insert(settingsTable)
      .values({
        id: 1,
        revision: 1,
        value: {
          prompt,
          homeAssistant: true,
          assist: false,
          frigate: false,
          services: [],
        },
      })
      .onConflictDoNothing();
  }
  async read(database: SqlExecutor = this.db): Promise<ZeroSettings> {
    const [row] = await database
      .select({ revision: settingsTable.revision, value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.id, 1));
    if (!row) throw new Error('Zero settings not initialized');
    return { ...row.value, revision: row.revision };
  }
  async update(
    value: ZeroSettings,
    database: SqlExecutor = this.db,
  ): Promise<ZeroSettings | undefined> {
    if (this.profiles && database === this.db) {
      return this.db.transaction((client) => this.update(value, client));
    }
    await database
      .select({ id: settingsTable.id })
      .from(settingsTable)
      .where(eq(settingsTable.id, 1))
      .for('update');
    const previous = await this.read(database);
    const { revision, ...settings } = value;
    const rows = await database
      .update(settingsTable)
      .set({
        revision: sql`${settingsTable.revision} + 1`,
        value: sql`${settingsTable.value} || ${JSON.stringify(settings)}::jsonb`,
      })
      .where(and(eq(settingsTable.id, 1), eq(settingsTable.revision, revision)))
      .returning({ revision: settingsTable.revision, value: settingsTable.value });
    if (rows[0] && this.profiles && settings.homeAssistantUsers) {
      for (const [user, chat] of Object.entries(settings.homeAssistantUsers)) {
        if (previous.homeAssistantUsers?.[user] !== chat)
          await this.profiles.mergeHomeAssistantUser(user, chat, database);
      }
      for (const user of Object.keys(previous.homeAssistantUsers || {})) {
        if (!Object.hasOwn(settings.homeAssistantUsers, user))
          await database
            .update(profiles)
            .set({ linked_chat_id: null })
            .where(and(eq(profiles.bot, 'zero'), eq(profiles.chat_id, 'ha:' + user)));
      }
    }
    return rows[0] ? { ...rows[0].value, revision: rows[0].revision } : undefined;
  }
}
