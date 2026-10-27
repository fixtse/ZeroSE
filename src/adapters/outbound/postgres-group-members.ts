import { and, eq, sql, count } from 'drizzle-orm';
import { groupMembers as members } from './database-schema.js';
import type { Database } from './database.js';
import type { GroupMember } from '../../domain/group-member.js';
import type { GroupMembersRepository } from '../../application/group-members.js';

const decode = (row: typeof members.$inferSelect): GroupMember => ({
  userId: row.user_id,
  name: row.name,
  username: row.username,
  present: row.present,
  observed: row.observed,
  locationEntity: row.location_entity,
  geocodedLocationEntity: row.geocoded_location_entity,
});
export class PostgresGroupMembers implements GroupMembersRepository {
  constructor(private db: Database) {}
  private scope(bot: string, chatId: string, userId?: string) {
    return and(
      eq(members.bot, bot),
      eq(members.chat_id, chatId),
      userId ? eq(members.user_id, userId) : undefined,
    );
  }
  async list(bot: string, chatId: string, search: string, offset: number, limit: number) {
    const filter = and(
      this.scope(bot, chatId),
      sql`position(lower(${search}) in lower(${members.name} || ' ' || ${members.username} || ' ' || ${members.user_id})) > 0`,
    );
    const rows = await this.db
      .select()
      .from(members)
      .where(filter)
      .orderBy(members.name, members.user_id)
      .offset(offset)
      .limit(limit);
    const [total] = await this.db.select({ value: count() }).from(members).where(filter);
    return { items: rows.map(decode), total: total.value };
  }
  async get(bot: string, chatId: string, userId: string) {
    const [row] = await this.db
      .select()
      .from(members)
      .where(this.scope(bot, chatId, userId));
    return row ? decode(row) : undefined;
  }
  async save(bot: string, chatId: string, value: GroupMember, createOnly = false) {
    const fields = {
      name: value.name,
      location_entity: value.locationEntity,
      geocoded_location_entity: value.geocodedLocationEntity,
    };
    const query = this.db
      .insert(members)
      .values({ bot, chat_id: chatId, user_id: value.userId, ...fields });
    const rows = await (
      createOnly
        ? query.onConflictDoNothing()
        : query.onConflictDoUpdate({
            target: [members.bot, members.chat_id, members.user_id],
            set: fields,
          })
    ).returning({ id: members.user_id });
    return rows.length === 1;
  }
  async observe(
    bot: string,
    chatId: string,
    value: Pick<GroupMember, 'userId' | 'name' | 'username' | 'present'>,
  ) {
    const fields = {
      name: value.name,
      username: value.username,
      present: value.present,
      observed: true,
    };
    await this.db
      .insert(members)
      .values({ bot, chat_id: chatId, user_id: value.userId, ...fields })
      .onConflictDoUpdate({ target: [members.bot, members.chat_id, members.user_id], set: fields });
  }
  async remove(bot: string, chatId: string, userId: string) {
    await this.db.delete(members).where(this.scope(bot, chatId, userId));
  }
  async migrate(bot: string, from: string, to: string) {
    const rows = await this.db.select().from(members).where(this.scope(bot, from));
    for (const row of rows)
      await this.db
        .insert(members)
        .values({ ...row, chat_id: to })
        .onConflictDoNothing();
  }
}
