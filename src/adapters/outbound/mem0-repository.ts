import { sql } from 'drizzle-orm';
import type pg from 'pg';
import type { MemoryRepository, MemoryEmbeddingRepository } from '../../application/ports.js';
import type { DataPage, PersonalDataPort } from '../../application/personal-data.js';
import type { MemoryFragment, MemoryMatch } from '../../domain/models.js';
import { createDatabase, execute, type SqlExecutor } from './database.js';
import { runMem0 } from './mem0-engine.js';

type RecordRow = {
  id: string;
  session: string;
  mem0_id: string | null;
  status: string;
  superseded_by: string | null;
  created: Date;
  payload: {
    data: string;
    summary?: string;
    category: string;
    tags: string[];
    expires_at?: string | null;
    entities?: string[];
    relations?: import('../../domain/models.js').MemoryRelation[];
  } | null;
};

function ids(values: string[]) {
  const unique = [...new Set(values)];
  if (unique.some((id) => !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n))
    throw new Error('Invalid memory ID');
  return unique;
}

/** Mem0 owns vectors and payloads; Zero owns stable handles and atomic visibility.
 * A pending write is deliberately never retried: the SDK may have committed it.
 */
export class Mem0Repository implements MemoryRepository, MemoryEmbeddingRepository {
  private db;
  private connectionString: string;
  constructor(
    private pool: pg.Pool,
    private dimensions: number,
    private pending: Pick<
      MemoryRepository,
      'pendingMemoryMessages' | 'pendingMemorySessions' | 'markConsolidated'
    >,
  ) {
    this.db = createDatabase(pool);
    const url = new URL(pool.options.connectionString!);
    if (pool.options.options) url.searchParams.set('options', pool.options.options);
    this.connectionString = url.toString();
  }

  async embeddingBatch(after: string, limit: number) {
    const { rows } = await execute<{ id: string; text: string }>(
      this.db,
      sql`SELECT r.id::text, v.payload->>'data' AS text FROM zero_mem0_records r
      JOIN zero_mem0_vectors v ON v.id=r.mem0_id
      WHERE r.status='ready' AND r.superseded_by IS NULL AND r.id>${after}::bigint
      AND (v.payload->>'expires_at' IS NULL OR (v.payload->>'expires_at')::timestamptz > now())
      ORDER BY r.id LIMIT ${limit}`,
    );
    return rows;
  }

  async replaceEmbedding(id: string, text: string, vector: number[], space: string) {
    if (vector.length !== this.dimensions || vector.some((n) => !Number.isFinite(n)))
      throw new Error('Invalid memory embedding dimensions or values');
    await execute(
      this.db,
      sql`UPDATE zero_mem0_vectors v
      SET vector=${JSON.stringify(vector)}::vector,
      payload=jsonb_set(v.payload, '{embedding_space}', to_jsonb(${space}::text))
      FROM zero_mem0_records r WHERE r.mem0_id=v.id AND r.id=${id}::bigint
      AND r.status='ready' AND r.superseded_by IS NULL AND v.payload->>'data'=${text}`,
    );
  }

  private async active(db: SqlExecutor, profile: string, handles: string[]) {
    if (!handles.length) return [];
    const { rows } = await execute<RecordRow>(
      db,
      sql`SELECT r.* FROM zero_mem0_records r
      WHERE r.session=${profile} AND r.id=ANY(${sql.param(handles)}::bigint[])
      AND r.status='ready' AND r.superseded_by IS NULL ORDER BY r.id FOR UPDATE`,
    );
    if (rows.length !== handles.length)
      throw new Error('Every memory must be an active record in this profile');
    return rows;
  }

