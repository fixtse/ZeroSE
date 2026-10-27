import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { createDatabase, execute } from './database.js';

/** Explicit offline, transactional import. No LLM calls, re-embedding or production access. */
export async function migrateMem0(pool: pg.Pool, apply = false) {
  return createDatabase(pool).transaction(async (tx) => {
    const lock = await execute(
      tx,
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':assistant',0)) AS acquired`,
    );
    if (!lock.rows[0].acquired)
      throw new Error('Stop the assistant before migrating long-term memory');
    const state = await execute<{ migrated: boolean; total: string; active: string }>(
      tx,
      sql`SELECT
      EXISTS(SELECT 1 FROM imports WHERE key='mem0:v1') AS migrated,
      (SELECT count(*) FROM memories) AS total,
      (SELECT count(*) FROM memories WHERE forgotten_at IS NULL AND superseded_by IS NULL) AS active`,
    );
    const report = {
      migrated: state.rows[0].migrated,
      total: Number(state.rows[0].total),
      active: Number(state.rows[0].active),
      applied: false,
    };
    if (!apply || report.migrated) return report;
    const existing = await execute(
      tx,
      sql`SELECT EXISTS(SELECT 1 FROM zero_mem0_records) AS occupied`,
    );
    if (existing.rows[0].occupied)
      throw new Error(
        'Mem0 already contains records without an import marker; inspect before migration',
      );
    // Preserve legacy numeric IDs, including tombstones, and all supersession edges.
    await execute(
      tx,
      sql`INSERT INTO zero_mem0_records(id, session, mem0_id, source, status, created)
      SELECT id, session, CASE WHEN forgotten_at IS NULL THEN md5('zero:mem0:v1:' || id::text)::uuid ELSE NULL END,
        source, CASE WHEN forgotten_at IS NULL THEN 'ready' ELSE 'forgotten' END, created FROM memories`,
    );
    await execute(
      tx,
      sql`INSERT INTO zero_mem0_vectors(id, vector, payload)
      SELECT r.mem0_id, m.embedding, jsonb_build_object(
        'user_id', m.session, 'zero_id', m.id::text, 'data', m.text,
        'summary', m.summary, 'category', m.category, 'tags', m.tags,
        'hash', md5(m.text), 'textLemmatized', lower(m.text),
        'createdAt', to_char(m.created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'saved_ms', floor(extract(epoch FROM m.created)*1000),
        'embedding_space', coalesce(m.embedding_space,''), 'active', m.superseded_by IS NULL)
      FROM memories m JOIN zero_mem0_records r ON r.id=m.id WHERE m.forgotten_at IS NULL`,
    );
    await execute(
      tx,
      sql`UPDATE zero_mem0_records r SET superseded_by=m.superseded_by FROM memories m WHERE m.id=r.id`,
    );
    const verified = await execute(
      tx,
      sql`SELECT
      (SELECT count(*) FROM zero_mem0_records)=(SELECT count(*) FROM memories)
      AND NOT EXISTS(SELECT 1 FROM memories m JOIN zero_mem0_records r ON r.id=m.id LEFT JOIN zero_mem0_vectors v ON v.id=r.mem0_id
        WHERE r.session<>m.session OR r.created<>m.created OR r.superseded_by IS DISTINCT FROM m.superseded_by
        OR (m.forgotten_at IS NULL AND (v.id IS NULL OR v.payload->>'data' IS DISTINCT FROM m.text
          OR v.payload->>'summary' IS DISTINCT FROM m.summary OR v.payload->>'category' IS DISTINCT FROM m.category
          OR v.payload->'tags' IS DISTINCT FROM m.tags OR v.vector IS DISTINCT FROM m.embedding))
        OR (m.forgotten_at IS NOT NULL AND (r.status<>'forgotten' OR v.id IS NOT NULL))) AS valid`,
    );
    if (!verified.rows[0].valid)
      throw new Error('Mem0 import verification failed; no records were migrated');
    await execute(
      tx,
      sql`SELECT setval(pg_get_serial_sequence('zero_mem0_records','id'), coalesce(max(id),1), count(*)>0) FROM zero_mem0_records`,
    );
    await execute(tx, sql`INSERT INTO imports(key) VALUES('mem0:v1')`);
    return { ...report, migrated: true, applied: true };
  });
}
