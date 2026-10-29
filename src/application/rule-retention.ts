export interface RuleRetentionPort {
  pruneFinished(now: Date, limit: number): Promise<number>;
}

/** Bounded batches run at startup and hourly, without overlapping or replaying jobs. */
export class RuleRetention {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private pending?: Promise<void>;
  constructor(
    private repository: RuleRetentionPort,
    private now = () => new Date(),
    private failed: () => void = () => {},
  ) {}
  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }
  private schedule(delay: number) {
    this.timer = setTimeout(() => {
      this.pending = this.run();
    }, delay);
  }
  private async run() {
    let count = 0;
    try {
      count = await this.repository.pruneFinished(this.now(), 100);
    } catch {
      this.failed();
    }
    if (this.running) this.schedule(count === 100 ? 0 : 3_600_000);
  }
  async close() {
    this.running = false;
    clearTimeout(this.timer);
    await this.pending;
  }
}
