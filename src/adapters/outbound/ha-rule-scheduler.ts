import { HomeAssistant } from './home-assistant.js';
import { homeAssistantCommand } from './home-assistant-socket.js';
import { isLocationCondition, type LocationCondition } from '../../domain/notification-rule.js';
import { createHash } from 'node:crypto';
import type { Config } from '../../domain/config.js';
import type { NotificationRule } from '../../domain/notification-rule.js';
import {
  SchedulerRuleNotFound,
  type RuleSchedulerPort,
} from '../../application/notification-rules.js';
import { jsonRequest, jsonBody, RemoteError } from './http.js';

export class HomeAssistantRuleScheduler implements RuleSchedulerPort {
  readonly identity: string;
  constructor(
    private config: Config['homeAssistant'],
    private command = homeAssistantCommand,
  ) {
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
      throw new Error('Install/start the unified Zero Assistant Home Assistant integration');
  }
  async supportsLocationAlerts(signal?: AbortSignal) {
    return (await this.request('', 'GET', undefined, signal))?.location_alerts === true;
  }
  async permitsLocationCondition(condition: LocationCondition) {
    return this.permitsCondition(condition);
  }
  async permitsCondition(condition: NotificationRule['condition'], signal?: AbortSignal) {
    try {
      await this.assertCondition(condition, signal);
      return true;
    } catch {
      return false;
    }
  }
  private async assertCondition(condition: NotificationRule['condition'], signal?: AbortSignal) {
    if (!condition) return;
    const ha = new HomeAssistant(this.config, this.command);
    const entities =
      condition.source === 'weather'
        ? [
            await ha.weatherSource(signal),
            ...(condition.sleep_entity ? [condition.sleep_entity] : []),
          ]
        : isLocationCondition(condition)
          ? [condition.entity_id, condition.target_entity_id]
          : [condition.entity_id];
    await ha.assertExposed(entities, signal);
  }
  async supportsHourlyUpdates() {
    return (await this.request('', 'GET'))?.hourly_updates === true;
  }
  async configure(rule: NotificationRule, signal?: AbortSignal) {
    if (
      rule.status === 'active' &&
      isLocationCondition(rule.condition) &&
      [rule.condition.entity_id, rule.condition.target_entity_id].some((id) =>
        id.startsWith('device_tracker.'),
      ) &&
      (await this.request('', 'GET', undefined, signal))?.device_tracker_location_alerts !== true
    )
      throw new Error(
        'Actualiza la integración Zero de Home Assistant a 1.8.0 o posterior para usar alertas con device_tracker.',
      );
    const weatherEntity =
      rule.condition?.source === 'weather'
        ? await new HomeAssistant(this.config, this.command).weatherSource(signal)
        : this.config.weatherEntity;
    const condition =
      rule.condition?.source === 'weather'
        ? { ...rule.condition, entity_id: weatherEntity }
        : rule.condition;
    if (condition?.source === 'weather' && !/^weather\.[a-z0-9_]+$/.test(condition.entity_id))
      throw new Error('Home Assistant weather entity is not configured');
    if (rule.status === 'active' && rule.kind === 'alert')
      await this.assertCondition(rule.condition, signal);
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
    try {
      return await this.request('/' + encodeURIComponent(id), 'GET', undefined, signal);
    } catch (error) {
      if (!(error instanceof RemoteError) || error.status !== 404) throw error;
      // An absent integration/route must never be mistaken for an absent alert.
      await this.ready(signal);
      throw new SchedulerRuleNotFound('Home Assistant did not find this rule');
    }
  }
}
