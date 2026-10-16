import type { NotificationRule } from '../domain/notification-rule.js';
import { evaluateRule } from '../domain/notification-rule.js';
import type { Job } from '../domain/models.js';
import type { HomeAssistantToolsPort } from './ports.js';
import type { JobResult } from './use-cases/contracts.js';

export function forecastObservation(
  value: unknown,
  horizonHours: number,
  minimumProbability: number,
  now = new Date(),
) {
  const response = value as any;
  const entries = Object.values(response?.service_response || {}) as any[];
  const forecast = entries.flatMap((entry) =>
    Array.isArray(entry?.forecast) ? entry.forecast : [],
  );
  if (!forecast.length) return undefined;
  const normalized = forecast.map((f: any) => ({
    datetime: f.datetime,
    condition: f.condition,
    precipitation: f.precipitation,
    precipitation_probability: f.precipitation_probability,
  }));
  const rain = normalized.some((f: any) => {
    const time = Date.parse(f.datetime);
    // A daily forecast's timestamp marks the start of its period, so include today's period.
    if (
      !Number.isFinite(time) ||
      time < now.getTime() - 24 * 3600_000 ||
      time > now.getTime() + horizonHours * 3600_000
    )
      return false;
    const probability = Number(f.precipitation_probability);
    const wet =
      ['rainy', 'pouring', 'lightning-rainy', 'snowy-rainy'].includes(f.condition) ||
      Number(f.precipitation) > 0;
    return (
      (wet && (f.precipitation_probability == null || probability >= minimumProbability)) ||
      (probability > 0 && probability >= minimumProbability)
    );
  });
  // Compare the complete forecast, including temperature changes, with stable key ordering.
  const canonical = (value: any): any =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  return { signature: JSON.stringify(canonical(forecast)), rain };
}

export interface RuleRepository {
  create(rule: Omit<NotificationRule, 'id' | 'version' | 'generation'>): Promise<NotificationRule>;
  read(session: string, id: string): Promise<NotificationRule | undefined>;
  list(
    session: string,
    kind: NotificationRule['kind'] | undefined,
    offset: number,
    limit: number,
  ): Promise<{ items: NotificationRule[]; total: number; next_offset: number | null }>;
  pending(): Promise<NotificationRule[]>;
  apply(rule: NotificationRule, fire?: boolean): Promise<boolean>;
  heartbeat(now: Date): Promise<void>;
  healthy(now: Date): Promise<boolean>;
}
export interface RuleScope {
  enabled: boolean;
  ha?: HomeAssistantToolsPort;
}