  async insertMemory(
    profile: string,
    value: MemoryFragment,
    embedding: number[] | null,
    source?: string,
    space = '',
  ) {
    if (
      embedding &&
      (embedding.length !== this.dimensions || embedding.some((n) => !Number.isFinite(n)))
    )
      throw new Error('Invalid memory embedding dimensions or values');
    if (value.expiresAt && !Number.isFinite(Date.parse(value.expiresAt)))
      throw new Error('Invalid memory expiration');
    const supersedes = ids(value.supersedes || []);
    const record = await this.db.transaction(async (tx) => {
      // Serialize reservations in this profile without blocking unrelated profiles.
      await execute(
        tx,
        sql`SELECT pg_advisory_xact_lock(hashtextextended('mem0:' || ${profile}, 0))`,
      );
      if (source) {
        const { rows } = await execute<RecordRow>(
          tx,
          sql`SELECT * FROM zero_mem0_records WHERE session=${profile} AND source=${source}`,
        );
        if (rows[0]) {
          if (rows[0].status === 'pending')
            throw new Error('Uncertain Mem0 write; inspect the pending record before retrying');
          return undefined;
        }
      }
      await this.active(tx, profile, supersedes);
      const { rows } = await execute<RecordRow>(
        tx,
        sql`INSERT INTO zero_mem0_records(session, source)
        VALUES(${profile}, ${source || null}) RETURNING *`,
      );
      return rows[0];
    });
    if (!record) return;
    const results = await runMem0(
      this.connectionString,
      this.dimensions,
      embedding || Array(this.dimensions).fill(0),
      {
        kind: 'add',
        ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
        text: value.text,
        profile,
        metadata: {
          zero_id: String(record.id),
          active: false,
          category: value.category,
          tags: value.tags,
          summary: value.summary || null,
          expires_at: value.expiresAt ? new Date(value.expiresAt).toISOString() : null,
          entities: [
            ...new Set([
              ...(value.entities || []),
              ...(value.relations || []).flatMap((r) => [r.subject, r.object]),
            ]),
          ],
          relations: value.relations || [],
          embedding_space: embedding ? space : '',
          saved_ms: record.created.getTime(),
        },
      },
    );
    if (results.length !== 1)
      throw new Error('Unexpected Mem0 write result; inspect pending records');
    await this.db.transaction(async (tx) => {
      await this.active(tx, profile, supersedes);
      const updated = await execute(
        tx,
        sql`UPDATE zero_mem0_vectors SET payload=payload || '{"active":true}'::jsonb
        WHERE id=${results[0].id}::uuid AND payload->>'user_id'=${profile} AND payload->>'zero_id'=${String(record.id)} RETURNING id`,
      );
      if (updated.rows.length !== 1) throw new Error('Mem0 write could not be verified');
      await execute(
        tx,
        sql`UPDATE zero_mem0_records SET mem0_id=${results[0].id}::uuid, status='ready' WHERE id=${String(record.id)}::bigint AND status='pending'`,
      );
      if (supersedes.length) {
        await execute(
          tx,
          sql`UPDATE zero_mem0_vectors v SET payload=payload || '{"active":false}'::jsonb
          FROM zero_mem0_records r WHERE r.mem0_id=v.id AND r.session=${profile} AND r.id=ANY(${sql.param(supersedes)}::bigint[])`,
        );
        await execute(
          tx,
          sql`UPDATE zero_mem0_records SET superseded_by=${String(record.id)}::bigint
          WHERE session=${profile} AND id=ANY(${sql.param(supersedes)}::bigint[])`,
        );
      }
    });
  }

  private match(row: RecordRow, score = 0): MemoryMatch {
    return {
      id: String(row.id),
      text: row.payload!.data,
      summary: row.payload!.summary || null,
      superseded_by: row.superseded_by == null ? null : String(row.superseded_by),
      metadata: {
        category: row.payload!.category,
        tags: row.payload!.tags,
        created_at: row.created.toISOString(),
        ...(row.payload!.expires_at ? { expires_at: row.payload!.expires_at } : {}),
        ...(row.payload!.entities?.length ? { entities: row.payload!.entities } : {}),
        ...(row.payload!.relations?.length ? { relations: row.payload!.relations } : {}),
      },
      similarity: score,
    };
  }

