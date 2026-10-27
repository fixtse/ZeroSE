import { and, count, desc, eq, getTableColumns, inArray, isNull, ne, sql } from 'drizzle-orm';
import { notificationRules as rules, ruleEvents, jobs } from './database-schema.js';
import { type Database } from './database.js';
import { randomUUID } from 'node:crypto';
import type { RuleRepository, RuleEvent } from '../../application/notification-rules.js';
import type { NotificationRule } from '../../domain/notification-rule.js';
import { sessionAddress } from '../../domain/access.js';

export class PostgresRules implements RuleRepository {
  constructor(private db: Database) {}
  async initialize(recoverInterrupted = true) {
    if (recoverInterrupted)
      await this.db
        .update(rules)
        .set({ value: sql`jsonb_set(${rules.value}, '{scheduler_state}', '"uncertain"'::jsonb)` })
        .where(eq(sql`${rules.value}->>'scheduler_state'`, 'installing'));
  }
  private decode(row: typeof rules.$inferSelect): NotificationRule {
    return { ...row.value, id: row.id, session: row.session, version: row.version };
  }
  async create(value: Omit<NotificationRule, 'id' | 'version' | 'generation'>) {
    const rule = { ...value, id: randomUUID(), version: 0, generation: 0 };
    await this.db.insert(rules).values({ id: rule.id, session: value.session, value: rule });
    return rule;
  }
  async ownerWeather(value: Omit<NotificationRule, 'id' | 'version' | 'generation'>) {
    const rule: NotificationRule = {
      ...value,
      managed: 'owner_weather',
      id: randomUUID(),
      version: 0,
      generation: 0,
    };
    const inserted = await this.db
      .insert(rules)
      .values({ id: rule.id, session: value.session, value: rule })
      .onConflictDoNothing()
      .returning();
    const row =
      inserted[0] ||
      (
        await this.db
          .select()
          .from(rules)
          .where(
            and(
              eq(rules.session, value.session),
              eq(sql`${rules.value}->>'managed'`, 'owner_weather'),
            ),
          )
      )[0];
    return { rule: this.decode(row), created: inserted.length > 0 };
  }
  async read(session: string, id: string) {
    const [row] = await this.db
      .select()
      .from(rules)
      .where(and(eq(rules.session, session), eq(rules.id, id)));
    return row ? this.decode(row) : undefined;
  }
  async list(
    session: string,
    kind: NotificationRule['kind'] | undefined,
    offset: number,
    limit: number,
  ) {
    const filter = and(
      eq(rules.session, session),
      kind ? eq(sql`${rules.value}->>'kind'`, kind) : ne(sql`${rules.value}->>'kind'`, 'alert'),
    );
    const rows = await this.db
      .select({ ...getTableColumns(rules), total: sql<number>`count(*) over()`.mapWith(Number) })
      .from(rules)
      .where(filter)
      .orderBy(desc(rules.created), desc(rules.id))
      .offset(offset)
      .limit(limit);
    const total =
      rows[0]?.total ??
      (await this.db.select({ total: count() }).from(rules).where(filter))[0].total;
    return {
      items: rows.map((row) => this.decode(row)),
      total,
      next_offset: offset + rows.length < total ? offset + rows.length : null,
    };
  }
  async byId(id: string) {
    const [row] = await this.db.select().from(rules).where(eq(rules.id, id));
    return row ? this.decode(row) : undefined;
  }
  async wakeReminders(session: string, date: string) {
    const rows = await this.db
      .select()
      .from(rules)
      .where(
        and(
          eq(rules.session, session),
          eq(sql`${rules.value}->>'status'`, 'active'),
          eq(sql`${rules.value}->>'wake_date'`, date),
        ),
      )
      .orderBy(rules.created, rules.id);
    return rows.map((row) => this.decode(row));
  }
  async completeWakeReminders(session: string, values: NotificationRule[]) {
    for (const rule of values)
      await this.db
        .update(rules)
        .set({
          value: sql`jsonb_set(${rules.value}, '{status}', '"completed"'::jsonb)`,
          version: sql`${rules.version} + 1`,
        })
        .where(
          and(
            eq(rules.session, session),
            eq(rules.id, rule.id),
            eq(rules.version, rule.version),
            eq(sql`${rules.value}->>'status'`, 'active'),
          ),
        );
  }
  async legacy() {
    const rows = await this.db
      .select()
      .from(rules)
      .where(
        and(
          isNull(sql`${rules.value}->>'scheduler_state'`),
          inArray(sql`${rules.value}->>'status'`, ['active', 'paused']),
        ),
      )
      .orderBy(rules.created, rules.id);
    return rows.map((row) => this.decode(row));
  }
  async apply(rule: NotificationRule) {
    const rows = await this.db
      .update(rules)
      .set({ value: rule, version: sql`${rules.version} + 1` })
      .where(
        and(
          eq(rules.session, rule.session),
          eq(rules.id, rule.id),
          eq(rules.version, rule.version),
        ),
      )
      .returning({ id: rules.id });
    return rows.length > 0;
  }
  async installation(id: string, generation: number, state: 'installed' | 'uncertain') {
    await this.db
      .update(rules)
      .set({
        value: sql`jsonb_set(${rules.value}, '{scheduler_state}', ${JSON.stringify(state)}::jsonb)`,
        version: sql`${rules.version} + 1`,
      })
      .where(
        and(
          eq(rules.id, id),
          eq(sql`(${rules.value}->>'generation')::integer`, generation),
          state === 'installed'
            ? undefined
            : sql`${rules.value}->>'scheduler_state' is distinct from 'installed'`,
        ),
      );
  }
  async accept(event: RuleEvent) {
    return this.db.transaction(async (client) => {
      const [row] = await client.select().from(rules).where(eq(rules.id, event.id)).for('update');
      const rule = row ? this.decode(row) : undefined;
      const hourly = event.weather?.forecast_type === 'hourly';
      const lastFired = hourly ? rule?.last_hourly_fired : rule?.last_fired;
      if (
        !rule ||
        rule.wake_date ||
        rule.generation !== event.generation ||
        rule.status !== 'active' ||
        (hourly && (rule.condition?.source !== 'weather' || !rule.condition.hourly_updates)) ||
        (lastFired && Date.parse(event.fired_at) <= Date.parse(lastFired))
      ) {
        return false;
      }
      const fired = Date.parse(event.fired_at);
      if (rule.kind === 'alert') {
        if (lastFired && fired - Date.parse(lastFired) < rule.cooldown_seconds * 1000) {
          return false;
        }
        if (!rule.recurring) rule.status = 'completed';
      } else {
        const anchor = Date.parse(rule.next_at!);
        const interval = (rule.repeat_seconds || 0) * 1000;
        // A previous callback may have been lost. Accept only this occurrence, not catch-up.
        const due =
          interval && fired >= anchor
            ? anchor + Math.floor((fired - anchor) / interval) * interval
            : anchor;
        if (fired < due - 1000 || fired - due > 60000) {
          return false;
        }
        if (interval) rule.next_at = new Date(due + interval).toISOString();
        else rule.status = 'completed';
      }

      const receipt = await client
        .insert(ruleEvents)
        .values({ id: event.event_id, rule_id: event.id })
        .onConflictDoNothing()
        .returning({ id: ruleEvents.id });
      if (!receipt.length) return false;
      if (hourly) rule.last_hourly_fired = event.fired_at;
      else rule.last_fired = event.fired_at;
      rule.scheduler_state = 'installed';
      await client
        .update(rules)
        .set({ value: rule, version: sql`${rules.version} + 1` })
        .where(eq(rules.id, rule.id));
      const chat = sessionAddress(rule.session);
      await client
        .insert(jobs)
        .values({
          id: randomUUID(),
          session: rule.session,
          dedupe: 'rule-event:' + event.event_id,
          payload: {
            kind: 'rule_notification',
            ruleId: rule.id,
            generation: rule.generation,
            ...(event.weather ? { weather: event.weather, firedAt: event.fired_at } : {}),
            ...(chat ? { chatId: chat.chatId } : {}),
          },
        })
        .onConflictDoNothing({ target: jobs.dedupe });
      return true;
    });
  }
}
