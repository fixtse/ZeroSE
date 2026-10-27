import { migrateDatabase } from './database-migrations.js';
import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  notInArray,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  jobs,
  sessions,
  messages,
  schedules,
  cursors,
  memories,
  audit,
  schemaVersion,
} from './database-schema.js';
import { execute, createDatabase, type Database } from './database.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient } from 'pg';
import type {
  Job,
  MemoryFragment,
  MemoryMatch,
  PendingMemoryMessage,
} from '../../domain/models.js';
import type { ConversationStore, AuditPort, MemoryRepository } from '../../application/ports.js';

/** PostgreSQL owns durable state. A session lock permits one active assistant per schema. */
export class Store implements ConversationStore, AuditPort, MemoryRepository {
  readonly pool: pg.Pool;
  readonly db: Database;
  private lease?: PoolClient;
  private closed = false;
  private constructor(
    url: string,
    readonly dimensions: number,
    schema: string,
    private legacyEmbeddingSpace = '',
  ) {
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4000)
      throw new Error('Embedding dimensions must be between 1 and 4000');
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid database schema');
    this.pool = new pg.Pool({
      connectionString: url,
      max: 8,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000,
      options: `-c search_path=${schema},public`,
    });
    this.db = createDatabase(this.pool);
    this.pool.on('error', () =>
      console.error(JSON.stringify({ event: 'database_connection_failed' })),
    );
  }
  static async open(
    url: string,
    dimensions: number,
    schema = 'public',
    legacyEmbeddingSpace = '',
  ): Promise<Store> {
    const store = new Store(url, dimensions, schema, legacyEmbeddingSpace);
    try {
      await migrateDatabase(store.pool);
      store.lease = await store.pool.connect();
      const { rows } = await execute(
        createDatabase(store.lease),
        sql`SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':' || current_schema() || ':assistant',0)) AS acquired`,
      );
      if (!rows[0].acquired) throw new Error('Another assistant already owns this database schema');
      // Losing this connection loses the execution lock: terminate before doing more work.
      store.lease.on('error', () => {
        console.error(JSON.stringify({ event: 'database_lease_lost' }));
        process.exit(1);
      });
      await store.initialize();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  private async initialize() {
    await createDatabase(this.lease!).transaction(async (client) => {
      await execute(client, sql`SELECT zero_configure_embeddings(${this.dimensions})`);
      await client
        .update(memories)
        .set({ embedding_space: this.legacyEmbeddingSpace })
        .where(and(isNull(memories.embedding_space), isNotNull(memories.embedding)));
      const [version] = await client
        .select()
        .from(schemaVersion)
        .orderBy(desc(schemaVersion.version))
        .limit(1);
      if (version.version !== 1 || version.dimensions !== this.dimensions)
        throw new Error('Database schema or embedding dimensions do not match configuration');
      await client
        .update(jobs)
        .set({
          status: 'failed',
          error: 'Service stopped during execution; inspect effects before retrying',
        })
        .where(eq(jobs.status, 'running'));
    });
  }
  private decode(row: any): Job {
    return { ...row, created: row.created.toISOString() };
  }
  async enqueue(session: string, payload: unknown, dedupe: string = randomUUID()): Promise<Job> {
    await this.db
      .insert(jobs)
      .values({
        id: randomUUID(),
        session,
        dedupe,
        payload: sql`${JSON.stringify(payload)}::jsonb`,
      })
      .onConflictDoNothing({ target: jobs.dedupe });
    const [row] = await this.db
      .select(this.jobSelection())
      .from(jobs)
      .where(eq(jobs.dedupe, dedupe));
    return this.decode(row);
  }
  private jobSelection() {
    // node-postgres historically exposes bigint identities as strings, including JSON API results.
    return { ...getTableColumns(jobs), sequence: sql<string>`${jobs.sequence}::text` };
  }
  async job(id: string): Promise<Job | undefined> {
    const [row] = await this.db.select(this.jobSelection()).from(jobs).where(eq(jobs.id, id));
    return row ? this.decode(row) : undefined;
  }
  async claim(excluded: string[]): Promise<Job | undefined> {
    return this.db.transaction(async (client) => {
      // Serialize claims as well as locking rows so concurrent callers cannot claim one session twice.
      await execute(
        client,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':claim',0))`,
      );
      const running = alias(jobs, 'running');
      const runningSession = client
        .select({ id: running.id })
        .from(running)
        .where(and(eq(running.session, jobs.session), eq(running.status, 'running')));
      const next = client.$with('next').as(
        client
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.status, 'pending'),
              notInArray(jobs.session, excluded),
              notExists(runningSession),
            ),
          )
          .orderBy(jobs.sequence)
          .limit(1)
          .for('update', { skipLocked: true }),
      );
      const [row] = await client
        .with(next)
        .update(jobs)
        .set({ status: 'running' })
        .where(inArray(jobs.id, client.select({ id: next.id }).from(next)))
        .returning(this.jobSelection());
      return row ? this.decode(row) : undefined;
    });
  }
  async finish(id: string, output: string) {
    await this.db.update(jobs).set({ status: 'done', output }).where(eq(jobs.id, id));
  }
  async fail(id: string, error: string) {
    await this.db.update(jobs).set({ status: 'failed', error }).where(eq(jobs.id, id));
  }
  async thread(session: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ thread: sql<string>`${sessions.thread}` })
      .from(sessions)
      .where(eq(sessions.id, session));
    return row?.thread;
  }
  async threadPolicy(session: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ policy: sessions.toolPolicy })
      .from(sessions)
      .where(eq(sessions.id, session));
    return row?.policy ?? undefined;
  }
  async setThread(session: string, thread: string, policy?: string) {
    const value = { thread, toolPolicy: policy || null };
    await this.db
      .insert(sessions)
      .values({ id: session, ...value })
      .onConflictDoUpdate({ target: sessions.id, set: value });
  }
  async reset(session?: string) {
    const historyAfter = sql<bigint>`(${this.db.select({ id: sql`coalesce(max(${messages.id}), 0)` }).from(messages)})`;
    if (session)
      await this.db
        .insert(sessions)
        .values({ id: session, thread: null, historyAfter })
        .onConflictDoUpdate({ target: sessions.id, set: { thread: null, historyAfter } });
    else await this.db.update(sessions).set({ thread: null, historyAfter });
  }
  async addMessage(session: string, role: string, text: string, remember = true) {
    await this.db.insert(messages).values({ session, role, text, consolidated: remember ? 0 : 1 });
  }
  async history(session: string) {
    const boundary = this.db
      .select({ id: sessions.historyAfter })
      .from(sessions)
      .where(eq(sessions.id, session));
    return (
      await this.db
        .select({ role: messages.role, text: messages.text, created: messages.created })
        .from(messages)
        .where(and(eq(messages.session, session), gt(messages.id, sql`coalesce((${boundary}), 0)`)))
        .orderBy(desc(messages.id))
        .limit(40)
    ).reverse();
  }
  async audit(job: string, tool: string, success: boolean, duration: number) {
    await this.db.insert(audit).values({ job, tool, success: +success, duration });
  }
  async scheduled(key: string) {
    const rows = await this.db
      .select({ key: schedules.key })
      .from(schedules)
      .where(eq(schedules.key, key));
    return rows.length > 0;
  }
  async markScheduled(key: string) {
    await this.db.insert(schedules).values({ key }).onConflictDoNothing();
  }
  async sessions(): Promise<string[]> {
    return (await this.db.select({ id: sessions.id }).from(sessions)).map((row) => row.id);
  }
  async cursor(name: string): Promise<number> {
    const [row] = await this.db
      .select({ value: cursors.value })
      .from(cursors)
      .where(eq(cursors.name, name));
    return row?.value || 0;
  }
  async setCursor(name: string, value: number) {
    await this.db
      .insert(cursors)
      .values({ name, value })
      .onConflictDoUpdate({
        target: cursors.name,
        set: { value: sql`GREATEST(${cursors.value}, ${value})` },
      });
  }

  async insertMemory(
    session: string,
    value: MemoryFragment,
    embedding: number[] | null,
    source?: string,
    embeddingSpace = this.legacyEmbeddingSpace,
  ) {
    return this.db.transaction(async (client) => {
      const rows = await client
        .insert(memories)
        .values({
          session,
          text: value.text,
          category: value.category,
          tags: value.tags,
          embedding,
          source: source || null,
          summary: value.summary || null,
          embedding_space: embedding ? embeddingSpace : null,
        })
        .onConflictDoNothing({ target: memories.source })
        .returning({ id: memories.id });
      const supersedes = [...new Set(value.supersedes || [])];
      if (rows.length && supersedes.length) {
        const updated = await client
          .update(memories)
          .set({ superseded_by: rows[0].id })
          .where(
            and(
              eq(memories.session, session),
              inArray(memories.id, supersedes.map(BigInt)),
              ne(memories.id, rows[0].id),
              isNull(memories.superseded_by),
              isNull(memories.forgotten_at),
            ),
          )
          .returning({ id: memories.id });
        if (updated.length !== supersedes.length)
          throw new Error('Superseded memories must be active records in this profile');
      }
    });
  }

  async searchMemory(
    session: string,
    query: string,
    vector: number[] | undefined,
    categories: string[],
    start?: string,
    end?: string,
    embeddingSpace = this.legacyEmbeddingSpace,
  ): Promise<MemoryMatch[]> {
    const filter = sql`session=${session} AND forgotten_at IS NULL AND superseded_by IS NULL AND (cardinality(${sql.param(categories)}::text[])=0 OR category=ANY(${sql.param(categories)})) AND (${start || null}::timestamptz IS NULL OR created >= ${start || null}) AND (${end || null}::timestamptz IS NULL OR created <= ${end || null})`;
    return this.db.transaction(async (client) => {
      await execute(client, sql`SET LOCAL hnsw.iterative_scan = 'strict_order'`);
      const { rows } = await execute(
        client,
        sql`WITH candidates AS MATERIALIZED (
          SELECT * FROM memories WHERE ${filter} AND embedding IS NOT NULL AND embedding_space=${embeddingSpace} AND ${vector ? JSON.stringify(vector) : null}::vector IS NOT NULL
          ORDER BY embedding::halfvec(${sql.raw(String(this.dimensions))}) <=> ${vector ? JSON.stringify(vector) : null}::halfvec(${sql.raw(String(this.dimensions))}) LIMIT 100
        ), semantic_scores AS (
          SELECT id, CASE WHEN vector_norm(embedding)=0 OR vector_norm(${vector ? JSON.stringify(vector) : null}::vector)=0 THEN 0
            ELSE 1-(embedding <=> ${vector ? JSON.stringify(vector) : null}::vector) END AS similarity FROM candidates
        ), semantic AS (
          SELECT id, similarity, row_number() OVER (ORDER BY similarity DESC, id DESC) AS rank
          FROM semantic_scores WHERE similarity > 0.4
        ), lexical_candidates AS MATERIALIZED (
          SELECT id, ts_rank_cd(to_tsvector('simple', text || ' ' || tags::text), websearch_to_tsquery('simple',${query})) AS score
          FROM memories WHERE ${filter}
            AND to_tsvector('simple', text || ' ' || tags::text) @@ websearch_to_tsquery('simple',${query})
          ORDER BY score DESC, id DESC LIMIT 100
        ), lexical AS (
          SELECT id, row_number() OVER (ORDER BY score DESC, id DESC) AS rank FROM lexical_candidates
        ), fused AS (
          SELECT COALESCE(s.id,l.id) AS id, COALESCE(s.similarity,0) AS similarity,
            COALESCE(1.0/(60+s.rank),0) + COALESCE(1.0/(60+l.rank),0) AS score
          FROM semantic s FULL OUTER JOIN lexical l ON s.id=l.id
        ) SELECT m.id,m.text,m.summary,m.category,m.tags,m.created,f.similarity
          FROM fused f JOIN memories m ON m.id=f.id
          ORDER BY f.score DESC,m.created DESC,m.id DESC LIMIT 50`,
      );
      return rows.map((row) => this.memoryMatch(row));
    });
  }
  private memoryMatch(row: any): MemoryMatch {
    return {
      id: String(row.id),
      text: row.text,
      summary: row.summary,
      superseded_by: row.superseded_by != null ? String(row.superseded_by) : null,
      metadata: { category: row.category, tags: row.tags, created_at: row.created.toISOString() },
      similarity: Number(row.similarity || 0),
    };
  }
  async readMemory(session: string, id: string): Promise<MemoryMatch | undefined> {
    const [row] = await this.db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.session, session),
          eq(memories.id, BigInt(id)),
          isNull(memories.forgotten_at),
        ),
      );
    return row ? this.memoryMatch(row) : undefined;
  }
  async memoryCatalog(session: string) {
    const filter = and(eq(memories.session, session), isNull(memories.forgotten_at));
    const categories = await this.db
      .selectDistinct({ category: memories.category })
      .from(memories)
      .where(filter);
    const tags = await this.db
      .selectDistinct({ tag: sql<string>`jsonb_array_elements_text(${memories.tags})` })
      .from(memories)
      .where(filter);
    return { categories: categories.map((row) => row.category), tags: tags.map((row) => row.tag) };
  }
  async pendingMemoryMessages(session: string): Promise<PendingMemoryMessage[]> {
    const rows = await this.db
      .select({
        id: messages.id,
        role: sql<PendingMemoryMessage['role']>`${messages.role}`,
        text: messages.text,
        created: messages.created,
      })
      .from(messages)
      .where(
        and(
          inArray(messages.role, ['user', 'assistant']),
          eq(messages.consolidated, 0),
          eq(messages.session, session),
        ),
      )
      .orderBy(messages.id)
      .limit(200);
    return rows.map((row) => ({
      id: Number(row.id),
      role: row.role,
      text: row.text,
      created: row.created.toISOString(),
    }));
  }
  async pendingMemorySessions(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ session: messages.session })
      .from(messages)
      .where(and(inArray(messages.role, ['user', 'assistant']), eq(messages.consolidated, 0)));
    return rows.map((row) => row.session);
  }
  async markConsolidated(session: string, ids: number[]) {
    await this.db
      .update(messages)
      .set({ consolidated: 1 })
      .where(and(eq(messages.session, session), inArray(messages.id, ids.map(BigInt))));
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.lease) {
      const lease = this.lease;
      this.lease = undefined;
      // Destroy rather than pool the connection that holds the lifetime advisory lock.
      lease.release(true);
    }
    await this.pool.end();
  }
}
