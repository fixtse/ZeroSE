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
/** Offline, transactional import into an empty target. Source is opened read-only. */
export async function importSqlite(file: string, store: Store): Promise<Record<string, number>> {
  const source = new DatabaseSync(file, { readOnly: true });
  const client = await store.pool.connect();
  const counts: Record<string, number> = {};
  try {
    source.exec('BEGIN');
    if (Number(source.prepare("SELECT count(*) AS n FROM jobs WHERE status='running'").get()?.n))
      throw new Error('Source has running jobs; stop the assistant cleanly before importing');
    await client.query('BEGIN');
    for (const table of Object.keys(tables)) {
      if (Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n))
        throw new Error('Import requires an empty target database');
    }
    if ((await client.query('SELECT 1 FROM imports')).rowCount)
      throw new Error('Database was already imported');
    for (const [table, columns] of Object.entries(tables)) {
      const rows = source
        .prepare(
          `SELECT ${table === 'jobs' ? 'rowid AS sequence,*' : '*'} FROM ${table} ORDER BY ${columns[0]}`,
        )
        .all();
      for (const row of rows) {
        const normalized = normalize(row, table);
        await client.query(
          `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_, i) => '$' + (i + 1)).join(',')})`,
          columns.map((key) =>
            jsonColumns.has(key) && row[key] !== null ? String(row[key]) : normalized[key],
          ),
        );
      }
      const imported = (
        await client.query(`SELECT ${columns.join(',')} FROM ${table} ORDER BY ${columns[0]}`)
      ).rows;
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
    ])
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}','${column}'),GREATEST(COALESCE(MAX(${column}),0),1),COUNT(*)>0) FROM ${table}`,
      );
    await client.query("INSERT INTO imports(key) VALUES('sqlite-v1')");
    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    source.close();
    client.release();
  }
}
