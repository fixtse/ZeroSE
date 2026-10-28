import type { NotificationRule } from '../domain/notification-rule.js';
import { localDeadline, localSchedulerIdentity } from '../domain/local-deadline.js';
import type { RuleRepository, RuleSchedulerPort, RuleEvent } from './notification-rules.js';

export interface LocalDeadlineRepository extends Pick<RuleRepository, 'byId' | 'apply'> {
  dueLocal(now: Date, limit: number): Promise<NotificationRule[]>;
}

export function selectRuleScheduler(
  kind: NotificationRule['kind'],
  key: string | undefined,
  local: RuleSchedulerPort,
  homeAssistant?: RuleSchedulerPort,
): RuleSchedulerPort | undefined {
  if (key === 'legacy-home-assistant') return homeAssistant;
  if (key)
    return [kind === 'alert' ? undefined : local, homeAssistant].find(
      (scheduler) => scheduler?.identity === key,
    );
  return kind === 'alert' ? homeAssistant : local;
}

/** The rule itself is the durable schedule. There is no second queue or remote install. */
export class LocalRuleScheduler implements RuleSchedulerPort {
  readonly identity = localSchedulerIdentity;
  constructor(private repository: Pick<RuleRepository, 'byId'>) {}
  async ready() {}
  async configure(rule: NotificationRule) {
    if (
      rule.kind === 'alert' ||
      rule.condition ||
      rule.wake_date ||
      (rule.status === 'active' && !Number.isFinite(Date.parse(rule.next_at!)))
    )
      throw new Error('Local scheduling supports clock reminders and timers only.');
    const saved = await this.repository.byId(rule.id);
    if (!saved || saved.generation !== rule.generation || saved.scheduler_key !== this.identity)
      throw new Error('The local rule changed; inspect it before continuing.');
  }
  async inspect(id: string) {
    const rule = await this.repository.byId(id);
    if (!rule || rule.scheduler_key !== this.identity) throw new Error('Local rule not found.');
    return { generation: rule.generation, status: rule.status, next_at: rule.next_at };
  }
}

/** One bounded worker; existing row locks and queue transactions suppress competing ticks. */
export class LocalDeadlineWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private pending?: Promise<void>;
  private startedAt: Date;
  constructor(
    private repository: LocalDeadlineRepository,
    private receive: (event: RuleEvent) => Promise<boolean>,
    private permitted: (rule: NotificationRule) => Promise<boolean>,
    private id: () => string,
    private now = () => new Date(),
    private failed: () => void = () => {},
  ) {
    this.startedAt = this.now();
  }
  async tick(now = this.now()) {
    const due = await this.repository.dueLocal(now, 100);
    for (const rule of due) {
      const occurrence = localDeadline(rule, now, this.startedAt);
      if (occurrence.missed || !(await this.permitted(rule))) {
        if (occurrence.next) rule.next_at = occurrence.next;
        else rule.status = 'expired';
        await this.repository.apply(rule);
      } else {
        await this.receive({
          id: rule.id,
          generation: rule.generation,
          event_id: this.id(),
          fired_at: occurrence.due,
        });
      }
    }
    return due.length;
  }
  start() {
    if (this.running) return;
    this.startedAt = this.now();
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
      count = await this.tick();
    } catch {
      this.failed();
    }
    if (this.running) this.schedule(count === 100 ? 0 : 1000);
  }
  async close() {
    this.running = false;
    clearTimeout(this.timer);
    await this.pending;
  }
}
