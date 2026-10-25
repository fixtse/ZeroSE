import { createHash, createHmac } from 'node:crypto';
import type { NotificationRule } from '../../domain/notification-rule.js';
import type { RuleSchedulerPort, RuleEvent } from '../../application/notification-rules.js';
import { jsonRequest, jsonBody, RemoteError } from './http.js';

export function schedulerSeCallbackToken(apiKey: string) {
  return createHmac('sha256', apiKey).update('zero-schedulerse-callback-v1').digest('hex');
}
export function schedulerSeTaskId(id: string, generation: number) {
  return `zero-${id}-${generation}`;
}
/** Optional deadline backend. Sensor/weather conditions remain owned by HA. */
export class SchedulerSE implements RuleSchedulerPort {
  readonly identity: string;
  constructor(
    private config: { url: string; token: string; callbackUrl: string },
    private rule: (id: string) => Promise<NotificationRule | undefined>,
  ) {
    this.identity = 'schedulerse:' + createHash('sha256').update(JSON.stringify([config.url, config.token])).digest('hex');
  }
  private request(path: string, method = 'GET', value?: unknown, signal?: AbortSignal) {
    if (!this.config.url || !this.config.token) throw new Error('SchedulerSE is not configured');
    return jsonRequest(this.config.url.replace(/\/$/, '') + '/api/agent/v1' + path, {
      method, ...(value === undefined ? {} : jsonBody(value)),
      headers: { Authorization: 'Bearer ' + this.config.token, 'Content-Type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    }, 'SchedulerSE');
  }
  async ready(signal?: AbortSignal) {
    const connection = await this.request('/connection', 'GET', undefined, signal);
    if (connection.delivery_mode !== 'webhook' || connection.webhook_url !== this.config.callbackUrl || !connection.has_webhook_authorization)
      throw new Error('Configure SchedulerSE webhook delivery to Zero with its dedicated callback credential');
  }
  private async task(id: string, signal?: AbortSignal): Promise<any | undefined> {
    try { return await this.request('/tasks/' + encodeURIComponent(id), 'GET', undefined, signal); }
    catch (error) { if (error instanceof RemoteError && error.status === 404) return undefined; throw error; }
  }
  async configure(rule: NotificationRule, signal?: AbortSignal) {
    if (rule.kind === 'alert' || rule.condition) throw new Error('SchedulerSE cannot monitor Home Assistant conditions');
    if (Buffer.byteLength(rule.message, 'utf8') > 8000) throw new Error('SchedulerSE reminder text exceeds 8000 bytes');
    if (rule.generation > 0) {
      const previous = schedulerSeTaskId(rule.id, rule.generation - 1);
      const task = await this.task(previous, signal);
      if (task?.status === 'pending') await this.request('/tasks/' + previous, 'DELETE', undefined, signal);
      else if (task?.status === 'delivering') throw new Error('Previous occurrence is being delivered; inspect before changing it');
    }
    if (rule.status !== 'active') return;
    if (!rule.next_at) throw new Error('SchedulerSE requires a deadline');
    const id = schedulerSeTaskId(rule.id, rule.generation);
    // A stable ID identifies this generation. Never replay an uncertain create.
    const result = await this.request('/tasks', 'POST', {
      id, kind: rule.kind, title: 'Zero ' + rule.kind, message: rule.message,
      run_at: rule.next_at, interval_seconds: rule.repeat_seconds || 0,
      context: { integration: 'zero', rule_id: rule.id, generation: rule.generation },
    }, signal);
    if (result?.id !== id) throw new Error('SchedulerSE did not acknowledge the intended task');
  }
  async inspect(id: string, signal?: AbortSignal) {
    const rule = await this.rule(id);
    if (!rule) throw new Error('Unknown Zero rule');
    if (rule.status !== 'active') return { generation: rule.generation, status: rule.status, next_at: rule.next_at };
    const task = await this.task(schedulerSeTaskId(id, rule.generation), signal);
    if (!task || task.context?.rule_id !== id || task.context?.generation !== rule.generation)
      throw new Error('SchedulerSE task does not match the current rule');
    const status: NotificationRule['status'] = ['pending', 'delivering'].includes(task.status) ? 'active' : task.status === 'delivered' ? 'completed' : task.status === 'cancelled' ? 'cancelled' : 'expired';
    return { generation: rule.generation, status, next_at: task.run_at_unix ? new Date(task.run_at_unix * 1000).toISOString() : null };
  }
}

export function schedulerSeEvent(value: {
  event_id: string; scheduled_at: string;
  task: { id: string; interval_seconds: number; context: { integration: 'zero'; rule_id: string; generation: number } };
}): RuleEvent {
  const context = value.task.context;
  if (value.task.id !== schedulerSeTaskId(context.rule_id, context.generation) || value.event_id !== value.task.id + ':' + value.scheduled_at)
    throw new Error('SchedulerSE event identity does not match its occurrence');
  const hash = createHash('sha256').update('schedulerse:' + value.event_id).digest('hex');
  const event_id = `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
  return { id: context.rule_id, generation: context.generation, event_id, fired_at: value.scheduled_at,
    next_at: value.task.interval_seconds ? new Date(Date.parse(value.scheduled_at) + value.task.interval_seconds * 1000).toISOString() : null };
}
