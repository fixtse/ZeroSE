import { resolvePersonReference } from '../../domain/location-access.js';
import { z } from 'zod';
import { Tools } from '../../application/tool-registry.js';
import { jsonPage } from '../../application/context-budget.js';
import type { NotificationRules } from '../../application/notification-rules.js';
import type { HomeAssistantToolsPort } from '../../application/ports.js';
import { sessionAddress } from '../../domain/access.js';
import { isLocationCondition, type NotificationRule } from '../../domain/notification-rule.js';

const seconds = z.number().int().min(1).max(31_536_000);
const page = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
  result_offset: z.number().int().min(0).default(0),
};
const id = z.uuid();
export function registerNotificationTools(
  tools: Tools,
  rules: NotificationRules,
  ha?: HomeAssistantToolsPort,
  ownLocation?: () => string,
) {
  const personReference = ownLocation
    ? z.union([z.string().regex(/^(person|device_tracker)\.[a-z0-9_]+$/), z.literal('self')])
    : z.string().regex(/^(person|device_tracker)\.[a-z0-9_]+$/);
  const create = async (kind: NotificationRule['kind'], a: any, c: any) => {
    if (!sessionAddress(c.session))
      throw new Error('Notifications require a Telegram chat recipient');
    const next =
      kind === 'alert'
        ? null
        : a.wake_date
          ? null
          : kind === 'timer'
            ? new Date(Date.now() + a.duration_seconds * 1000).toISOString()
            : a.at;
    if (next && Date.parse(next) <= Date.now())
      throw new Error('Choose a future deadline with an explicit timezone offset');
    if (kind === 'alert' && isLocationCondition(a.condition)) {
      a = {
        ...a,
        condition: {
          ...a.condition,
          entity_id: resolvePersonReference(a.condition.entity_id, ownLocation?.()),
          target_entity_id:
            a.condition.source === 'distance'
              ? resolvePersonReference(a.condition.target_entity_id, ownLocation?.())
              : a.condition.target_entity_id,
        },
      };
      if (
        a.condition.source === 'distance' &&
        a.condition.entity_id === a.condition.target_entity_id
      )
        throw new Error('Choose two different people');
      if (!ha?.locationEntity) throw new Error('Location alert discovery is unavailable');
      await ha.locationEntity(a.condition.entity_id, c.signal);
      await ha.locationEntity(a.condition.target_entity_id, c.signal);
    } else if (kind === 'alert' && a.condition.source !== 'weather')
      await ha!.sensor(a.condition.entity_id, c.signal);
    const rule = await rules.create(
      {
        session: c.session,
        kind,
        message: a.message,
        ...(a.wake_date ? { wake_date: a.wake_date } : {}),
        status: 'active',
        next_at: next,
        repeat_seconds: a.repeat_seconds || null,
        remaining_seconds: null,
        condition: a.condition || null,
        cooldown_seconds: a.cooldown_seconds || 0,
        recurring: a.recurring || false,
        matched_since: null,
        last_checked: null,
        last_fired: null,
        latched: false,
        forecast_signature: null,
      },
      c.signal,
    );
    return { id: rule.id, status: rule.status, next_at: rule.next_at, wake_date: rule.wake_date };
  };
  const message = z.string().trim().min(1).max(1000);
  tools.add(
    'reminder_create',
    'Schedule a persistent Telegram reminder at a clock time, using an ISO datetime with timezone offset. For wake-up briefing requests use wake_reminder_create instead. Optional repeat_seconds repeats at a fixed elapsed interval (not local calendar days). Missed deadlines are not replayed after restart.',
    z.object({
      message,
      at: z.iso.datetime({ offset: true }),
      repeat_seconds: seconds.min(60).optional(),
    }),
    (a, c) => create('reminder', a, c),
  );
  tools.add(
    'wake_reminder_create',
    'Include a reminder in this profile’s entity-triggered wake-up briefing on a local YYYY-MM-DD date. Use for “at wake up / when I wake up / al despertar”, including relative dates. Never guess a clock time. One-shot; not sent on other dates or as a separate notification.',
    z.object({ message, date: z.iso.date() }),
    async (a, c) => {
      const profile = await rules.wakeProfile?.(c.session);
      if (!profile?.enabled)
        throw new Error('Configure an entity-triggered morning briefing in this profile first');
      if (a.date < profile.date) throw new Error('Choose today or a future local date');
      return create('reminder', { message: a.message, wake_date: a.date }, c);
    },
  );
  tools.add(
    'timer_start',
    'Start a persistent countdown in seconds. The notification is queued only when due; no external connection is required.',
    z.object({ message, duration_seconds: seconds }),
    (a, c) => create('timer', a, c),
  );
  tools.add(
    'reminders_list',
    'List this chat’s reminders and timers, including finished ones retained for 48 hours. Use reminder_get for full details. offset/limit; result_offset pages JSON fragments.',
    z.object({ kind: z.enum(['reminder', 'timer']).optional(), ...page }),
    async (a, c) => {
      const result = await rules.repository.list(c.session, a.kind, a.offset, a.limit);
      return jsonPage(
        {
          ...result,
          items: result.items.map(({ id, kind, message, status, next_at, wake_date }) => ({
            id,
            kind,
            message,
            status,
            next_at,
            wake_date,
          })),
        },
        a.result_offset,
      );
    },
  );
  tools.add(
    'reminder_get',
    'Read one notification rule by ID in this chat. Use result_offset=next_offset for JSON fragments.',
    z.object({ id, result_offset: page.result_offset }),
    async (a, c) => {
      const value = await rules.inspect(c.session, a.id, c.signal);
      if (!value) throw new Error('Notification rule not found in this chat');
      const {
        id,
        kind,
        message,
        status,
        next_at,
        wake_date,
        remaining_seconds,
        repeat_seconds,
        condition,
        cooldown_seconds,
        recurring,
        last_fired,
        scheduler_state,
        home_assistant,
        scheduler,
      } = value;
      return jsonPage(
        {
          id,
          kind,
          message,
          status,
          next_at,
          wake_date,
          remaining_seconds,
          repeat_seconds,
          condition,
          cooldown_seconds,
          recurring,
          last_fired,
          scheduler_state,
          home_assistant,
          scheduler,
        },
        a.result_offset,
      );
    },
  );
  tools.add(
    'reminder_change',
    'Cancel, pause, resume or snooze a reminder/timer by ID. Snooze requires seconds. Never repeat a mutation to fetch its output.',
    z.object({
      id,
      operation: z.enum(['cancel', 'pause', 'resume', 'snooze']),
      seconds: seconds.optional(),
    }),
    async (a, c) => {
      const rule = await rules.repository.read(c.session, a.id);
      if (!rule || rule.kind === 'alert') throw new Error('Reminder/timer not found in this chat');
      return rules.change(c.session, a.id, a.operation, a.seconds, new Date(), c.signal);
    },
  );
  if (!ha) return;
  tools.add(
    'weather_alert_create',
    'Notify this Telegram chat when Home Assistant’s daily forecast changes within horizon_hours. Default any_change includes storms, snow, wind, temperature, rain and clearing. Use mode=rain for rain-only requests, or mode=conditions with explicit HA condition names (storms: lightning/lightning-rainy). minimum_probability applies only to rain mode. The first observation establishes a baseline. Event-driven; no model runs in the background.',
    z
      .object({
        message,
        mode: z.enum(['any_change', 'conditions', 'rain']).default('any_change'),
        conditions: z
          .array(
            z.enum([
              'clear-night',
              'cloudy',
              'fog',
              'hail',
              'lightning',
              'lightning-rainy',
              'partlycloudy',
              'pouring',
              'rainy',
              'snowy',
              'snowy-rainy',
              'sunny',
              'windy',
              'windy-variant',
              'exceptional',
            ]),
          )
          .max(15)
          .default([]),
        horizon_hours: z.number().int().min(1).max(168).default(24),
        minimum_probability: z.number().min(0).max(100).default(30),
        recurring: z.boolean().default(true),
        cooldown_seconds: z.number().int().min(60).max(31_536_000).default(1800),
      })
      .refine(
        (a) => (a.mode === 'conditions' ? a.conditions.length > 0 : a.conditions.length === 0),
        'Supply conditions only for conditions mode, with at least one condition',
      ),
    (a, c) =>
      create(
        'alert',
        {
          ...a,
          condition: {
            source: 'weather',
            mode: a.mode,
            conditions: a.conditions,
            horizon_hours: a.horizon_hours,
            minimum_probability: a.minimum_probability,
          },
        },
        c,
      ),
  );
  tools.add(
    'alert_create',
    'Create a conditional Telegram alert. Discover permitted sensors or ha_location_entities first. Zone enter/leave watches a person/device_tracker and zone; distance above/below watches two GPS entities (person or device_tracker) in metres (straight-line). In private chats use "self" for the user: it automatically uses the person or device_tracker GPS location saved in their profile, without asking them to name or confirm it. Location alerts start from a baseline and fire only on a later crossing. Distance alerts use last known GPS even when old (stationary trackers may not update); missing/unavailable/inaccurate GPS breaks holds. Zone alerts also require recent reports. Recurring distance alerts rearm beyond reset_margin_m. HA watches changes without AI polling. Restarts reset holds; uncertain deliveries are never replayed.',
    z.object({
      message,
      condition: z.union([
        z
          .object({
            entity_id: z.string().regex(/^(sensor|binary_sensor)\.[a-z0-9_]+$/),
            operator: z.enum(['above', 'below', 'equals']),
            value: z.union([z.string().min(1).max(200), z.number().finite()]),
            hold_seconds: z.number().int().min(0).max(86400).default(0),
          })
          .refine(
            (c) => c.operator === 'equals' || typeof c.value === 'number',
            'Numeric thresholds require a number',
          ),
        z.object({
          source: z.literal('zone'),
          entity_id: personReference,
          target_entity_id: z.string().regex(/^zone\.[a-z0-9_]+$/),
          operator: z.enum(['enter', 'leave']),
          reset_margin_m: z.number().finite().min(0).max(10000).default(0),
          hold_seconds: z.number().int().min(0).max(86400).default(0),
          max_age_seconds: z.number().int().min(60).max(86400).default(3600),
          max_accuracy_m: z.number().finite().positive().max(10000).default(200),
        }),
        z
          .object({
            source: z.literal('distance'),
            entity_id: personReference,
            target_entity_id: personReference,
            operator: z.enum(['above', 'below']),
            distance_m: z.number().finite().positive().max(40075000),
            reset_margin_m: z.number().finite().min(0).max(10000).default(100),
            hold_seconds: z.number().int().min(0).max(86400).default(0),
            max_age_seconds: z.number().int().min(60).max(86400).default(3600),
            max_accuracy_m: z.number().finite().positive().max(10000).default(200),
          })
          .refine((c) => c.entity_id !== c.target_entity_id, 'Choose two different people'),
      ]),
      recurring: z.boolean().default(false),
      cooldown_seconds: z.number().int().min(60).max(31_536_000).default(300),
    }),
    (a, c) => create('alert', a, c),
  );
  tools.add(
    'alerts_list',
    'List this chat’s conditional alerts. Use reminder_get for full details. offset/limit; result_offset pages JSON fragments.',
    z.object(page),
    async (a, c) => {
      const result = await rules.repository.list(c.session, 'alert', a.offset, a.limit);
      return jsonPage(
        {
          ...result,
          items: result.items.map(({ id, message, status, condition }) => ({
            id,
            message,
            status,
            condition,
          })),
        },
        a.result_offset,
      );
    },
  );
  tools.add(
    'alert_change',
    'Pause, resume or cancel a conditional alert by ID in this chat.',
    z.object({ id, operation: z.enum(['pause', 'resume', 'cancel']) }),
    async (a, c) => {
      const rule = await rules.repository.read(c.session, a.id);
      if (rule?.kind !== 'alert') throw new Error('Alert not found in this chat');
      return rules.change(c.session, a.id, a.operation, undefined, new Date(), c.signal);
    },
  );
}
