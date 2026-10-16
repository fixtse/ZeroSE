import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { RuleRepository } from '../../application/notification-rules.js';
import type { NotificationRule } from '../../domain/notification-rule.js';
import { sessionAddress } from '../../domain/access.js';

export class PostgresRules implements RuleRepository {
  constructor(private pool: pg.Pool) {}
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS notification_rules (
      id TEXT PRIMARY KEY, session TEXT NOT NULL, value JSONB NOT NULL,
      version INTEGER NOT NULL DEFAULT 0, created TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS notification_rules_session ON notification_rules(session,created,id);
      CREATE TABLE IF NOT EXISTS notification_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), observed TIMESTAMPTZ NOT NULL);`);
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
  async pending() {
    // Fairly rotate alerts; overdue deadlines get their own bounded batch.
    const { rows } = await this.pool
      .query(`(SELECT * FROM notification_rules WHERE value->>'status'='active' AND value->>'kind'<>'alert'
      AND (value->>'next_at')::timestamptz<=now() ORDER BY value->>'next_at' LIMIT 100)
      UNION ALL (SELECT * FROM notification_rules WHERE value->>'status'='active' AND value->>'kind'='alert'
      AND (value->'condition'->>'source' IS DISTINCT FROM 'weather' OR value->>'last_checked' IS NULL OR (value->>'last_checked')::timestamptz < now() - interval '5 minutes')
      ORDER BY value->>'last_checked' NULLS FIRST, created LIMIT 100)`);
    return rows.map((row) => this.decode(row));
  }
  async apply(rule: NotificationRule, fire = false) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        'UPDATE notification_rules SET value=$4,version=version+1 WHERE session=$1 AND id=$2 AND version=$3 RETURNING id',
        [rule.session, rule.id, rule.version, JSON.stringify(rule)],
      );
      if (updated.rowCount && fire) {
        const chat = sessionAddress(rule.session);
        await client.query(
          `INSERT INTO jobs(id,session,dedupe,payload) VALUES($1,$2,$3,$4) ON CONFLICT(dedupe) DO NOTHING`,
          [
            randomUUID(),
            rule.session,
            `rule:${rule.id}:${rule.generation}:${rule.version}`,
            JSON.stringify({
              kind: 'rule_notification',
              ruleId: rule.id,
              generation: rule.generation,
              ...(chat ? { chatId: chat.chatId } : {}),
            }),
          ],
        );
      }
      await client.query('COMMIT');
      return !!updated.rowCount;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async heartbeat(now: Date) {
    await this.pool.query(
      'INSERT INTO notification_heartbeat VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET observed=excluded.observed',
      [now],
    );
  }
  async healthy(now: Date) {
    return !!(
      await this.pool.query(
        "SELECT 1 FROM notification_heartbeat WHERE observed >= $1::timestamptz - interval '30 seconds'",
        [now],
      )
    ).rowCount;
  }
}
