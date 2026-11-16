import type { WeatherDeliveryState } from '../domain/weather-notifications.js';
import { replyText, type ReplyLanguage } from '../domain/language.js';
import {
  isLocationCondition,
  type LocationCondition,
  type NotificationRule,
} from '../domain/notification-rule.js';
import type { Job } from '../domain/models.js';
import type { JobResult } from './use-cases/contracts.js';
import type { WeatherChange } from '../domain/weather-change.js';
import { localSchedulerIdentity } from '../domain/local-deadline.js';

export interface RuleEvent {
  id: string;
  generation: number;
  event_id: string;
  fired_at: string;
  next_at?: string | null;
  weather?: WeatherChange;
}
export class SchedulerRuleNotFound extends Error {}

export interface RuleSchedulerPort {
  supportsLocationAlerts?(signal?: AbortSignal): Promise<boolean>;
  permitsLocationCondition?(condition: LocationCondition): boolean | Promise<boolean>;
  permitsCondition?(condition: NotificationRule['condition']): Promise<boolean>;
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
  profileWeather(session: string): Promise<NotificationRule | undefined>;
  read(session: string, id: string): Promise<NotificationRule | undefined>;
  byId(id: string): Promise<NotificationRule | undefined>;
  list(
    session: string,
    kind: NotificationRule['kind'] | undefined,
    offset: number,
    limit: number,
    options?: { includeAlerts?: boolean; excludeCancelled?: boolean; excludeManaged?: boolean },
  ): Promise<{ items: NotificationRule[]; total: number; next_offset: number | null }>;
  wakeReminders(session: string, date: string): Promise<NotificationRule[]>;
  completeWakeReminders(session: string, rules: NotificationRule[]): Promise<void>;
  legacy(): Promise<NotificationRule[]>;
  apply(rule: NotificationRule): Promise<boolean>;
  installation(id: string, generation: number, state: 'installed' | 'uncertain'): Promise<void>;
  accept(event: RuleEvent): Promise<boolean>;
  weatherEvidence(
    id: string,
    generation: number,
    change: WeatherChange,
    delivered?: boolean,
    deliveryState?: WeatherDeliveryState,
  ): Promise<WeatherChange | undefined>;
}
export interface RuleScope {
  enabled: boolean;
  weatherEnabled?: boolean;
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
    readonly wakeProfile?: (session: string) => Promise<{ enabled: boolean; date: string }>,
  ) {}
  /** Legacy entry point retained for stored identities and compatibility. */
  async ensureOwnerWeather(session: string, sleepEntity: string | null = 'input_boolean.dormir') {
    return this.ensureWeather(session, sleepEntity, false);
  }
  async ensureProfileWeather(session: string, sleepEntity: string | null = null) {
    const rule = await this.ensureWeather(session, sleepEntity, true);
    if (rule?.scheduler_state !== 'installed' || rule.status !== 'active')
      throw new Error('Weather subscription setup is uncertain; inspect before changing it.');
    const health = await this.profileWeatherStatus(session);
    if (health.state !== 'active' && health.state !== 'muted')
      throw new Error('Weather subscription is not active in Home Assistant.');
    return rule;
  }
  /** Read-only remote verification: an enabled preference is not proof of a working subscription. */
  async profileWeatherStatus(session: string, signal?: AbortSignal) {
    const rule = await this.repository.profileWeather(session);
    if (!rule) return { state: 'missing' as const };
    const scope = await this.scope(session, 'alert', rule.scheduler_key);
    if (!scope.enabled || !scope.scheduler || scope.scheduler.identity !== rule.scheduler_key)
      return { state: 'unavailable' as const };
    try {
      const observed = await scope.scheduler.inspect(rule.id, signal);
      if (
        observed.generation !== rule.generation ||
        rule.scheduler_state !== 'installed' ||
        observed.status !== rule.status
      )
        return {
          state: observed.status === 'paused' ? ('paused' as const) : ('unconfirmed' as const),
        };
      if (observed.status !== 'active') return { state: 'paused' as const };
      return { state: observed.muted ? ('muted' as const) : ('active' as const) };
    } catch (error) {
      return {
        state:
          error instanceof SchedulerRuleNotFound ? ('missing' as const) : ('unavailable' as const),
      };
    }
  }
  private async ensureWeather(session: string, sleepEntity: string | null, activate: boolean) {
    const scope = await this.scope(session, 'alert');
    if (!scope.enabled || !scope.scheduler)
      throw new Error('Weather alerts require an enabled chat and Home Assistant connection');
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
        ...(sleepEntity ? { sleep_entity: sleepEntity } : {}),
      },
      cooldown_seconds: 0,
      recurring: true,
      matched_since: null,
      last_checked: null,
      last_fired: null,
      latched: false,
      forecast_signature: null,
      scheduler_state: 'installing',
      scheduler_key: scope.scheduler.identity,
    });
    if (result.rule.scheduler_key && result.rule.scheduler_key !== scope.scheduler.identity)
      throw new Error('Weather subscription belongs to another Home Assistant connection.');
    // Only a confirmed existing installation may be reconciled. Never retry an uncertain write.
    if (activate && !result.created && result.rule.scheduler_state === 'installed')
      result.rule = (await this.observe(result.rule)).rule;
    if (result.created) await this.install(result.rule, scope.scheduler);
    else if (
      (result.rule.status === 'active' ||
        (activate && ['paused', 'cancelled'].includes(result.rule.status))) &&
      result.rule.scheduler_state === 'installed' &&
      result.rule.condition?.source === 'weather' &&
      ((hourly && !result.rule.condition.hourly_updates) ||
        result.rule.cooldown_seconds !== 0 ||
        (activate && result.rule.status !== 'active'))
    ) {
      const rule = result.rule;
      rule.condition = { ...result.rule.condition, ...(hourly ? { hourly_updates: true } : {}) };
      rule.cooldown_seconds = 0;
      rule.status = 'active';
      rule.retired_at = null;
      rule.generation++;
      rule.scheduler_state = 'installing';
      rule.scheduler_key = scope.scheduler.identity;
      if (await this.repository.apply(rule)) await this.install(rule, scope.scheduler);
    }
    return this.repository.read(session, result.rule.id);
  }
  async canNotify(rule: NotificationRule) {
    const scope = await this.scope(rule.session, rule.kind, rule.scheduler_key);
    if (rule.managed === 'owner_weather' && scope.weatherEnabled === false) return false;
    if (!scope.enabled || (rule.scheduler_key && scope.scheduler?.identity !== rule.scheduler_key))
      return false;
    if (
      rule.condition &&
      scope.scheduler?.permitsCondition &&
      !(await scope.scheduler.permitsCondition(rule.condition))
    )
      return false;
    if (
      isLocationCondition(rule.condition) &&
      !(await scope.scheduler?.permitsLocationCondition?.(rule.condition))
    )
      return false;
    if (rule.condition?.source === 'weather' && rule.condition.sleep_entity) {
      try {
        const observed = await scope.scheduler?.inspect(rule.id);
        return (
          observed?.muted === false &&
          observed.generation === rule.generation &&
          (observed.status === 'active' || (!rule.recurring && observed.status === 'completed'))
        );
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
    if (value.kind !== 'alert' && value.next_at) {
      const deadline = Date.parse(value.next_at);
      if (!Number.isFinite(deadline)) throw new Error('Supply a valid reminder deadline.');
      value = { ...value, next_at: new Date(deadline).toISOString() };
    }
    const scope = await this.scope(value.session, value.kind);
    if (!scope.enabled || !scope.scheduler)
      throw new Error('Rule scheduler is not available for this chat');
    if (!value.wake_date) await scope.scheduler.ready(signal);
    if (
      isLocationCondition(value.condition) &&
      (!(await scope.scheduler.supportsLocationAlerts?.(signal)) ||
        !(await scope.scheduler.permitsLocationCondition?.(value.condition)))
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
    let rule = await this.repository.read(session, id);
    if (!rule) throw new Error('Notification rule not found in this chat');
    rule = (await this.observe(rule, signal)).rule;
    const scope = await this.scope(session, rule.kind, rule.scheduler_key);
    if (rule.scheduler_key && scope.scheduler?.identity !== rule.scheduler_key)
      scope.scheduler = undefined;
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
    rule.scheduler_key = rule.wake_date
      ? undefined
      : scope.scheduler?.identity || rule.scheduler_key;
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
          'Locally suppressed; the original scheduler is unavailable, so its old rule could not be disabled.',
      };
    }
    await this.install(rule, scope.scheduler, signal);
    return { id, status: rule.status, next_at: rule.next_at, scheduler_state: 'installed' };
  }
  /** Change only Zero's execution request; HA continues watching the same rule. */
  async setAssistantRequest(session: string, id: string, request: string | null) {
    const rule = await this.repository.read(session, id);
    if (!rule) throw new Error('Notification rule not found in this chat');
    if (rule.wake_date || !['active', 'paused'].includes(rule.status))
      throw new Error('Only active or paused standalone notifications can run an assistant turn');
    const scope = await this.scope(session, rule.kind, rule.scheduler_key);
    if (!scope.enabled) throw new Error('Notifications are disabled for this chat');
    if (request !== null && (!request.trim() || request.trim().length > 4000))
      throw new Error('Supply an assistant request between 1 and 4000 characters');
    rule.assistant_request = request?.trim() || undefined;
    if (!(await this.repository.apply(rule)))
      throw new Error('Rule changed concurrently; read it before trying again');
    return { id, assistant_request: rule.assistant_request ?? null };
  }
  async receive(event: RuleEvent, local = false) {
    const age = Date.now() - Date.parse(event.fired_at);
    if (!Number.isFinite(age) || age < -30_000 || age > 60_000) return false;
    const rule = await this.repository.byId(event.id);
    if (!rule || rule.wake_date || rule.generation !== event.generation || rule.status !== 'active')
      return false;
    if ((rule.scheduler_key === localSchedulerIdentity) !== local) return false;
    if (!(await this.canNotify(rule))) return false;
    return this.repository.accept(event);
  }
  /** Read the scheduler before displaying or changing state; never reinstall on a read. */
  async observe(rule: NotificationRule, signal?: AbortSignal) {
    if (rule.wake_date) return { rule, observed: undefined };
    const scope = await this.scope(rule.session, rule.kind, rule.scheduler_key);
    let observed: Awaited<ReturnType<RuleSchedulerPort['inspect']>> | { available: false };
    try {
      if (
        !scope.scheduler ||
        (rule.scheduler_key && scope.scheduler.identity !== rule.scheduler_key)
      )
        throw new Error('Scheduler unavailable');
      observed = await scope.scheduler.inspect(rule.id, signal);
    } catch {
      observed = { available: false };
    }
    const updated = { ...rule };
    const awaitingCallback =
      'last_event' in observed &&
      observed.status === 'completed' &&
      ['pending', 'uncertain'].includes(observed.last_event?.outcome || '');
    if ('generation' in observed && observed.generation === rule.generation && !awaitingCallback) {
      updated.status = observed.status;
      updated.next_at = observed.next_at;
      updated.scheduler_state = 'installed';
    } else updated.scheduler_state = 'uncertain';
    if (
      updated.status !== rule.status ||
      updated.next_at !== rule.next_at ||
      updated.scheduler_state !== rule.scheduler_state
    ) {
      if (await this.repository.apply(updated))
        rule = (await this.repository.read(rule.session, rule.id))!;
      else rule = (await this.repository.read(rule.session, rule.id)) || rule;
    }
    return { rule, observed };
  }
  async list(...args: Parameters<RuleRepository['list']>) {
    const [session, kind, offset, limit, options] = args;
    const page = await this.repository.list(session, kind, offset, limit, {
      ...options,
      excludeManaged: true,
    });
    const items = [];
    const signal = AbortSignal.timeout(10000);
    for (const rule of page.items) items.push((await this.observe(rule, signal)).rule);
    return { ...page, items };
  }
  async inspect(session: string, id: string, signal?: AbortSignal) {
    const saved = await this.repository.read(session, id);
    if (!saved) throw new Error('Notification rule not found in this chat');
    const { rule, observed } = await this.observe(saved, signal);
    return rule.scheduler_key === localSchedulerIdentity
      ? { ...rule, scheduler: observed, home_assistant: undefined }
      : { ...rule, home_assistant: observed, scheduler: observed };
  }
  /** Explicit recovery reads an existing HA alert; it never installs or replays it. */
  async confirmScheduler(session: string, id: string, signal?: AbortSignal) {
    let rule = await this.repository.read(session, id);
    if (!rule) throw new Error('Notification rule not found in this chat');
    rule = (await this.observe(rule, signal)).rule;
    if (rule.scheduler_state === 'installed') return rule;
    if (rule.kind !== 'alert' || !/^[a-f0-9]{64}$/.test(rule.scheduler_key || ''))
      throw new Error('The original scheduler could not be confirmed');
    const scope = await this.scope(session, rule.kind);
    if (!scope.enabled || !scope.scheduler?.identity)
      throw new Error('Rule scheduler is unavailable');
    let observed;
    try {
      observed = await scope.scheduler.inspect(rule.id, signal);
    } catch (error) {
      if (error instanceof SchedulerRuleNotFound && ['active', 'paused'].includes(rule.status))
        return { missing: true as const, version: rule.version };
      throw error;
    }
    const awaitingCallback =
      observed.status === 'completed' &&
      ['pending', 'uncertain'].includes(observed.last_event?.outcome || '');
    if (observed.generation !== rule.generation || awaitingCallback)
      throw new Error(
        'The existing alert does not match the saved generation or has a pending callback',
      );
    const updated = {
      ...rule,
      scheduler_key: scope.scheduler.identity,
      status: observed.status,
      scheduler_state: 'installed' as const,
      next_at: observed.next_at,
    };
    if (!(await this.repository.apply(updated)))
      throw new Error('Rule changed concurrently; read it before trying again');
    return (await this.repository.read(session, id))!;
  }
  /** A fresh, explicit absence check and optimistic claim precede the single remote write. */
  async recreateAlert(session: string, id: string, version: number, signal?: AbortSignal) {
    const rule = await this.repository.read(session, id);
    if (!rule || rule.version !== version)
      throw new Error('Rule changed; confirm its absence again before recreating it');
    if (
      rule.kind !== 'alert' ||
      !['active', 'paused'].includes(rule.status) ||
      !/^[a-f0-9]{64}$/.test(rule.scheduler_key || '')
    )
      throw new Error('Only existing Home Assistant alert identities can be recovered');
    const scope = await this.scope(session, 'alert');
    if (!scope.enabled || !scope.scheduler?.identity)
      throw new Error('Rule scheduler is unavailable');
    await scope.scheduler.ready(signal);
    try {
      await scope.scheduler.inspect(rule.id, signal);
      throw new Error('The alert already exists; confirm its state instead');
    } catch (error) {
      if (!(error instanceof SchedulerRuleNotFound)) throw error;
    }
    rule.generation++;
    rule.scheduler_key = scope.scheduler.identity;
    rule.scheduler_state = 'installing';
    if (!(await this.repository.apply(rule)))
      throw new Error('Rule changed concurrently; confirm its absence again');
    await this.install(rule, scope.scheduler, signal);
    return { id: rule.id, status: rule.status, scheduler_state: 'installed' };
  }
  async weatherDelivered(job: Job, change: WeatherChange, state?: WeatherDeliveryState) {
    await this.repository.weatherEvidence(
      job.payload.ruleId,
      job.payload.generation,
      change,
      true,
      state,
    );
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
    explainWeather?: (
      change?: WeatherChange,
      rule?: NotificationRule,
    ) => Promise<string | JobResult>,
    language?: ReplyLanguage,
    runAssistant?: (request: string) => Promise<JobResult>,
  ): Promise<JobResult> {
    const rule = await this.repository.read(job.session, job.payload.ruleId);
    const permitted = rule && (await this.canNotify(rule));
    if (
      !rule ||
      rule.wake_date ||
      !permitted ||
      rule.generation !== job.payload.generation ||
      rule.assistant_request !== job.payload.assistantRequest ||
      ['cancelled', 'paused', 'expired'].includes(rule.status)
    )
      return { output: '', deliver: false };
    if (rule.assistant_request) {
      if (!runAssistant) throw new Error('Scheduled assistant turns are unavailable');
      return runAssistant(rule.assistant_request);
    }
    if (rule.condition?.source === 'weather' && explainWeather) {
      const pending = job.payload.weather
        ? await this.repository.weatherEvidence(rule.id, rule.generation, job.payload.weather)
        : undefined;
      const result = await explainWeather(pending, rule);
      return typeof result === 'string'
        ? { output: result, voice: false }
        : { voice: false, ...result };
    }
    return {
      output: `${rule.kind === 'timer' ? replyText(language, '⏲️ Temporizador', '⏲️ Timer') : rule.kind === 'alert' ? replyText(language, '🔔 Alerta', '🔔 Alert') : replyText(language, '🔔 Recordatorio', '🔔 Reminder')}: ${rule.message}`,
      voice: false,
    };
  }
}
