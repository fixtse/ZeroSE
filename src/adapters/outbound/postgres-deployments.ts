import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { deploymentRuns as runs } from './database-schema.js';
import { execute, createDatabase, type Database } from './database.js';
import type { PoolClient } from 'pg';
import type { BuildRelease } from '../../domain/deployment.js';
import type { DeploymentJob, DeploymentStore } from '../../application/deploy-build.js';

export class PostgresDeployments implements DeploymentStore {
  private lease?: PoolClient;
  constructor(private db: Database) {}
  async initialize() {
    this.lease = await this.db.$client.connect();
    const lock = await execute(
      createDatabase(this.lease),
      sql`SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':' || current_schema() || ':deployments',0)) AS acquired`,
    );
    if (!lock.rows[0].acquired) {
      this.lease.release();
      this.lease = undefined;
      throw new Error('Another deployment worker is running');
    }
    this.lease.on('error', () => {
      console.error(JSON.stringify({ event: 'deployment_lease_lost' }));
      process.exit(1);
    });
    await createDatabase(this.lease)
      .update(runs)
      .set({
        status: 'failed',
        detail: 'Worker stopped during deployment; inspect before retrying',
        finished: sql`now()`,
      })
      .where(eq(runs.status, 'running'));
  }
  async enqueue(release: BuildRelease): Promise<'accepted' | 'duplicate' | 'stale'> {
    return this.db.transaction(async (client) => {
      await execute(
        client,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':deployment-enqueue',0))`,
      );
      const existing = await client
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.run_id, release.runId), eq(runs.attempt, release.attempt)));
      const newer = await client
        .select({ id: runs.id })
        .from(runs)
        .where(gt(runs.run_number, release.runNumber))
        .limit(1);
      const result = existing.length ? 'duplicate' : newer.length ? 'stale' : 'accepted';
      if (result === 'accepted')
        await client.insert(runs).values({
          run_id: release.runId,
          attempt: release.attempt,
          run_number: release.runNumber,
          sha: release.sha,
        });
      return result;
    });
  }
  async claim(): Promise<DeploymentJob | undefined> {
    const next = this.db
      .$with('next')
      .as(
        this.db
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.status, 'pending'))
          .orderBy(runs.id)
          .limit(1)
          .for('update', { skipLocked: true }),
      );
    const [row] = await this.db
      .with(next)
      .update(runs)
      .set({ status: 'running' })
      .where(inArray(runs.id, this.db.select({ id: next.id }).from(next)))
      .returning();
    return row
      ? {
          id: String(row.id),
          runId: row.run_id,
          attempt: row.attempt,
          runNumber: row.run_number,
          sha: row.sha,
        }
      : undefined;
  }
  async finish(id: string, status: 'done' | 'failed', detail: string) {
    await this.db
      .update(runs)
      .set({ status, detail, finished: sql`now()` })
      .where(eq(runs.id, BigInt(id)));
  }
  async close() {
    if (this.lease) {
      await execute(
        createDatabase(this.lease),
        sql`SELECT pg_advisory_unlock(hashtextextended(current_database() || ':' || current_schema() || ':deployments',0))`,
      );
      this.lease.release();
      this.lease = undefined;
    }
  }
}
