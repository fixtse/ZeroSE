import { DrizzleQueryError, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg, { type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import * as schema from './database-schema.js';

export function createDatabase<T extends pg.Pool | PoolClient>(client: T) {
  return drizzle({ client, schema });
}

export type Database = ReturnType<typeof createDatabase<pg.Pool>>;
export type SqlExecutor = Pick<Database, 'execute' | 'select' | 'insert' | 'update' | 'delete'>;

/** Both query builders and raw executors can wrap a driver's SQLSTATE. */
export function databaseErrorCode(error: unknown): string | undefined {
  const cause = databaseErrorCause(error);
  return cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined;
}

/** Preserve driver diagnostics at boundaries that previously exposed them, without SQL parameters. */
export function databaseErrorCause(error: unknown): unknown {
  return error instanceof DrizzleQueryError && error.cause ? error.cause : error;
}

/** Complex SQL keeps its existing result contract while running through Drizzle. */
export async function execute<Row extends QueryResultRow = QueryResultRow>(
  database: SqlExecutor,
  query: SQL,
): Promise<QueryResult<Row>> {
  try {
    const result = await database.execute<Row>(query);
    // node-postgres uses Date objects; Drizzle's raw executor returns timestamp strings.
    // Keep the adapter contracts (including recovery expiry comparisons) unchanged.
    for (const part of Array.isArray(result) ? result : [result]) {
      for (const field of part.fields) {
        if (field.dataTypeID !== 1114 && field.dataTypeID !== 1184) continue;
        const parse = pg.types.getTypeParser(field.dataTypeID);
        for (const row of part.rows) {
          if (typeof row[field.name] === 'string')
            (row as QueryResultRow)[field.name] = parse(row[field.name]);
        }
      }
    }
    return result as QueryResult<Row>;
  } catch (error) {
    // Existing conflict handling depends on the driver's SQLSTATE, not an ORM wrapper.
    throw databaseErrorCause(error);
  }
}
