import type { WeatherDeliveryState } from '../../domain/weather-notifications.js';
import { accumulateWeather, reportedWeather } from '../../domain/weather-baseline.js';
import type { WeatherChange } from '../../domain/weather-change.js';
import { and, count, desc, eq, getTableColumns, inArray, isNull, ne, sql } from 'drizzle-orm';
import { notificationRules as rules, ruleEvents, jobs } from './database-schema.js';
import { type Database } from './database.js';
import { randomUUID } from 'node:crypto';
import type { RuleRepository, RuleEvent } from '../../application/notification-rules.js';
import type { NotificationRule } from '../../domain/notification-rule.js';
import { sessionAddress } from '../../domain/access.js';
import type { LocalDeadlineRepository } from '../../application/local-rule-scheduler.js';
import type { RuleRetentionPort } from '../../application/rule-retention.js';

const terminalStatuses = ['completed', 'expired', 'cancelled'];

export class PostgresRules implements RuleRepository, LocalDeadlineRepository, RuleRetentionPort {
  constructor(
    private db: Database,
    private now = () => new Date(),
  ) {}
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
    const rule = {
      ...value,
      retired_at: terminalStatuses.includes(value.status) ? this.now().toISOString() : null,
      id: randomUUID(),
      version: 0,
      generation: 0,
    };
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
    options?: { includeAlerts?: boolean; excludeCancelled?: boolean; excludeManaged?: boolean },
  ) {
    const filter = and(
      eq(rules.session, session),
      kind
        ? eq(sql`${rules.value}->>'kind'`, kind)
        : options?.includeAlerts
          ? undefined
          : ne(sql`${rules.value}->>'kind'`, 'alert'),
    );
    const visibleFilter = and(
      filter,
      options?.excludeManaged
        ? sql`(${rules.value}->>'managed') IS DISTINCT FROM 'owner_weather'`
        : undefined,
      options?.excludeCancelled ? ne(sql`${rules.value}->>'status'`, 'cancelled') : undefined,
    );
    const rows = await this.db
      .select({ ...getTableColumns(rules), total: sql<number>`count(*) over()`.mapWith(Number) })
      .from(rules)
      .where(visibleFilter)
      .orderBy(desc(rules.created), desc(rules.id))
      .offset(offset)
      .limit(limit);
    const total =
      rows[0]?.total ??
      (await this.db.select({ total: count() }).from(rules).where(visibleFilter))[0].total;
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
  async dueLocal(now: Date, limit: number) {
    const rows = await this.db
      .select()
      .from(rules)
      .where(
        sql`
      ${rules.value}->>'scheduler_key' = 'zero-local-v1'
      AND ${rules.value}->>'status' = 'active'
      AND ${rules.value}->>'scheduler_state' = 'installed'
      AND ${rules.value}->>'kind' IN ('reminder', 'timer')
      AND ${rules.value}->>'wake_date' IS NULL
      AND ${rules.value}->'condition' = 'null'::jsonb
      AND ${rules.value}->>'next_at' <= ${now.toISOString()}
    `,
      )
      .orderBy(sql`${rules.value}->>'next_at'`, rules.id)
      .limit(Math.min(100, Math.max(1, limit)));
    return rows.map((row) => this.decode(row));
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
          value: sql`jsonb_set(
            jsonb_set(${rules.value}, '{status}', '"completed"'::jsonb),
            '{retired_at}', ${JSON.stringify(this.now().toISOString())}::jsonb
          )`,
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
    const retiredAt = terminalStatuses.includes(rule.status)
      ? sql`COALESCE(NULLIF(${rules.value}->'retired_at', 'null'::jsonb), ${JSON.stringify(this.now().toISOString())}::jsonb)`
      : sql`'null'::jsonb`;
    const rows = await this.db
      .update(rules)
      .set({
        value: sql`jsonb_set(${JSON.stringify(rule)}::jsonb, '{retired_at}', ${retiredAt})`,
        version: sql`${rules.version} + 1`,
      })
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
      rule.retired_at = terminalStatuses.includes(rule.status) ? this.now().toISOString() : null;
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
            ...(rule.assistant_request ? { assistantRequest: rule.assistant_request } : {}),
            ...(event.weather ? { weather: event.weather, firedAt: event.fired_at } : {}),
            ...(chat ? { chatId: chat.chatId } : {}),
          },
        })
        .onConflictDoNothing({ target: jobs.dedupe });
      return true;
    });
  }
  async weatherEvidence(
    id: string,
    generation: number,
    change: WeatherChange,
    delivered = false,
    deliveryState?: WeatherDeliveryState,
  ) {
    return this.db.transaction(async (client) => {
      const [row] = await client.select().from(rules).where(eq(rules.id, id)).for('update');
      if (!row || row.value.generation !== generation) return undefined;
      const rule = this.decode(row);
      const kind = change.forecast_type || 'daily';
      const pending = rule.weather_pending?.[kind];
      const next = delivered
        ? pending && reportedWeather(pending, change)
        : accumulateWeather(pending, change, this.now().getTime());
      if (!next) return undefined;
      rule.weather_pending = { ...rule.weather_pending, [kind]: next };
      if (delivered && deliveryState) rule.weather_delivery = deliveryState;
      await client
        .update(rules)
        .set({ value: rule, version: sql`${rules.version} + 1` })
        .where(eq(rules.id, id));
      return next;
    });
  }
  async pruneFinished(now: Date, limit: number) {
    const cutoff = new Date(now.getTime() - 48 * 3_600_000).toISOString();
    return this.db.transaction(async (client) => {
      const rows = await client
        .select()
        .from(rules)
        .where(
          and(
            inArray(sql`${rules.value}->>'status'`, terminalStatuses),
            sql`(${rules.value}->>'managed') IS DISTINCT FROM 'owner_weather'`,
            sql`(${rules.value}->>'retired_at' IS NULL OR ${rules.value}->>'retired_at' <= ${cutoff})`,
            sql`NOT EXISTS (
            SELECT 1 FROM ${jobs}
            WHERE ${jobs.payload}->>'kind' = 'rule_notification'
              AND ${jobs.payload}->>'ruleId' = ${rules.id}
              AND ${jobs.status} IN ('pending', 'running')
          )`,
          ),
        )
        .orderBy(rules.created, rules.id)
        .limit(Math.min(100, Math.max(1, limit)))
        .for('update', { skipLocked: true });
      const expired = rows.filter((row) => row.value.retired_at).map((row) => row.id);
      const legacy = rows.filter((row) => !row.value.retired_at).map((row) => row.id);
      if (legacy.length)
        await client
          .update(rules)
          .set({
            value: sql`jsonb_set(${rules.value}, '{retired_at}', ${JSON.stringify(now.toISOString())}::jsonb)`,
            version: sql`${rules.version} + 1`,
          })
          .where(inArray(rules.id, legacy));
      if (expired.length) {
        await client.delete(ruleEvents).where(inArray(ruleEvents.rule_id, expired));
        await client.delete(rules).where(inArray(rules.id, expired));
      }
      return rows.length;
    });
  }
}
