import { and, count, desc, eq, isNotNull, isNull, not, or, sql } from 'drizzle-orm';
import {
  assistantDefinitions as definitions,
  accessProfiles as profiles,
  managedBots as bots,
  zeroSettings as settings,
} from './database-schema.js';
import { databaseErrorCode, type Database } from './database.js';
import type { AssistantDefinitionRepository } from '../../application/assistant-definitions.js';
import type { AssistantDefinition } from '../../domain/assistant-definition.js';
import type { BotId } from '../../domain/access.js';
export class PostgresAssistantDefinitions implements AssistantDefinitionRepository {
  constructor(private db: Database) {}
  async initialize() {
    // Defaults never overwrite saved definitions or their prompts.
    await this.db
      .insert(definitions)
      .values({ id: 'zero', name: 'Zero', prompt: null, preset: 'automatic', builtin: true })
      .onConflictDoNothing();
  }

  private definition(row: any): AssistantDefinition {
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      revision: row.revision,
      memoryPolicy: row.preset,
      builtin: row.builtin,
    };
  }
  private selection() {
    return {
      id: definitions.id,
      name: definitions.name,
      preset: definitions.preset,
      builtin: definitions.builtin,
      revision: sql<number>`case when ${definitions.id}='zero' then ${settings.revision} else ${definitions.revision} end`,
    };
  }
  async list(search: string, offset: number, limit: number) {
    const filter = sql`position(lower(${search}) in lower(${definitions.name})) > 0`;
    const rows = await this.db
      .select(this.selection())
      .from(definitions)
      .leftJoin(settings, and(eq(definitions.id, 'zero'), eq(settings.id, 1)))
      .where(filter)
      .orderBy(desc(definitions.builtin), sql`lower(${definitions.name})`, definitions.id)
      .limit(limit)
      .offset(offset);
    const [{ total }] = await this.db.select({ total: count() }).from(definitions).where(filter);
    return { items: rows.map(({ preset, ...row }) => ({ ...row, memoryPolicy: preset })), total };
  }
  async get(id: string) {
    const [row] = await this.db
      .select({
        ...this.selection(),
        prompt: sql<string>`case when ${definitions.id}='zero' then ${settings.value}->>'prompt' else ${definitions.prompt} end`,
      })
      .from(definitions)
      .leftJoin(settings, and(eq(definitions.id, 'zero'), eq(settings.id, 1)))
      .where(eq(definitions.id, id));
    return row ? this.definition(row) : undefined;
  }
  async create(value: AssistantDefinition) {
    await this.db.insert(definitions).values({
      id: value.id,
      name: value.name,
      prompt: value.prompt,
      revision: 1,
      preset: 'automatic',
      builtin: false,
    });
  }
  async update(id: string, input: { name: string; prompt: string; revision: number }) {
    if (id === 'zero') {
      if (input.name !== 'Zero') return undefined;
      const [row] = await this.db
        .update(settings)
        .set({
          revision: sql`${settings.revision} + 1`,
          value: sql`jsonb_set(${settings.value}, '{prompt}', to_jsonb(${input.prompt}::text))`,
        })
        .where(and(eq(settings.id, 1), eq(settings.revision, input.revision)))
        .returning({ revision: settings.revision });
      return row
        ? {
            id,
            name: 'Zero',
            prompt: input.prompt,
            revision: row.revision,
            memoryPolicy: 'automatic' as const,
            builtin: true,
          }
        : undefined;
    }
    const [row] = await this.db
      .update(definitions)
      .set({ name: input.name, prompt: input.prompt, revision: sql`${definitions.revision} + 1` })
      .where(and(eq(definitions.id, id), eq(definitions.revision, input.revision)))
      .returning();
    return row ? this.definition(row) : undefined;
  }
  async remove(id: string, revision: number): Promise<'deleted' | 'conflict'> {
    try {
      return await this.db.transaction(async (client): Promise<'deleted' | 'conflict'> => {
        const selected = await client
          .select({ id: definitions.id })
          .from(definitions)
          .where(
            and(
              eq(definitions.id, id),
              eq(definitions.revision, revision),
              not(definitions.builtin),
            ),
          )
          .for('update');
        const connected = await client
          .select({ id: bots.id })
          .from(bots)
          .where(and(eq(bots.id, id), isNotNull(bots.account_id)));
        if (!selected.length || connected.length) return 'conflict';
        await client.update(profiles).set({ assistant_id: 'zero' }).where(this.assigned(id));
        await client.delete(definitions).where(eq(definitions.id, id));
        return 'deleted';
      });
    } catch (error) {
      if (databaseErrorCode(error) === '23503') return 'conflict';
      throw error;
    }
  }
  private assigned(id: string) {
    return or(
      eq(profiles.assistant_id, id),
      and(isNull(profiles.assistant_id), eq(profiles.bot, id)),
    );
  }
  async usage(id: string, offset: number, limit: number) {
    const rows = await this.db
      .select({ bot: profiles.bot, chatId: profiles.chat_id, label: profiles.label })
      .from(profiles)
      .where(this.assigned(id))
      .orderBy(profiles.label, profiles.bot, profiles.chat_id)
      .limit(limit)
      .offset(offset);
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(profiles)
      .where(this.assigned(id));
    return { items: rows, total };
  }
  async assign(bot: BotId, chatId: string, id: string) {
    try {
      const rows = await this.db
        .update(profiles)
        .set({ assistant_id: id })
        .where(and(eq(profiles.bot, bot), eq(profiles.chat_id, chatId)))
        .returning({ chat_id: profiles.chat_id });
      return rows.length > 0;
    } catch (error) {
      if (databaseErrorCode(error) === '23503') return false;
      throw error;
    }
  }
}