export class NotificationRules {
  private running?: Promise<void>;
  private closing = false;
  constructor(
    readonly repository: RuleRepository,
    private scope: (session: string) => Promise<RuleScope>,
  ) {}
  async requireHealthy() {
    if (!(await this.repository.healthy(new Date())))
      throw new Error(
        'Home Assistant reminder heartbeat is unavailable; configure or restore it before creating notifications',
      );
  }
  async change(
    session: string,
    id: string,
    operation: 'cancel' | 'pause' | 'resume' | 'snooze',
    seconds?: number,
    now = new Date(),
  ) {
    const rule = await this.repository.read(session, id);
    if (!rule) throw new Error('Notification rule not found in this chat');
    if (operation === 'cancel') rule.status = 'cancelled';
    else if (operation === 'pause' && rule.status === 'active') {
      rule.status = 'paused';
      rule.remaining_seconds = rule.next_at
        ? Math.max(1, (Date.parse(rule.next_at) - now.getTime()) / 1000)
        : null;
    } else if (operation === 'resume' && rule.status === 'paused') {
      await this.requireHealthy();
      rule.status = 'active';
      if (rule.kind !== 'alert')
        rule.next_at = new Date(now.getTime() + (rule.remaining_seconds || 1) * 1000).toISOString();
    } else if (operation === 'snooze' && rule.kind !== 'alert' && rule.status !== 'cancelled') {
      if (!seconds || seconds < 1 || seconds > 31_536_000)
        throw new Error('Supply snooze seconds between 1 and 31536000');
      await this.requireHealthy();
      rule.next_at = new Date(now.getTime() + seconds * 1000).toISOString();
      rule.status = 'active';
    } else throw new Error('Operation does not apply to the current rule state');
    rule.matched_since = null;
    rule.last_checked = null;
    rule.generation++;
    if (!(await this.repository.apply(rule)))
      throw new Error('Rule changed concurrently; read it before trying again');
    return { id, status: rule.status, next_at: rule.next_at };
  }
  tick() {
    if (this.closing) return Promise.resolve();
    if (!this.running)
      this.running = this.evaluate().finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  async close() {
    this.closing = true;
    await this.running;
  }
  private async evaluate() {
    const scopes = new Map<string, Promise<RuleScope>>();
    const readings = new Map<string, Promise<Map<string, string>>>();
    const forecasts = new Map<string, Promise<unknown>>();
    const pending = await this.repository.pending();
    const process = async (rule: NotificationRule) => {
      let scoped = scopes.get(rule.session);
      if (!scoped) {
        scoped = this.scope(rule.session);
        scopes.set(rule.session, scoped);
      }
      const scope = await scoped;
      if (!scope.enabled || (rule.kind === 'alert' && !scope.ha)) {
        await this.repository.apply({
          ...rule,
          status: 'paused',
          matched_since: null,
          last_checked: null,
          generation: rule.generation + 1,
        });
        return;
      }
      if (rule.condition?.source === 'weather') {
        let value = forecasts.get(rule.session);
        if (!value) {
          value = scope.ha!.forecast(AbortSignal.timeout(5000)).catch(() => undefined);
          forecasts.set(rule.session, value);
        }
        const forecast = forecastObservation(
          await value,
          rule.condition.horizon_hours,
          rule.condition.minimum_probability,
        );
        const evaluated = evaluateRule(rule, new Date(), undefined, forecast);
        await this.repository.apply(evaluated.rule, evaluated.fire);
        return;
      }
      let state: string | undefined;
      if (rule.kind === 'alert') {
        let values = readings.get(rule.session);
        if (!values) {
          values = scope
            .ha!.sensors('', AbortSignal.timeout(5000))
            .then(
              (result) =>
                new Map(
                  (result as { entity_id: string; state: string }[]).map((s) => [
                    s.entity_id,
                    s.state,
                  ]),
                ),
            )
            .catch(() => new Map<string, string>());
          readings.set(rule.session, values);
        }
        if (rule.condition) state = (await values).get(rule.condition.entity_id);
      }
      const evaluated = evaluateRule(rule, new Date(), state);
      await this.repository.apply(evaluated.rule, evaluated.fire);
    };
    for (let offset = 0; offset < pending.length; offset += 8) {
      const results = await Promise.allSettled(pending.slice(offset, offset + 8).map(process));
      for (const result of results)
        if (result.status === 'rejected')
          console.error(JSON.stringify({ event: 'notification_rule_evaluation_failed' }));
    }
    await this.repository.heartbeat(new Date());
  }
  async notification(job: Job): Promise<JobResult> {
    const rule = await this.repository.read(job.session, job.payload.ruleId);
    const scope = await this.scope(job.session);
    const permitted = scope.enabled && (rule?.kind !== 'alert' || !!scope.ha);
    if (
      !rule ||
      !permitted ||
      rule.generation !== job.payload.generation ||
      ['cancelled', 'paused', 'expired'].includes(rule.status)
    )
      return { output: '', deliver: false };
    return {
      output: `${rule.kind === 'timer' ? '⏲️ Temporizador' : rule.kind === 'alert' ? '🔔 Alerta' : '🔔 Recordatorio'}: ${rule.message}`,
      voice: false,
    };
  }
}
