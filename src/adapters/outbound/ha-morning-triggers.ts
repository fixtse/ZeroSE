import { createHash } from 'node:crypto';
import { HomeAssistant } from './home-assistant.js';
import type { Config } from '../../domain/config.js';
import type { ProfileNotifications } from '../../domain/access.js';
import type { MorningTriggerPort } from '../../application/morning-triggers.js';
import { jsonRequest } from './http.js';

/** Native HA state triggers, scoped per profile; reconnecting never replays missed states. */
export class HomeAssistantMorningTriggers implements MorningTriggerPort {
  private watches = new Map<
    string,
    { signature: string; socket: WebSocket; wake: () => Promise<void>; close: () => void }
  >();
  constructor(
    private socket: (url: URL) => WebSocket = (url) => new WebSocket(url),
    private authorize = (config: Config['homeAssistant'], entity: string) =>
      new HomeAssistant(config).assertExposed([entity]),
  ) {}
  async discover(config: Config['homeAssistant'], automationId: string) {
    if (!config.url || !config.token) return;
    try {
      const automation = await jsonRequest(
        config.url.replace(/\/$/, '') +
          '/api/config/automation/config/' +
          encodeURIComponent(automationId),
        {
          headers: { Authorization: `Bearer ${config.token}` },
          signal: AbortSignal.timeout(10000),
        },
        'Home Assistant morning discovery',
      );
      const triggers = automation.triggers || automation.trigger;
      const actions = automation.actions || automation.action;
      const trigger = Array.isArray(triggers) && triggers.length === 1 ? triggers[0] : undefined;
      if (
        !Array.isArray(actions) ||
        !actions.some((a) => (a.action || a.service) === 'shell_command.assistant_morning_briefing')
      )
        return;
      if (
        (trigger?.trigger || trigger?.platform) !== 'state' ||
        typeof trigger.entity_id !== 'string' ||
        !/^(sensor|binary_sensor|input_boolean)\.[a-z0-9_]+$/.test(trigger.entity_id) ||
        typeof trigger.to !== 'string'
      )
        return;
      return { entity: trigger.entity_id, state: trigger.to };
    } catch {
      console.error(JSON.stringify({ event: 'morning_profile_migration_pending' }));
    }
  }
  watch(
    key: string,
    config: Config['homeAssistant'],
    trigger: ProfileNotifications['morning'],
    wake: () => Promise<void>,
  ) {
    const signature = createHash('sha256')
      .update(JSON.stringify([config.url, config.token, trigger.entity, trigger.state]))
      .digest('hex');
    const existing = this.watches.get(key);
    if (existing?.signature === signature) {
      existing.wake = wake;
      return;
    }
    existing?.close();
    const url = new URL(config.url.replace(/\/$/, '') + '/api/websocket');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.socket(url);
    const watch = {
      signature,
      socket,
      wake,
      close: () => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        clearTimeout(pongTimeout);
        socket.onclose = socket.onerror = socket.onmessage = null;
        socket.close();
        if (this.watches.get(key) === watch) this.watches.delete(key);
      },
    };
    const fail = () => {
      console.error(JSON.stringify({ event: 'morning_trigger_disconnected', session: key }));
      watch.close();
    };
    let pongTimeout: NodeJS.Timeout | undefined;
    const heartbeat = setInterval(() => {
      if (!subscribed) return;
      socket.send(JSON.stringify({ id: 3, type: 'ping' }));
      pongTimeout = setTimeout(fail, 15000);
    }, 30000);
    const timeout = setTimeout(fail, 15000);
    this.watches.set(key, watch);
    socket.onclose = socket.onerror = fail;
    let subscribed = false;
    let fallback = false;
    let observed: string | undefined;
    const changed = (before: string | undefined, after: string | undefined) => {
      if (
        !before ||
        ['unknown', 'unavailable'].includes(before) ||
        before === after ||
        after !== trigger.state
      )
        return;
      void this.authorize(config, trigger.entity)
        .then(() => watch.wake())
        .catch(() =>
          console.error(JSON.stringify({ event: 'morning_trigger_enqueue_failed', session: key })),
        );
    };
    socket.onmessage = (event) => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 2_000_000) return fail();
        const message = JSON.parse(event.data);
        if (message.type === 'auth_required')
          socket.send(JSON.stringify({ type: 'auth', access_token: config.token }));
        else if (message.type === 'auth_ok')
          socket.send(
            JSON.stringify({
              id: 1,
              type: 'subscribe_trigger',
              trigger: { platform: 'state', entity_id: trigger.entity, to: trigger.state },
            }),
          );
        else if (message.type === 'auth_invalid') fail();
        else if (message.type === 'pong' && message.id === 3) clearTimeout(pongTimeout);
        else if (message.type === 'result' && (message.id === 1 || message.id === 2)) {
          if (!message.success) {
            // Native trigger subscriptions require an HA administrator. Ordinary users
            // can still follow exactly the selected entity through the read-scoped API.
            if (message.id === 1) {
              fallback = true;
              socket.send(
                JSON.stringify({ id: 2, type: 'subscribe_entities', entity_ids: [trigger.entity] }),
              );
              return;
            }
            return fail();
          }
          subscribed = true;
          clearTimeout(timeout);
        } else if (subscribed && message.type === 'event') {
          if (fallback && message.id === 2) {
            const value = message.event;
            const added = value?.a?.[trigger.entity];
            if (added) {
              observed = added.s;
              return;
            } // Initial snapshot never wakes a user.
            if (value?.r?.includes(trigger.entity)) {
              observed = undefined;
              return;
            }
            const next = value?.c?.[trigger.entity]?.['+']?.s;
            if (typeof next !== 'string') return;
            const before = observed;
            observed = next;
            changed(before, next);
          } else if (!fallback && message.id === 1) {
            const change = message.event?.variables?.trigger;
            if (change?.entity_id === trigger.entity)
              changed(change.from_state?.state, change.to_state?.state);
          }
        }
      } catch {
        fail();
      }
    };
  }
  retain(keys: Set<string>) {
    for (const [key, watch] of this.watches) if (!keys.has(key)) watch.close();
  }
  close() {
    this.retain(new Set());
  }
}
