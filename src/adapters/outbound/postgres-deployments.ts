import type pg from 'pg';
import type { BuildRelease } from '../../domain/deployment.js';
import type { DeploymentJob, DeploymentStore } from '../../application/deploy-build.js';

export class PostgresDeployments implements DeploymentStore {
  private lease?: pg.PoolClient;
  constructor(private pool: pg.Pool) {}
  async initialize() {
    this.lease = await this.pool.connect();
    const lock = await this.lease.query(
      "SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':' || current_schema() || ':deployments',0)) AS acquired",
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
    await this.lease.query(`CREATE TABLE IF NOT EXISTS deployment_runs (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      run_id TEXT NOT NULL, attempt INTEGER NOT NULL, run_number BIGINT NOT NULL, sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed')),
      detail TEXT, created TIMESTAMPTZ NOT NULL DEFAULT now(), finished TIMESTAMPTZ,
      UNIQUE(run_id,attempt));
      UPDATE deployment_runs SET status='failed', detail='Worker stopped during deployment; inspect before retrying',finished=now() WHERE status='running';`);
  }
  async enqueue(release: BuildRelease): Promise<'accepted' | 'duplicate' | 'stale'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':deployment-enqueue',0))",
      );
      const existing = await client.query(
        'SELECT id FROM deployment_runs WHERE run_id=$1 AND attempt=$2',
        [release.runId, release.attempt],
      );
      const newer = await client.query(
        'SELECT id FROM deployment_runs WHERE run_number > $1 LIMIT 1',
        [release.runNumber],
      );
      const result = existing.rowCount ? 'duplicate' : newer.rowCount ? 'stale' : 'accepted';
      if (result === 'accepted')
        await client.query(
          'INSERT INTO deployment_runs(run_id,attempt,run_number,sha) VALUES($1,$2,$3,$4)',
          [release.runId, release.attempt, release.runNumber, release.sha],
        );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async claim(): Promise<DeploymentJob | undefined> {
    const { rows } = await this.pool.query(`WITH next AS (
      SELECT id FROM deployment_runs WHERE status='pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE deployment_runs SET status='running' FROM next WHERE deployment_runs.id=next.id RETURNING deployment_runs.*`);
    const row = rows[0];
    return row
      ? {
          id: String(row.id),
          runId: row.run_id,
          attempt: row.attempt,
          runNumber: Number(row.run_number),
          sha: row.sha,
        }
      : undefined;
  }
  async finish(id: string, status: 'done' | 'failed', detail: string) {
    await this.pool.query(
      'UPDATE deployment_runs SET status=$2,detail=$3,finished=now() WHERE id=$1',
      [id, status, detail],
    );
  }
  async close() {
    if (this.lease) {
      await this.lease.query(
        "SELECT pg_advisory_unlock(hashtextextended(current_database() || ':' || current_schema() || ':deployments',0))",
      );
      this.lease.release();
      this.lease = undefined;
    }
  }
}
