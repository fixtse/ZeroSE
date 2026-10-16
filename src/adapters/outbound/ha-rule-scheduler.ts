import { createHash } from 'node:crypto';
import type { Config } from '../../domain/config.js';
import type { NotificationRule } from '../../domain/notification-rule.js';
import type { RuleSchedulerPort } from '../../application/notification-rules.js';
import { jsonRequest, jsonBody } from './http.js';

export class HomeAssistantRuleScheduler implements RuleSchedulerPort {
  readonly identity: string;
  constructor(private config: Config['homeAssistant']) {
    this.identity = createHash('sha256')
      .update(
        JSON.stringify([config.url, config.token, config.weatherEntity, config.sensorEntities]),
      )
      .digest('hex');
  }
  private request(path: string, method: string, value?: unknown, signal?: AbortSignal) {
    if (!this.config.token || !this.config.url)
      throw new Error('Home Assistant scheduler credentials are not configured');
    return jsonRequest(
      this.config.url.replace(/\/$/, '') + '/api/assistant_rules' + path,
      {
        method,
        ...(value === undefined ? {} : jsonBody(value)),
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          'Content-Type': 'application/json',
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      },
      'Home Assistant rule scheduler',
    );
  }
  async ready(signal?: AbortSignal) {
    const response = await this.request('', 'GET', undefined, signal);
    if (response?.protocol !== 2 || response?.ready !== true)
      throw new Error('Install/start the event-driven assistant_rules Home Assistant integration');
  }
  async configure(rule: NotificationRule, signal?: AbortSignal) {
    let weatherEntity = this.config.weatherEntity;
    if (rule.condition?.source === 'weather' && !weatherEntity) {
      const states = await jsonRequest(
        this.config.url.replace(/\/$/, '') + '/api/states',
        {
          headers: { Authorization: `Bearer ${this.config.token}` },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000),
        },
        'Home Assistant weather discovery',
      );
      const candidates = (states as any[]).filter(
        (s) => /^weather\.[a-z0-9_]+$/.test(s.entity_id) && s.attributes?.supported_features & 1,
      );
      if (candidates.length !== 1)
        throw new Error(
          'Configure homeAssistant.weatherEntity when there is not exactly one daily forecast source',
        );
      weatherEntity = candidates[0].entity_id;
    }
    const condition =
      rule.condition?.source === 'weather'
        ? { ...rule.condition, entity_id: weatherEntity }
        : rule.condition;
    if (condition?.source === 'weather' && !/^weather\.[a-z0-9_]+$/.test(condition.entity_id))
      throw new Error('Home Assistant weather entity is not configured');
    if (
      rule.status === 'active' &&
      rule.kind === 'alert' &&
      condition &&
      condition.source !== 'weather' &&
      (!/^(sensor|binary_sensor)\.[a-z0-9_]+$/.test(condition.entity_id) ||
        (this.config.sensorEntities.length > 0 &&
          !this.config.sensorEntities.includes(condition.entity_id)))
    ) {
      throw new Error('Alert sensor is no longer permitted in this profile');
    }
    const response = await this.request(
      '/' + encodeURIComponent(rule.id),
      'PUT',
      {
        id: rule.id,
        generation: rule.generation,
        kind: rule.kind,
        status: rule.status,
        next_at: rule.next_at,
        repeat_seconds: rule.repeat_seconds,
        condition,
        cooldown_seconds: rule.cooldown_seconds,
        last_fired: rule.last_fired,
        recurring: rule.recurring,
      },
      signal,
    );
    if (response?.id !== rule.id || response?.generation !== rule.generation)
      throw new Error('Home Assistant did not acknowledge this rule generation');
    if (rule.status === 'active' && response.status === 'expired')
      throw new Error(
        'Home Assistant received the deadline too late; inspect the saved rule before rescheduling',
      );
  }
  async inspect(id: string, signal?: AbortSignal) {
    return this.request('/' + encodeURIComponent(id), 'GET', undefined, signal);
  }
}
