import { resolve } from 'node:path';
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { createDatabase, databaseErrorCause, execute, type SqlExecutor } from './database.js';
import * as application from './database-schema.js';
import * as authentication from './auth-schema.js';

const tables = Object.values({ ...application, ...authentication }).filter((value) =>
  is(value, PgTable),
);
const journalName = '__drizzle_migrations';
// The initial source cleanup changed policy CHECK values in an already-shipped baseline.
// Accept only this exact historical/shipped pair; all other checksum checks stay strict.
const sanitizedBaseline = {
  timestamp: 1793064686202,
  previous: '15d0bed3f76f30026a155a50e6abeee740a95c54a1ebadb10103cad4008d3fcd',
  shipped: '17be5ed15e5a5abfc305b2bc06a497e888d2f8e61de8b8ac7cdbfd6db88acc51',
};

type Column = { table: string; name: string; type: string; required: boolean };
type Constraint = {
  table: string;
  name: string;
  kind: string;
  columns: string[];
  target: string | null;
  target_columns: string[];
  deletion: string;
};

async function structure(db: SqlExecutor) {
  const { rows: columns } = await execute<Column>(
    db,
    sql`SELECT c.relname AS "table", a.attname AS name,
    format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS required
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`,
  );
  const { rows: constraints } = await execute<Constraint>(
    db,
    sql`SELECT t.relname AS "table", c.conname AS name, c.contype AS kind,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(id, position)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.id ORDER BY k.position) AS "columns",
    f.relname AS target,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(id, position)
      JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.id ORDER BY k.position) AS target_columns,
    c.confdeltype AS deletion FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace LEFT JOIN pg_class f ON f.oid=c.confrelid
    WHERE n.nspname=current_schema()`,
  );
  const { rows: indexes } = await execute<{ name: string }>(
    db,
    sql`SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema()`,
  );
  return { columns, constraints, indexes: new Set(indexes.map((index) => index.name)) };
}

function validateExisting(state: Awaited<ReturnType<typeof structure>>) {
  for (const table of tables) {
    const config = getTableConfig(table);
    const actual = state.columns.filter((column) => column.table === config.name);
    if (!actual.length) continue; // Optional legacy modules can be absent; the baseline creates them.
    const fail = (detail: string): never => {
      throw new Error(
        `Database schema mismatch in ${config.name}: ${detail}. Inspect it before baselining.`,
      );
    };
    for (const column of config.columns) {
      const stored = actual.find((candidate) => candidate.name === column.name);
      if (!stored) fail(`missing column ${column.name}`);
      const expected = column.getSQLType();
      if (
        !(expected === 'vector'
          ? /^vector(?:\(\d+\))?$/.test(stored!.type)
          : expected === stored!.type)
      )
        fail(`incompatible type for ${column.name}`);
      if (column.notNull && !stored!.required) fail(`nullable required column ${column.name}`);
    }
    const constraint = (name: string, kind: string, columns?: string[]) => {
      const stored = state.constraints.find(
        (value) => value.table === config.name && value.name === name && value.kind === kind,
      );
      if (!stored || (columns && JSON.stringify(stored.columns) !== JSON.stringify(columns)))
        fail(`missing or incompatible constraint ${name}`);
      return stored!;
    };
    const primary = config.columns.filter((column) => column.primary).map((column) => column.name);
    if (primary.length) constraint(`${config.name}_pkey`, 'p', primary);
    for (const key of config.primaryKeys)
      constraint(
        key.getName(),
        'p',
        key.columns.map((column) => column.name),
      );
    for (const column of config.columns.filter((column) => column.isUnique))
      constraint(column.uniqueName!, 'u', [column.name]);
    for (const key of config.uniqueConstraints)
      constraint(
        key.getName() ?? fail('unique constraint must have an explicit name'),
        'u',
        key.columns.map((column) => column.name),
      );
    for (const check of config.checks) constraint(check.name, 'c');
    for (const key of config.foreignKeys) {
      const reference = key.reference();
      const stored = constraint(
        key.getName(),
        'f',
        reference.columns.map((column) => column.name),
      );
      const deletion =
        key.onDelete === 'cascade'
          ? 'c'
          : key.onDelete === 'set null'
            ? 'n'
            : key.onDelete === 'restrict'
              ? 'r'
              : 'a';
      if (
        stored.target !== getTableName(reference.foreignTable) ||
        JSON.stringify(stored.target_columns) !==
          JSON.stringify(reference.foreignColumns.map((column) => column.name)) ||
        stored.deletion !== deletion
      )
        fail(`incompatible foreign key ${key.getName()}`);
    }
  }
}

