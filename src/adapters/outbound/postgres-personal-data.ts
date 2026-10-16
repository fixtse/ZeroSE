import type pg from 'pg';
import type { PersonalDataPort } from '../../application/personal-data.js';
export class PostgresPersonalData implements PersonalDataPort {
  constructor(private pool: pg.Pool) {}
  async memories(
    profile: string,
    search: string,
    category: string | undefined,
    offset: number,
    limit: number,
  ) {
    const filter =
      "session=$1 AND forgotten_at IS NULL AND superseded_by IS NULL AND ($2='' OR strpos(lower(text),lower($2))>0 OR strpos(lower(tags::text),lower($2))>0) AND ($3::text IS NULL OR category=$3)";
    const args = [profile, search, category || null];
    const { rows } = await this.pool.query(
      `SELECT id::text, left(COALESCE(summary,text),480) AS summary, category,tags,created FROM memories WHERE ${filter} ORDER BY created DESC,id DESC OFFSET $4 LIMIT $5`,
      [...args, offset, limit],
    );
    const total = Number(
      (await this.pool.query(`SELECT count(*) FROM memories WHERE ${filter}`, args)).rows[0].count,
    );
    return {
      items: rows,
      total,
      next_offset: offset + rows.length < total ? offset + rows.length : null,
    };
  }
  async forget(profile: string, ids: string[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE memories SET text='',summary=NULL,tags='[]',category='',embedding=NULL,forgotten_at=now()
        WHERE session=$1 AND id=ANY($2::bigint[]) AND forgotten_at IS NULL RETURNING id`,
        [profile, [...new Set(ids)]],
      );
      if (result.rowCount !== new Set(ids).size)
        throw new Error('Every memory must exist in this profile; no memories were deleted');
      await client.query('COMMIT');
      return result.rowCount || 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async conversations(
    session: string,
    query: string,
    start: string | undefined,
    end: string | undefined,
    offset: number,
    limit: number,
  ) {
    const filter =
      "session=$1 AND ($2='' OR to_tsvector('simple',text) @@ websearch_to_tsquery('simple',$2)) AND ($3::timestamptz IS NULL OR created >= $3) AND ($4::timestamptz IS NULL OR created <= $4)";
    const args = [session, query, start || null, end || null];
    const { rows } = await this.pool.query(
      `SELECT id::text,role,left(text,480) AS excerpt,created, length(text)>480 AS is_excerpt FROM messages WHERE ${filter} ORDER BY created DESC,id DESC OFFSET $5 LIMIT $6`,
      [...args, offset, limit],
    );
    const total = Number(
      (await this.pool.query(`SELECT count(*) FROM messages WHERE ${filter}`, args)).rows[0].count,
    );
    return {
      items: rows,
      total,
      next_offset: offset + rows.length < total ? offset + rows.length : null,
    };
  }
  async message(session: string, id: string) {
    const { rows } = await this.pool.query(
      'SELECT id::text,role,text,created FROM messages WHERE session=$1 AND id=$2',
      [session, id],
    );
    if (!rows[0]) throw new Error('Message not found in this chat');
    return rows[0];
  }
}
