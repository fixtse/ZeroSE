import {
  isLocationCondition,
  type LocationCondition,
  type NotificationRule,
} from '../domain/notification-rule.js';
import type { Job } from '../domain/models.js';
import type { JobResult } from './use-cases/contracts.js';
import type { WeatherChange } from '../domain/weather-change.js';

export interface RuleEvent {
  id: string;
  generation: number;
  event_id: string;
  fired_at: string;
  next_at?: string | null;
  weather?: WeatherChange;
}
export interface RuleSchedulerPort {
  supportsLocationAlerts?(signal?: AbortSignal): Promise<boolean>;
  permitsLocationCondition?(condition: LocationCondition): boolean;
  supportsHourlyUpdates?(): Promise<boolean>;
  readonly identity?: string;
  ready(signal?: AbortSignal): Promise<void>;
  configure(rule: NotificationRule, signal?: AbortSignal): Promise<void>;
  inspect(
    id: string,
    signal?: AbortSignal,
  ): Promise<{
    generation: number;
    status: NotificationRule['status'];
    next_at: string | null;
    muted?: boolean;
    last_event?: { outcome: string };
  }>;
}
export interface RuleRepository {
  create(rule: Omit<NotificationRule, 'id' | 'version' | 'generation'>): Promise<NotificationRule>;
  ownerWeather(
    rule: Omit<NotificationRule, 'id' | 'version' | 'generation'>,
  ): Promise<{ rule: NotificationRule; created: boolean }>;
  read(session: string, id: string): Promise<NotificationRule | undefined>;
  byId(id: string): Promise<NotificationRule | undefined>;
  list(
    session: string,
    kind: NotificationRule['kind'] | undefined,
    offset: number,
    limit: number,
    options?: { includeAlerts?: boolean; excludeCancelled?: boolean },
  ): Promise<{ items: NotificationRule[]; total: number; next_offset: number | null }>;
  wakeReminders(session: string, date: string): Promise<NotificationRule[]>;
  completeWakeReminders(session: string, rules: NotificationRule[]): Promise<void>;
  legacy(): Promise<NotificationRule[]>;
  apply(rule: NotificationRule): Promise<boolean>;
  installation(id: string, generation: number, state: 'installed' | 'uncertain'): Promise<void>;
  accept(event: RuleEvent): Promise<boolean>;
}
export interface RuleScope {
  enabled: boolean;
  scheduler?: RuleSchedulerPort;
}
export class NotificationRules {
  constructor(
    readonly repository: RuleRepository,
    private scope: (
      session: string,
      kind: NotificationRule['kind'],
      schedulerKey?: string,
    ) => Promise<RuleScope>,
    readonly wakeSession?: string,
    readonly localDate: () => string | Promise<string> = () =>
      new Date().toISOString().slice(0, 10),
  ) {}
  async ensureOwnerWeather(session: string) {
    const scope = await this.scope(session, 'alert');
    if (!scope.enabled || !scope.scheduler)
      throw new Error('Owner weather alerts require an enabled chat and Home Assistant connection');
    await scope.scheduler.ready();
    const hourly = (await scope.scheduler.supportsHourlyUpdates?.()) === true;
    const result = await this.repository.ownerWeather({
      managed: 'owner_weather',
      session,
      kind: 'alert',
      message: 'La previsión meteorológica ha cambiado.',
      status: 'active',
      next_at: null,
      repeat_seconds: null,
      remaining_seconds: null,
      condition: {
        source: 'weather',
        ...(hourly ? { hourly_updates: true } : {}),
        mode: 'any_change',
        conditions: [],
        horizon_hours: 24,
        minimum_probability: 30,
        sleep_entity: 'input_boolean.dormir',
      },
      cooldown_seconds: 1800,
      recurring: true,
      matched_since: null,
      last_checked: null,
      last_fired: null,
      latched: false,
      forecast_signature: null,
      scheduler_state: 'installing',
      scheduler_key: scope.scheduler.identity,
    });
    if (result.created) await this.install(result.rule, scope.scheduler);
    else if (
      hourly &&
      result.rule.status === 'active' &&
      result.rule.scheduler_state === 'installed' &&
      result.rule.condition?.source === 'weather' &&
      !result.rule.condition.hourly_updates
    ) {
      const rule = result.rule;
      rule.condition = { ...result.rule.condition, hourly_updates: true };
      rule.generation++;
      rule.scheduler_state = 'installing';
      rule.scheduler_key = scope.scheduler.identity;
      if (await this.repository.apply(rule)) await this.install(rule, scope.scheduler);
    }
    return this.repository.read(session, result.rule.id);
  }
  async canNotify(rule: NotificationRule) {
    const scope = await this.scope(rule.session, rule.kind, rule.scheduler_key);
    if (!scope.enabled || (rule.scheduler_key && scope.scheduler?.identity !== rule.scheduler_key))
      return false;
    if (
      isLocationCondition(rule.condition) &&
      !scope.scheduler?.permitsLocationCondition?.(rule.condition)
    )
      return false;
    if (rule.condition?.source === 'weather' && rule.condition.sleep_entity) {
      try {
        const observed = await scope.scheduler?.inspect(rule.id);
        return observed?.muted === false && observed.generation === rule.generation;
      } catch {
        return false;
      }
    }
    return true;
  }
  async create(
    value: Omit<NotificationRule, 'id' | 'version' | 'generation'>,
    signal?: AbortSignal,
  ) {
    const scope = await this.scope(value.session, value.kind);
    if (!scope.enabled || !scope.scheduler)
      throw new Error('Rule scheduler is not available for this chat');
    if (!value.wake_date) await scope.scheduler.ready(signal);
    if (
      isLocationCondition(value.condition) &&
      (!(await scope.scheduler.supportsLocationAlerts?.(signal)) ||
        !scope.scheduler.permitsLocationCondition?.(value.condition))
    )
      throw new Error(
        'Location alerts require an upgraded Zero HA integration and permitted people/zones',
      );
    const rule = await this.repository.create({
      ...value,
      scheduler_state: value.wake_date ? 'installed' : 'installing',
      scheduler_key: value.wake_date ? undefined : scope.scheduler.identity,
    });
    if (!value.wake_date) await this.install(rule, scope.scheduler, signal);
    return rule;
  }
  private async install(
    rule: NotificationRule,
    scheduler: RuleSchedulerPort,
    signal?: AbortSignal,
  ) {
    try {
      await scheduler.configure(rule, signal);
      await this.repository.installation(rule.id, rule.generation, 'installed');
    } catch (error) {
      await this.repository.installation(rule.id, rule.generation, 'uncertain');
      throw new Error(
        `Rule ${rule.id} was saved but Scheduler setup is uncertain. Read reminder_get and inspect the scheduler before making another change.`,
        { cause: error },
      );
    }
  }
  async change(
    session: string,
    id: string,
    operation: 'cancel' | 'pause' | 'resume' | 'snooze',
    seconds?: number,
    now = new Date(),
    signal?: AbortSignal,
  ) {
    const rule = await this.repository.read(session, id);
    if (!rule) throw new Error('Notification rule not found in this chat');
    const scope = await this.scope(session, rule.kind, rule.scheduler_key);
    if (rule.wake_date && operation === 'snooze')
      throw new Error('Wake-up reminders use a local date, not an elapsed-time snooze');
    if ((operation === 'resume' || operation === 'snooze') && (!scope.enabled || !scope.scheduler))
      throw new Error('Rule scheduler is unavailable');
    if (operation === 'cancel') rule.status = 'cancelled';
    else if (operation === 'pause' && rule.status === 'active') {
      rule.status = 'paused';
      rule.remaining_seconds = rule.next_at
        ? Math.max(1, (Date.parse(rule.next_at) - now.getTime()) / 1000)
        : null;
    } else if (operation === 'resume' && rule.status === 'paused') {
      rule.status = 'active';
      if (rule.kind !== 'alert' && !rule.wake_date)
        rule.next_at = new Date(now.getTime() + (rule.remaining_seconds || 1) * 1000).toISOString();
    } else if (operation === 'snooze' && rule.kind !== 'alert' && rule.status !== 'cancelled') {
      if (!seconds || seconds < 1 || seconds > 31_536_000)
        throw new Error('Supply snooze seconds between 1 and 31536000');
      rule.next_at = new Date(now.getTime() + seconds * 1000).toISOString();
      rule.status = 'active';
    } else throw new Error('Operation does not apply to the current rule state');
    // Invalidate callbacks/queued delivery before contacting HA, even if that request fails.
    rule.generation++;
    rule.scheduler_state = rule.wake_date ? 'installed' : 'installing';
    rule.scheduler_key = rule.wake_date ? undefined : scope.scheduler?.identity;
    if (!(await this.repository.apply(rule)))
      throw new Error('Rule changed concurrently; read it before trying again');
    if (rule.wake_date) return { id, status: rule.status, wake_date: rule.wake_date };
    if (!scope.scheduler) {
      await this.repository.installation(rule.id, rule.generation, 'uncertain');
      return {
        id,
        status: rule.status,
        next_at: rule.next_at,
        scheduler_state: 'uncertain',
        detail:
          'Locally suppressed; Home Assistant access is unavailable, so its old rule could not be disabled.',
      };
    }
    await this.install(rule, scope.scheduler, signal);
    return { id, status: rule.status, next_at: rule.next_at, scheduler_state: 'installed' };
  }
  async receive(event: RuleEvent) {
    const age = Date.now() - Date.parse(event.fired_at);
    if (!Number.isFinite(age) || age < -30_000 || age > 60_000) return false;
    const rule = await this.repository.byId(event.id);
    if (!rule || rule.wake_date || rule.generation !== event.generation || rule.status !== 'active')
      return false;
    if (!(await this.canNotify(rule))) return false;
    return this.repository.accept(event);
  }
  async inspect(session: string, id: string, signal?: AbortSignal) {
    const rule = await this.repository.read(session, id);
    if (!rule) throw new Error('Notification rule not found in this chat');
    const scope = await this.scope(session, rule.kind, rule.scheduler_key);
    let home_assistant: unknown;
    if (scope.scheduler && !rule.wake_date) {
      try {
        home_assistant = await scope.scheduler.inspect(id, signal);
      } catch {
        home_assistant = { available: false };
      }
    }
    return { ...rule, home_assistant };
  }
  /** One-time upgrade only. Claim before the remote write; interrupted installs are never replayed. */
  async migrateLegacy() {
    for (const rule of await this.repository.legacy()) {
      const scope = await this.scope(
        rule.session,
        rule.kind,
        rule.scheduler_key || 'legacy-home-assistant',
      );
      rule.generation++;
      rule.scheduler_state = 'installing';
      rule.scheduler_key = scope.scheduler?.identity;
      if (
        rule.kind !== 'alert' &&
        rule.status === 'active' &&
        Date.parse(rule.next_at!) <= Date.now()
      )
        rule.status = 'expired';
      if (!scope.enabled || !scope.scheduler) rule.status = 'paused';
      if (!(await this.repository.apply(rule))) continue;
      if (!scope.scheduler) {
        await this.repository.installation(rule.id, rule.generation, 'uncertain');
        continue;
      }
      try {
        await this.install(rule, scope.scheduler);
      } catch {
        console.error(
          JSON.stringify({ event: 'legacy_notification_rule_install_uncertain', rule: rule.id }),
        );
      }
    }
  }
  async notification(
    job: Job,
    explainWeather?: () => Promise<string | JobResult>,
  ): Promise<JobResult> {
    const rule = await this.repository.read(job.session, job.payload.ruleId);
    const permitted = rule && (await this.canNotify(rule));
    if (
      !rule ||
      rule.wake_date ||
      !permitted ||
      rule.generation !== job.payload.generation ||
      ['cancelled', 'paused', 'expired'].includes(rule.status)
    )
      return { output: '', deliver: false };
    if (rule.condition?.source === 'weather' && explainWeather) {
      const result = await explainWeather();
      return typeof result === 'string'
        ? { output: result, voice: false }
        : { voice: false, ...result };
    }
    return {
      output: `${rule.kind === 'timer' ? '⏲️ Temporizador' : rule.kind === 'alert' ? '🔔 Alerta' : '🔔 Recordatorio'}: ${rule.message}`,
      voice: false,
    };
  }
}