  async searchMemory(
    profile: string,
    query: string,
    vector: number[] | undefined,
    categories: string[],
    start?: string,
    end?: string,
    space = '',
  ) {
    const filter = sql`r.session=${profile} AND r.status='ready' AND r.superseded_by IS NULL
      AND (v.payload->>'expires_at' IS NULL OR (v.payload->>'expires_at')::timestamptz > now())
      AND (cardinality(${sql.param(categories)}::text[])=0 OR v.payload->>'category'=ANY(${sql.param(categories)}::text[]))
      AND (${start || null}::timestamptz IS NULL OR r.created>=${start || null}::timestamptz)
      AND (${end || null}::timestamptz IS NULL OR r.created<=${end || null}::timestamptz)`;
    // Preserve keyword-only mode and the ability to find unembedded imported records.
    const lexical = await execute<RecordRow>(
      this.db,
      sql`SELECT r.*, v.payload FROM zero_mem0_records r
      JOIN zero_mem0_vectors v ON v.id=r.mem0_id WHERE ${filter}
      AND to_tsvector('simple', (v.payload->>'data') || ' ' || (v.payload->'tags')::text) @@ websearch_to_tsquery('simple', ${query})
      ORDER BY ts_rank_cd(to_tsvector('simple', (v.payload->>'data') || ' ' || (v.payload->'tags')::text), websearch_to_tsquery('simple', ${query})) DESC, r.id DESC LIMIT 50`,
    );
    const entities = await execute<RecordRow>(
      this.db,
      sql`SELECT r.*,v.payload FROM zero_mem0_records r
      JOIN zero_mem0_vectors v ON v.id=r.mem0_id WHERE ${filter}
      AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(v.payload->'entities','[]'::jsonb)) e(name)
        WHERE length(e.name)>=2 AND strpos(lower(${query}),lower(e.name))>0)
      ORDER BY r.created DESC,r.id DESC LIMIT 30`,
    );
    const linked = [
      ...new Set(
        entities.rows.flatMap((row) =>
          (row.payload!.relations || []).flatMap((relation) => [relation.subject, relation.object]),
        ),
      ),
    ].slice(0, 30);
    const related = linked.length
      ? await execute<RecordRow>(
          this.db,
          sql`SELECT r.*,v.payload FROM zero_mem0_records r
      JOIN zero_mem0_vectors v ON v.id=r.mem0_id WHERE ${filter}
      AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(v.payload->'entities','[]'::jsonb)) e(name)
        WHERE lower(e.name)=ANY(${sql.param(linked.map((name) => name.toLowerCase()))}::text[]))
      ORDER BY r.created DESC,r.id DESC LIMIT 30`,
        )
      : { rows: [] as RecordRow[] };
    const entityRows = [
      ...new Map([...entities.rows, ...related.rows].map((row) => [String(row.id), row])).values(),
    ];
    if (!vector) {
      const ranked = new Map<string, { row: RecordRow; rank: number }>();
      for (const rows of [lexical.rows, entityRows])
        rows.forEach((row, index) => {
          const key = String(row.id);
          ranked.set(key, { row, rank: (ranked.get(key)?.rank || 0) + 1 / (60 + index + 1) });
        });
      return [...ranked.values()]
        .sort((a, b) => b.rank - a.rank)
        .slice(0, 100)
        .map(({ row }) => this.match(row));
    }
    if (vector.length !== this.dimensions || vector.some((n) => !Number.isFinite(n)))
      throw new Error('Invalid query embedding');
    const filters: Record<string, unknown> = {
      user_id: profile,
      active: true,
      embedding_space: space,
    };
    if (categories.length) filters.category = categories;
    if (start || end)
      filters.saved_ms = {
        ...(start ? { gte: Date.parse(start) } : {}),
        ...(end ? { lte: Date.parse(end) } : {}),
      };
    const semantic = await runMem0(this.connectionString, this.dimensions, vector, {
      kind: 'search',
      query,
      filters,
    });
    const scores = new Map(
      semantic.map((item, index) => [
        item.id,
        { score: 1 / (60 + index + 1), similarity: item.score || 0 },
      ]),
    );
    const semanticRows = semantic.length
      ? (
          await execute<RecordRow>(
            this.db,
            sql`SELECT r.*, v.payload FROM zero_mem0_records r
      JOIN zero_mem0_vectors v ON v.id=r.mem0_id WHERE ${filter} AND v.id=ANY(${sql.param(semantic.map((item) => item.id))}::uuid[])`,
          )
        ).rows
      : [];
    const candidates = new Map(
      semanticRows.map((row) => [
        String(row.id),
        {
          row,
          rank: scores.get(row.mem0_id!)!.score,
          similarity: scores.get(row.mem0_id!)!.similarity,
        },
      ]),
    );
    [...lexical.rows, ...entityRows].forEach((row, index) => {
      const key = String(row.id),
        previous = candidates.get(key);
      candidates.set(key, {
        row,
        rank: (previous?.rank || 0) + 1 / (60 + index + 1),
        similarity: previous?.similarity || 0,
      });
    });
    return [...candidates.values()]
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 50)
      .map(({ row, similarity }) => this.match(row, similarity));
  }

  async readMemory(profile: string, id: string) {
    ids([id]);
    const { rows } = await execute<RecordRow>(
      this.db,
      sql`SELECT r.*, v.payload FROM zero_mem0_records r
      JOIN zero_mem0_vectors v ON v.id=r.mem0_id WHERE r.session=${profile} AND r.id=${id}::bigint AND r.status='ready'`,
    );
    return rows[0] ? this.match(rows[0]) : undefined;
  }
  async memoryCatalog(profile: string) {
    const { rows } = await execute<{ category: string; tags: string[] }>(
      this.db,
      sql`SELECT DISTINCT v.payload->>'category' AS category, v.payload->'tags' AS tags
      FROM zero_mem0_records r JOIN zero_mem0_vectors v ON v.id=r.mem0_id
      WHERE r.session=${profile} AND r.status='ready' AND r.superseded_by IS NULL
      AND (v.payload->>'expires_at' IS NULL OR (v.payload->>'expires_at')::timestamptz > now())`,
    );
    return {
      categories: [...new Set(rows.map((row) => row.category))],
      tags: [...new Set(rows.flatMap((row) => row.tags))],
    };
  }
  async memories(
    profile: string,
    search: string,
    category: string | undefined,
    offset: number,
    limit: number,
    includeExpired = false,
  ): Promise<DataPage> {
    const filter = sql`r.session=${profile} AND r.status='ready' AND r.superseded_by IS NULL
      AND (${includeExpired} OR v.payload->>'expires_at' IS NULL OR (v.payload->>'expires_at')::timestamptz > now())
      AND (${category || null}::text IS NULL OR v.payload->>'category'=${category || null})
      AND (${search}='' OR strpos(lower(v.payload->>'data'),lower(${search}))>0 OR strpos(lower((v.payload->'tags')::text),lower(${search}))>0)`;
    return this.db.transaction(async (tx) => {
      await execute(tx, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      const { rows } = await execute<RecordRow>(
        tx,
        sql`SELECT r.*, v.payload FROM zero_mem0_records r JOIN zero_mem0_vectors v ON v.id=r.mem0_id WHERE ${filter}
        ORDER BY r.created DESC,r.id DESC OFFSET ${offset} LIMIT ${limit}`,
      );
      const count = await execute<{ total: string }>(
        tx,
        sql`SELECT count(*) AS total FROM zero_mem0_records r JOIN zero_mem0_vectors v ON v.id=r.mem0_id WHERE ${filter}`,
      );
      const total = Number(count.rows[0].total);
      return {
        items: rows.map((row) => ({
          id: String(row.id),
          summary: (row.payload!.summary || row.payload!.data).slice(0, 480),
          category: row.payload!.category,
          tags: row.payload!.tags,
          created: row.created,
          ...(row.payload!.expires_at
            ? {
                expires_at: row.payload!.expires_at,
                expired: Date.parse(row.payload!.expires_at) <= Date.now(),
              }
            : {}),
        })),
        total,
        next_offset: offset + rows.length < total ? offset + rows.length : null,
      };
    });
  }
  async forget(profile: string, values: string[]) {
    const handles = ids(values);
    return this.db.transaction(async (tx) => {
      const { rows } = await execute<RecordRow>(
        tx,
        sql`SELECT * FROM zero_mem0_records WHERE session=${profile} AND id=ANY(${sql.param(handles)}::bigint[]) AND status='ready' ORDER BY id FOR UPDATE`,
      );
      if (rows.length !== handles.length)
        throw new Error('Every memory must exist in this profile; no memories were deleted');
      // Delete payloads, vectors and any unfinalized SDK staging copies in one transaction.
      await execute(
        tx,
        sql`DELETE FROM zero_mem0_vectors WHERE payload->>'user_id'=${profile} AND payload->>'zero_id'=ANY(${sql.param(handles)}::text[])`,
      );
      await execute(
        tx,
        sql`UPDATE zero_mem0_records SET mem0_id=NULL, status='forgotten' WHERE session=${profile} AND id=ANY(${sql.param(handles)}::bigint[])`,
      );
      // Legacy records are a rollback archive, never a second live memory backend.
      await execute(
        tx,
        sql`UPDATE memories SET text='', summary=NULL, tags='[]'::jsonb, category='', embedding=NULL, forgotten_at=now()
        WHERE session=${profile} AND id=ANY(${sql.param(handles)}::bigint[])`,
      );
      return rows.length;
    });
  }
  pendingMemoryMessages(session: string) {
    return this.pending.pendingMemoryMessages(session);
  }
  pendingMemorySessions() {
    return this.pending.pendingMemorySessions();
  }
  markConsolidated(session: string, values: number[]) {
    return this.pending.markConsolidated(session, values);
  }
}

export function withMem0PersonalData(
  memory: Mem0Repository,
  conversations: PersonalDataPort,
): PersonalDataPort {
  return {
    memories: (...args) => memory.memories(...args),
    forget: (...args) => memory.forget(...args),
    conversations: (...args) => conversations.conversations(...args),
    message: (...args) => conversations.message(...args),
  };
}
