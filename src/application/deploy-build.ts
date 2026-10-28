import type { BuildRelease } from '../domain/deployment.js';
import { deploymentNotificationError } from './deployment-notification-error.js';

export interface DeploymentJob extends BuildRelease {
  id: string;
}
export interface DeploymentStore {
  enqueue(release: BuildRelease): Promise<'accepted' | 'duplicate' | 'stale'>;
  claim(): Promise<DeploymentJob | undefined>;
  finish(id: string, status: 'done' | 'failed', detail: string): Promise<void>;
}
export interface DeploymentRunner {
  deploy(release: BuildRelease): Promise<string>;
}
export interface DeploymentNotifier {
  send(text: string): Promise<void>;
}

/** A separate host worker serializes deployments; failed or interrupted jobs are never replayed. */
export class DeployBuild {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  constructor(
    readonly store: DeploymentStore,
    private runner: DeploymentRunner,
    private notifier: DeploymentNotifier,
    private repository: string,
  ) {}
  start() {
    const pump = () => {
      if (this.stopped || this.active) return;
      this.active = this.tick()
        .catch(() => {
          console.error(JSON.stringify({ event: 'deployment_worker_failed' }));
        })
        .finally(() => {
          this.active = undefined;
        });
    };
    this.timer = setInterval(pump, 1000);
    pump();
  }
  private async tick() {
    const job = await this.store.claim();
    if (!job) return;
    let status: 'done' | 'failed' = 'done';
    let detail: string;
    try {
      detail = await this.runner.deploy(job);
    } catch (error) {
      status = 'failed';
      detail = error instanceof Error ? error.message : 'Deployment failed';
    }
    await this.store.finish(job.id, status, detail);
    const link = `https://github.com/${this.repository}/actions/runs/${job.runId}`;
    try {
      await this.notifier.send(
        status === 'done'
          ? `Servicio actualizado y saludable.\nVersión: ${job.sha.slice(0, 12)}\n${link}`
          : `No se pudo completar la actualización del servicio.\nVersión: ${job.sha.slice(0, 12)}\n${link}\nNo se reintentará automáticamente. Revisa el servicio antes de repetir el despliegue.`,
      );
      console.log(
        JSON.stringify({
          event: 'deployment_notification_sent',
          job: job.id,
          status,
          sha: job.sha,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'deployment_notification_failed',
          job: job.id,
          runId: job.runId,
          attempt: job.attempt,
          sha: job.sha,
          status,
          error: deploymentNotificationError(error),
        }),
      );
    }
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
