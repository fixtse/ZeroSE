import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { RuleRepository, RuleEvent } from '../../application/notification-rules.js';
import type { NotificationRule } from '../../domain/notification-rule.js';
import { sessionAddress } from '../../domain/access.js';

export class PostgresRules implements RuleRepository {
  constructor(private pool: pg.Pool) {}
  async initialize(recoverInterrupted = true) {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS notification_rules (
      id TEXT PRIMARY KEY, session TEXT NOT NULL, value JSONB NOT NULL,
      version INTEGER NOT NULL DEFAULT 0, created TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS notification_rules_session ON notification_rules(session,created,id);
      CREATE TABLE IF NOT EXISTS notification_rule_events(id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES notification_rules(id), created TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX IF NOT EXISTS notification_rules_owner_weather ON notification_rules(session) WHERE value->>'managed'='owner_weather';`);
    if (recoverInterrupted)
      await this.pool.query(
        `UPDATE notification_rules SET value=jsonb_set(value,'{scheduler_state}','"uncertain"'::jsonb) WHERE value->>'scheduler_state'='installing'`,
      );
  }
  private decode(row: any): NotificationRule {
    return { ...row.value, id: row.id, session: row.session, version: row.version };
  }
  async create(value: Omit<NotificationRule, 'id' | 'version' | 'generation'>) {
    const id = randomUUID();
    const rule = { ...value, id, version: 0, generation: 0 };
    await this.pool.query('INSERT INTO notification_rules(id,session,value) VALUES($1,$2,$3)', [
      id,
      value.session,
      JSON.stringify(rule),
    ]);
    return rule;
  }
  async ownerWeather(value: Omit<NotificationRule, 'id' | 'version' | 'generation'>) {
    const id = randomUUID(),
      rule = { ...value, managed: 'owner_weather', id, version: 0, generation: 0 };
    const inserted = await this.pool.query(
      'INSERT INTO notification_rules(id,session,value) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *',
      [id, value.session, JSON.stringify(rule)],
    );
    const row =
      inserted.rows[0] ||
      (
        await this.pool.query(
          "SELECT * FROM notification_rules WHERE session=$1 AND value->>'managed'='owner_weather'",
          [value.session],
        )
      ).rows[0];
    return { rule: this.decode(row), created: !!inserted.rowCount };
  }
  async read(session: string, id: string) {
    const { rows } = await this.pool.query(
      'SELECT * FROM notification_rules WHERE session=$1 AND id=$2',
      [session, id],
    );
    return rows[0] ? this.decode(rows[0]) : undefined;
  }
  async list(
    session: string,
    kind: NotificationRule['kind'] | undefined,
    offset: number,
    limit: number,
  ) {
    const { rows } = await this.pool.query(
      `SELECT *, count(*) OVER() AS total FROM notification_rules
      WHERE session=$1 AND (($2::text IS NULL AND value->>'kind'<>'alert') OR value->>'kind'=$2) ORDER BY created DESC,id DESC OFFSET $3 LIMIT $4`,
      [session, kind || null, offset, limit],
    );
    const total = rows[0]
      ? Number(rows[0].total)
      : Number(
          (
            await this.pool.query(
              "SELECT count(*) FROM notification_rules WHERE session=$1 AND (($2::text IS NULL AND value->>'kind'<>'alert') OR value->>'kind'=$2)",
              [session, kind || null],
            )
          ).rows[0].count,
        );
    return {
      items: rows.map((row) => this.decode(row)),
      total,
      next_offset: offset + rows.length < total ? offset + rows.length : null,
    };
  }
  async byId(id: string) {
    const { rows } = await this.pool.query('SELECT * FROM notification_rules WHERE id=$1', [id]);
    return rows[0] ? this.decode(rows[0]) : undefined;
  }
  async legacy() {
    const { rows } = await this.pool.query(
      "SELECT * FROM notification_rules WHERE value->>'scheduler_state' IS NULL AND value->>'status' IN ('active','paused') ORDER BY created,id",
    );
    return rows.map((row) => this.decode(row));
  }
  async apply(rule: NotificationRule) {
    return !!(
      await this.pool.query(
        'UPDATE notification_rules SET value=$4,version=version+1 WHERE session=$1 AND id=$2 AND version=$3 RETURNING id',
        [rule.session, rule.id, rule.version, JSON.stringify(rule)],
      )
    ).rowCount;
  }
  async installation(id: string, generation: number, state: 'installed' | 'uncertain') {
    await this.pool.query(
      "UPDATE notification_rules SET value=jsonb_set(value,'{scheduler_state}',$3::jsonb),version=version+1 WHERE id=$1 AND (value->>'generation')::integer=$2 AND ($4::boolean OR value->>'scheduler_state' IS DISTINCT FROM 'installed')",
      [id, generation, JSON.stringify(state), state === 'installed'],
    );
  }
  async accept(event: RuleEvent) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT * FROM notification_rules WHERE id=$1 FOR UPDATE',
        [event.id],
      );
      const rule = rows[0] ? this.decode(rows[0]) : undefined;
      if (
        !rule ||
        rule.generation !== event.generation ||
        rule.status !== 'active' ||
        (rule.last_fired && Date.parse(event.fired_at) <= Date.parse(rule.last_fired))
      ) {
        await client.query('ROLLBACK');
        return false;
      }
      const fired = Date.parse(event.fired_at);
      if (rule.kind === 'alert') {
        if (rule.last_fired && fired - Date.parse(rule.last_fired) < rule.cooldown_seconds * 1000) {
          await client.query('ROLLBACK');
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
          await client.query('ROLLBACK');
          return false;
        }
        if (interval) rule.next_at = new Date(due + interval).toISOString();
        else rule.status = 'completed';
      }

      const receipt = await client.query(
        'INSERT INTO notification_rule_events(id,rule_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',
        [event.event_id, event.id],
      );
      if (!receipt.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      rule.last_fired = event.fired_at;
      rule.scheduler_state = 'installed';
      await client.query('UPDATE notification_rules SET value=$2,version=version+1 WHERE id=$1', [
        rule.id,
        JSON.stringify(rule),
      ]);
      const chat = sessionAddress(rule.session);
      await client.query(
        'INSERT INTO jobs(id,session,dedupe,payload) VALUES($1,$2,$3,$4) ON CONFLICT(dedupe) DO NOTHING',
        [
          randomUUID(),
          rule.session,
          'rule-event:' + event.event_id,
          JSON.stringify({
            kind: 'rule_notification',
            ruleId: rule.id,
            generation: rule.generation,
            ...(event.weather ? { weather: event.weather, firedAt: event.fired_at } : {}),
            ...(chat ? { chatId: chat.chatId } : {}),
          }),
        ],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
