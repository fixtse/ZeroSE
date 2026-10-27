import { and, count, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from './database.js';
import { memories, messages } from './database-schema.js';
import type { PersonalDataPort } from '../../application/personal-data.js';

export class PostgresPersonalData implements PersonalDataPort {
  constructor(private db: Database) {}
  async memories(
    profile: string,
    search: string,
    category: string | undefined,
    offset: number,
    limit: number,
  ) {
    const filter = and(
      eq(memories.session, profile),
      isNull(memories.forgotten_at),
      isNull(memories.superseded_by),
      search
        ? or(
            sql`strpos(lower(${memories.text}), lower(${search})) > 0`,
            sql`strpos(lower(${memories.tags}::text), lower(${search})) > 0`,
          )
        : undefined,
      category ? eq(memories.category, category) : undefined,
    );
    const items = await this.db
      .select({
        id: sql<string>`${memories.id}::text`,
        summary: sql<string>`left(coalesce(${memories.summary}, ${memories.text}), 480)`,
        category: memories.category,
        tags: memories.tags,
        created: memories.created,
      })
      .from(memories)
      .where(filter)
      .orderBy(desc(memories.created), desc(memories.id))
      .offset(offset)
      .limit(limit);
    const [{ total }] = await this.db.select({ total: count() }).from(memories).where(filter);
    return {
      items,
      total,
      next_offset: offset + items.length < total ? offset + items.length : null,
    };
  }
  async forget(profile: string, ids: string[]) {
    return this.db.transaction(async (client) => {
      const unique = [...new Set(ids)].map(BigInt);
      const rows = await client
        .update(memories)
        .set({
          text: '',
          summary: null,
          tags: [],
          category: '',
          embedding: null,
          forgotten_at: sql`now()`,
        })
        .where(
          and(
            eq(memories.session, profile),
            inArray(memories.id, unique),
            isNull(memories.forgotten_at),
          ),
        )
        .returning({ id: memories.id });
      if (rows.length !== unique.length)
        throw new Error('Every memory must exist in this profile; no memories were deleted');
      return rows.length;
    });
  }
  async conversations(
    session: string,
    query: string,
    start: string | undefined,
    end: string | undefined,
    offset: number,
    limit: number,
  ) {
    const filter = and(
      eq(messages.session, session),
      query
        ? sql`to_tsvector('simple', ${messages.text}) @@ websearch_to_tsquery('simple', ${query})`
        : undefined,
      start ? gte(messages.created, new Date(start)) : undefined,
      end ? lte(messages.created, new Date(end)) : undefined,
    );
    const items = await this.db
      .select({
        id: sql<string>`${messages.id}::text`,
        role: messages.role,
        excerpt: sql<string>`left(${messages.text}, 480)`,
        created: messages.created,
        is_excerpt: sql<boolean>`length(${messages.text}) > 480`,
      })
      .from(messages)
      .where(filter)
      .orderBy(desc(messages.created), desc(messages.id))
      .offset(offset)
      .limit(limit);
    const [{ total }] = await this.db.select({ total: count() }).from(messages).where(filter);
    return {
      items,
      total,
      next_offset: offset + items.length < total ? offset + items.length : null,
    };
  }
  async message(session: string, id: string) {
    const [row] = await this.db
      .select({
        id: sql<string>`${messages.id}::text`,
        role: messages.role,
        text: messages.text,
        created: messages.created,
      })
      .from(messages)
      .where(and(eq(messages.session, session), eq(messages.id, BigInt(id))));
    if (!row) throw new Error('Message not found in this chat');
    return row;
  }
}