/** Adopt a recognized legacy schema using the generated baseline, never rewriting existing rows. */
async function baseline(
  db: ReturnType<typeof createDatabase<pg.PoolClient>>,
  schema: string,
  first: ReturnType<typeof readMigrationFiles>[number],
  state: Awaited<ReturnType<typeof structure>>,
) {
  validateExisting(state);
  const existing = new Set(state.columns.map((column) => column.table));
  await db.transaction(async (tx) => {
    for (const query of first.sql) {
      const statement = query.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').trim();
      if (!statement) continue;
      const table = /^CREATE TABLE "([^"]+)"/i.exec(statement);
      const foreign = /^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/i.exec(statement);
      const index = /^CREATE (?:UNIQUE )?INDEX "([^"]+)"/i.exec(statement);
      if (table && existing.has(table[1])) continue;
      if (
        foreign &&
        state.constraints.some((value) => value.table === foreign[1] && value.name === foreign[2])
      )
        continue;
      if (index && state.indexes.has(index[1])) continue;
      if (
        !table &&
        !foreign &&
        !index &&
        !/^CREATE EXTENSION IF NOT EXISTS vector\b/i.test(statement)
      )
        throw new Error(
          'The generated baseline contains an unsupported statement; review it before adoption',
        );
      await execute(tx, sql.raw(statement));
    }
    // Only migration bookkeeping is bootstrapped here; application DDL comes from drizzle-kit.
    const journal = sql`${sql.identifier(schema)}.${sql.identifier(journalName)}`;
    await execute(
      tx,
      sql`CREATE TABLE ${journal} (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at BIGINT)`,
    );
    await execute(
      tx,
      sql`INSERT INTO ${journal}(hash, created_at) VALUES(${first.hash}, ${first.folderMillis})`,
    );
  });
}

export async function migrateDatabase(pool: pg.Pool, options: { folder?: string } = {}) {
  const folder = options.folder || resolve('drizzle');
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  if (migrations.length < 2)
    throw new Error('Database migrations are missing the baseline or vector configuration');
  const connection = await pool.connect();
  const db = createDatabase(connection);
  try {
    // Serialize globally within the database because the vector extension is shared across schemas.
    await execute(
      db,
      sql`SELECT pg_advisory_lock(hashtextextended(current_database() || ':assistant-migrations', 0))`,
    );
    const [{ schema }] = (
      await execute<{ schema: string }>(db, sql`SELECT current_schema() AS schema`)
    ).rows;
    if (!schema) throw new Error('No writable database schema is selected');
    const state = await structure(db);
    const hasJournal = state.columns.some((column) => column.table === journalName);
    const journal = sql`${sql.identifier(schema)}.${sql.identifier(journalName)}`;
    const history = hasJournal
      ? (
          await execute<{ hash: string; created_at: string }>(
            db,
            sql`SELECT hash, created_at FROM ${journal} ORDER BY created_at`,
          )
        ).rows
      : [];
    for (const entry of history) {
      if (
        !migrations.some(
          (migration) =>
            migration.folderMillis === Number(entry.created_at) &&
            (migration.hash === entry.hash ||
              (migration.folderMillis === sanitizedBaseline.timestamp &&
                migration.hash === sanitizedBaseline.shipped &&
                entry.hash === sanitizedBaseline.previous)),
        )
      )
        throw new Error('Database migration history does not match the shipped migrations');
    }
    if (
      history.some((entry, index) => migrations[index]?.folderMillis !== Number(entry.created_at))
    )
      throw new Error('Database migration history is incomplete or out of order');
    const last = Number(history.at(-1)?.created_at || 0);
    if (migrations.some((migration) => migration.folderMillis > last)) {
      const lock = await execute(
        db,
        sql`SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':' || current_schema() || ':assistant', 0)) AS acquired`,
      );
      if (!lock.rows[0].acquired)
        throw new Error('Stop the assistant before applying database migrations');
      if (
        !hasJournal &&
        state.columns.some((column) => tables.some((table) => getTableName(table) === column.table))
      )
        await baseline(db, schema, migrations[0], state);
      await migrate(db, {
        migrationsFolder: folder,
        migrationsSchema: schema,
        migrationsTable: journalName,
      });
    }
    validateExisting(await structure(db));
  } catch (error) {
    throw databaseErrorCause(error);
  } finally {
    // Destroy the dedicated connection so neither migration nor assistant locks return to the pool.
    connection.release(true);
  }
}
