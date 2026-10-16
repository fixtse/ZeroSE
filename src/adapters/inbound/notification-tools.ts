import { z } from 'zod';
import { Tools } from '../../application/tool-registry.js';
import { jsonPage } from '../../application/context-budget.js';
import type { NotificationRules } from '../../application/notification-rules.js';
import type { HomeAssistantToolsPort } from '../../application/ports.js';
import { sessionAddress } from '../../domain/access.js';
import type { NotificationRule } from '../../domain/notification-rule.js';

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
) {
  const create = async (kind: NotificationRule['kind'], a: any, c: any) => {
    if (!sessionAddress(c.session))
      throw new Error('Notifications require a Telegram chat recipient');
    const next =
      kind === 'alert'
        ? null
        : kind === 'timer'
          ? new Date(Date.now() + a.duration_seconds * 1000).toISOString()
          : a.at;
    if (next && Date.parse(next) <= Date.now())
      throw new Error('Choose a future deadline with an explicit timezone offset');
    if (kind === 'alert' && a.condition.source !== 'weather')
      await ha!.sensor(a.condition.entity_id, c.signal);
    const rule = await rules.create(
      {
        session: c.session,
        kind,
        message: a.message,
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
    return { id: rule.id, status: rule.status, next_at: rule.next_at };
  };
  const message = z.string().trim().min(1).max(1000);
  tools.add(
    'reminder_create',
    'Schedule a dedicated Telegram reminder, using an ISO datetime with timezone offset. Optional repeat_seconds repeats at a fixed elapsed interval (not local calendar days). Home Assistant owns the persistent deadline and calls back only when due. Missed deadlines are not replayed after restart.',
    z.object({
      message,
      at: z.iso.datetime({ offset: true }),
      repeat_seconds: seconds.min(60).optional(),
    }),
    (a, c) => create('reminder', a, c),
  );
  tools.add(
    'timer_start',
    'Start a persistent countdown in seconds, scheduled persistently in Home Assistant, which calls back only when due.',
    z.object({ message, duration_seconds: seconds }),
    (a, c) => create('timer', a, c),
  );
  tools.add(
    'reminders_list',
    'List this chat’s reminders and timers, including completed/expired ones. Use reminder_get for full details. offset/limit; result_offset pages JSON fragments.',
    z.object({ kind: z.enum(['reminder', 'timer']).optional(), ...page }),
    async (a, c) => {
      const result = await rules.repository.list(c.session, a.kind, a.offset, a.limit);
      return jsonPage(
        {
          ...result,
          items: result.items.map(({ id, kind, message, status, next_at }) => ({
            id,
            kind,
            message,
            status,
            next_at,
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
        remaining_seconds,
        repeat_seconds,
        condition,
        cooldown_seconds,
        recurring,
        last_fired,
        scheduler_state,
        home_assistant,
      } = value;
      return jsonPage(
        {
          id,
          kind,
          message,
          status,
          next_at,
          remaining_seconds,
          repeat_seconds,
          condition,
          cooldown_seconds,
          recurring,
          last_fired,
          scheduler_state,
          home_assistant,
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
    'Notify this Telegram chat when Home Assistant’s daily forecast changes and includes rain within horizon_hours. The first successful observation establishes a baseline and does not notify. Home Assistant subscribes directly to forecast updates; only changed forecasts trigger. No arbitrary web monitoring.',
    z.object({
      message,
      horizon_hours: z.number().int().min(1).max(168).default(24),
      minimum_probability: z.number().min(0).max(100).default(30),
      recurring: z.boolean().default(true),
      cooldown_seconds: z.number().int().min(60).max(31_536_000).default(3600),
    }),
    (a, c) =>
      create(
        'alert',
        {
          ...a,
          condition: {
            source: 'weather',
            horizon_hours: a.horizon_hours,
            minimum_probability: a.minimum_probability,
          },
        },
        c,
      ),
  );
  tools.add(
    'alert_create',
    'Create a sensor-based conditional Telegram alert. Discover permitted sensors first. Home Assistant watches state changes and holds continuously; unknown/unavailable breaks the hold. Restarts reset incomplete holds. Recurring alerts rearm only after a valid nonmatching reading and cooldown. Conditions are sensor state equality or numeric thresholds; arbitrary web monitoring is unsupported.',
    z.object({
      message,
      condition: z
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
