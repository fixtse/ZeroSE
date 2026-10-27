import { count, getTableColumns, sql, type InferInsertModel } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { databaseErrorCause, type SqlExecutor } from './database.js';
import {
  jobs,
  sessions,
  messages,
  memories,
  audit,
  schedules,
  cursors,
  imports,
} from './database-schema.js';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { Store } from './postgres-store.js';

const tables = {
  jobs: ['id', 'sequence', 'session', 'dedupe', 'payload', 'status', 'output', 'error', 'created'],
  sessions: ['id', 'thread', 'history_after'],
  messages: ['id', 'session', 'role', 'text', 'consolidated', 'created'],
  memories: ['id', 'session', 'text', 'category', 'tags', 'embedding', 'source', 'created'],
  audit: ['id', 'job', 'tool', 'success', 'duration', 'created'],
  schedules: ['key', 'created'],
  cursors: ['name', 'value'],
} as const;
const destinations = { jobs, sessions, messages, memories, audit, schedules, cursors };
const jsonColumns = new Set(['payload', 'tags', 'embedding']);
const numericColumns = new Set([
  'sequence',
  'history_after',
  'consolidated',
  'success',
  'duration',
  'value',
]);
function normalize(row: Record<string, any>, table: string) {
  const value = { ...row };
  for (const key of Object.keys(value)) {
    if (key === 'created')
      value[key] = new Date(
        typeof value[key] === 'string' && !/(Z|[+-]\d\d:\d\d)$/.test(value[key])
          ? value[key].replace(' ', 'T') + 'Z'
          : value[key],
      ).toISOString();
    else if (jsonColumns.has(key) && typeof value[key] === 'string')
      value[key] = JSON.parse(value[key]);
    else if (
      value[key] !== null &&
      (numericColumns.has(key) ||
        (key === 'id' && ['messages', 'memories', 'audit'].includes(table)))
    )
      value[key] = Number(value[key]);
  }
  // pgvector stores IEEE float32; compare to the same precision without changing source data.
  if (Array.isArray(value.embedding)) value.embedding = value.embedding.map(Math.fround);
  return value;
}
/** Map the legacy SQL column names to Drizzle properties and codecs, including dates and vectors. */
async function copyRows<T extends PgTable>(
  client: SqlExecutor,
  destination: T,
  table: string,
  names: readonly string[],
  rows: Record<string, any>[],
) {
  const columns = getTableColumns(destination) as Record<string, AnyPgColumn>;
  const properties = new Map(
    Object.entries(columns).map(([property, column]) => [column.name, property]),
  );
  for (const row of rows) {
    const normalized = normalize(row, table);
    const value = Object.fromEntries(
      names.map((name) => {
        const property = properties.get(name)!;
        const column = columns[property];
        let item = normalized[name];
        if (item !== null && column.dataType === 'date') item = new Date(item);
        if (item !== null && column.dataType === 'bigint') item = BigInt(item);
        return [property, item];
      }),
    ) as InferInsertModel<T>;
    await client.insert(destination).values(value);
  }
  const selection = Object.fromEntries(names.map((name) => [name, columns[properties.get(name)!]]));
  return client
    .select(selection)
    .from(destination as PgTable)
    .orderBy(columns[properties.get(names[0])!]);
}

/** Offline, transactional import into an empty target. Source is opened read-only. */
export async function importSqlite(file: string, store: Store): Promise<Record<string, number>> {
  const source = new DatabaseSync(file, { readOnly: true });
  const counts: Record<string, number> = {};
  try {
    source.exec('BEGIN');
    if (Number(source.prepare("SELECT count(*) AS n FROM jobs WHERE status='running'").get()?.n))
      throw new Error('Source has running jobs; stop the assistant cleanly before importing');
    return await store.db.transaction(async (client) => {
      for (const destination of Object.values(destinations)) {
        if ((await client.select({ n: count() }).from(destination))[0].n)
          throw new Error('Import requires an empty target database');
      }
      if ((await client.select({ key: imports.key }).from(imports).limit(1)).length)
        throw new Error('Database was already imported');
      for (const table of Object.keys(tables) as (keyof typeof tables)[]) {
        const columns = tables[table];
        const rows = source
          .prepare(
            `SELECT ${table === 'jobs' ? 'rowid AS sequence,*' : '*'} FROM ${table} ORDER BY ${columns[0]}`,
          )
          .all();
        const imported = await copyRows(client, destinations[table], table, columns, rows);
        if (
          rows.length !== imported.length ||
          !rows.every((row, index) =>
            isDeepStrictEqual(normalize(row, table), normalize(imported[index], table)),
          )
        )
          throw new Error(`Verification failed for ${table}; import rolled back`);
        counts[table] = rows.length;
      }
      for (const [table, column] of [
        ['jobs', 'sequence'],
        ['messages', 'id'],
        ['memories', 'id'],
        ['audit', 'id'],
      ] as const) {
        const target = destinations[table];
        const identity = getTableColumns(target)[
          column as keyof typeof target._.columns
        ] as AnyPgColumn;
        await client
          .select({
            value: sql`setval(pg_get_serial_sequence(${table}, ${column}), greatest(coalesce(max(${identity}), 0), 1), count(*) > 0)`,
          })
          .from(target);
      }
      await client.insert(imports).values({ key: 'sqlite-v1' });
      return counts;
    });
  } catch (error) {
    throw databaseErrorCause(error);
  } finally {
    source.close();
  }
}
