import { z } from 'zod';
import { jsonPage, listPage } from '../../application/context-budget.js';
import {
  eventSummary,
  taskSummary,
  sensorSummary,
  historySummary,
  pick,
} from './integration-output.js';
import { Tools, text } from '../../application/tool-registry.js';
import type {
  GoogleToolsPort,
  HomeAssistantToolsPort,
  MemoryPort,
} from '../../application/ports.js';
import type { Config } from '../../domain/config.js';

const resultOffset = { result_offset: z.number().int().min(0).default(0) };
const pagination = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
  ...resultOffset,
};
const pagingHelp =
  ' Lists: offset/limit. JSON fragments: result_offset=next_offset. Reuse other arguments; source changes can shift pages.';

export function registerGoogleTools(tools: Tools, google: GoogleToolsPort) {
  if (!google.enabled) return;
  const range = z.object({
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    ...pagination,
  });
  tools.add(
    'calendar_list',
    'Get brief calendar events in an ISO date/time range; use calendar_get for details.' +
      pagingHelp,
    range,
    async (a, c) =>
      jsonPage(
        listPage(
          (await google.events(a.start, a.end, c.signal)).map(eventSummary),
          a.offset,
          a.limit,
        ),
        a.result_offset,
      ),
  );
  tools.add(
    'calendar_availability',
    'Check busy intervals in an ISO date/time range.' + pagingHelp,
    range,
    async (a, c) =>
      jsonPage(
        pick(await google.availability(a.start, a.end, c.signal), [
          'timeMin',
          'timeMax',
          'calendars',
        ]),
        a.result_offset,
      ),
  );
  tools.add(
    'calendar_get',
    'Get an event by ID.' + pagingHelp,
    z.object({ event_id: text, ...resultOffset }),
    async (a, c) =>
      jsonPage(
        pick(await google.event(a.event_id, c.signal), [
          'id',
          'summary',
          'description',
          'start',
          'end',
          'status',
          'location',
          'attendees',
          'recurrence',
          'recurringEventId',
          'originalStartTime',
          'htmlLink',
          'conferenceData',
          'reminders',
        ]),
        a.result_offset,
      ),
  );
  const event = {
    summary: text,
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    description: z.string().optional(),
    location: z.string().optional(),
    attendees: z.array(z.email()).optional(),
  };
  tools.add(
    'calendar_create',
    'Create an event. Use a 15-minute duration for reminders.',
    z.object(event),
    async (a, c) =>
      pick(await google.createEvent(a, c.signal), ['id', 'status', 'start', 'end', 'htmlLink']),
  );
  tools.add(
    'calendar_update',
    'Update or reschedule an event. Supply its intended current fields.',
    z.object({ event_id: text, ...event }),
    async (a, c) => {
      const { event_id, ...value } = a;
      return pick(await google.updateEvent(event_id, value, c.signal), [
        'id',
        'status',
        'start',
        'end',
        'htmlLink',
      ]);
    },
  );
  tools.add(
    'calendar_delete',
    'Delete the event explicitly requested by the user.',
    z.object({ event_id: text }),
    (a, c) => google.deleteEvent(a.event_id, c.signal),
  );
  tools.add(
    'tasks_list',
    'List brief pending tasks, optionally including completed ones. Use task_get for notes.' +
      pagingHelp,
    z.object({ include_completed: z.boolean().default(false), ...pagination }),
    async (a, c) =>
      jsonPage(
        listPage(
          (await google.tasks(a.include_completed, c.signal)).map(taskSummary),
          a.offset,
          a.limit,
        ),
        a.result_offset,
      ),
  );
  tools.add(
    'task_get',
    'Get a task by ID.' + pagingHelp,
    z.object({ task_id: text, ...resultOffset }),
    async (a, c) =>
      jsonPage(
        pick(await google.task(a.task_id, c.signal), [
          'id',
          'title',
          'notes',
          'status',
          'due',
          'completed',
          'parent',
          'links',
          'webViewLink',
        ]),
        a.result_offset,
      ),
  );
  tools.add(
    'task_create',
    'Create a task or note when no specific appointment time is given.',
    z.object({ title: text, notes: z.string().optional(), due: z.string().optional() }),
    async (a, c) =>
      pick(await google.createTask(a, c.signal), ['id', 'status', 'due', 'webViewLink']),
  );
  tools.add(
    'task_update',
    'Update a task or mark it completed.',
    z.object({
      task_id: text,
      title: z.string().optional(),
      notes: z.string().optional(),
      due: z.string().optional(),
      status: z.enum(['needsAction', 'completed']).optional(),
    }),
    async (a, c) => {
      const { task_id, ...value } = a;
      return pick(await google.updateTask(task_id, value, c.signal), [
        'id',
        'status',
        'due',
        'webViewLink',
      ]);
    },
  );
  tools.add(
    'task_delete',
    'Delete the task explicitly requested by the user.',
    z.object({ task_id: text }),
    (a, c) => google.deleteTask(a.task_id, c.signal),
  );
  tools.add(
    'context_save',
    'Append important personal context to the user context document.',
    z.object({ memory: text }),
    async (a, c) => {
      await google.saveContext(a.memory, c.signal);
      return { saved: true };
    },
  );
  tools.add(
    'document_create',
    'Create a formatted Google document from Markdown; return document and PDF URLs.',
    z.object({ title: text, markdown: text }),
    async (a, c) => jsonPage(await google.createDocument(a.title, a.markdown, c.signal)),
  );
}
export function registerHomeAssistantTools(
  tools: Tools,
  ha: HomeAssistantToolsPort,
  config: Config['homeAssistant'],
) {
  if (!config.token) return;
  if (config.locationEntity || config.geocodedLocationEntity)
    tools.add(
      'location_get',
      'Read the user’s home/away presence, known zone, GPS coordinates/accuracy and geocoded address from Home Assistant, with source timestamps. Use when location improves an answer or suggestion.' +
        pagingHelp,
      z.object(resultOffset),
      async (a, c) => jsonPage(await ha.location(c.signal), a.result_offset),
    );
  tools.add(
    'sensors_list',
    'Find brief Home Assistant sensor and binary-sensor readings by name; use sensor_get for attributes.' +
      pagingHelp,
    z.object({ search: z.string().default(''), ...pagination }),
    async (a, c) =>
      jsonPage(
        listPage(
          ((await ha.sensors(a.search, c.signal)) as any[]).map(sensorSummary),
          a.offset,
          a.limit,
        ),
        a.result_offset,
      ),
  );
  tools.add(
    'sensor_get',
    'Read a sensor value, attributes, units and timestamps. Unknown/unavailable are not measurements.' +
      pagingHelp,
    z.object({ entity_id: text, ...resultOffset }),
    async (a, c) =>
      jsonPage(
        pick(await ha.sensor(a.entity_id, c.signal), [
          'entity_id',
          'state',
          'attributes',
          'last_changed',
          'last_updated',
          'last_reported',
        ]),
        a.result_offset,
      ),
  );
  tools.add(
    'sensor_history',
    'Summarize recorded sensor history over at most seven days. Use mode=raw for paginated original readings.' +
      pagingHelp,
    z.object({
      entity_id: text,
      mode: z.enum(['summary', 'raw']).default('summary'),
      ...pagination,
      start: z.iso.datetime({ offset: true }),
      end: z.iso.datetime({ offset: true }),
    }),
    async (a, c) => {
      const value = await ha.history(a.entity_id, a.start, a.end, c.signal);
      const samples = Array.isArray(value) ? value.flat() : [];
      return jsonPage(
        a.mode === 'raw'
          ? listPage(
              samples.map((sample) =>
                pick(sample, ['entity_id', 'state', 'last_changed', 'last_updated']),
              ),
              a.offset,
              a.limit,
            )
          : historySummary(value, a.entity_id, a.start, a.end),
        a.result_offset,
      );
    },
  );
  tools.add(
    'shopping_list_get',
    'Read Home Assistant shopping items and their UIDs.' + pagingHelp,
    z.object(pagination),
    async (a, c) =>
      jsonPage(
        listPage((await ha.shopping(c.signal)) as any[], a.offset, a.limit),
        a.result_offset,
      ),
  );
  tools.add(
    'shopping_list_change',
    'Add, complete, uncomplete or remove a shopping item. Use a UID for existing items.',
    z.object({ operation: z.enum(['add', 'complete', 'uncomplete', 'remove']), item: text }),
    async (a, c) => {
      await ha.changeShopping(a.operation, a.item, c.signal);
      return { verified: true, operation: a.operation };
    },
  );
  if (config.weatherEntity)
    tools.add(
      'weather_forecast',
      'Read the local Home Assistant weather forecast.' + pagingHelp,
      z.object(resultOffset),
      async (a, c) => {
        const value = (await ha.forecast(c.signal)) as any;
        return jsonPage(value?.service_response ?? value, a.result_offset);
      },
    );
}
export function registerMemoryTools(tools: Tools, memory: MemoryPort) {
  const date = z
    .string()
    .refine((value) => !value || Number.isFinite(Date.parse(value)), 'Invalid date')
    .optional();
  tools.add(
    'memories_get',
    'Search long-term memory by meaning, keywords, categories and save-date range. Returns at most three short results within 900 tokens. Use memory_read with an ID for full details, especially for excerpts. Preserve attribution; do not invent missing memories.',
    z.object({
      search_query: text,
      categories: z.array(z.string()).default([]),
      start_date: date,
      end_date: date,
    }),
    (a, c) =>
      memory.search(c.session, a.search_query, a.categories, a.start_date, a.end_date, c.signal),
  );
  tools.add(
    'memory_read',
    'Read full memory text by ID within the current profile. Large records return JSON fragments; continue with result_offset=next_offset.',
    z.object({ memory_id: z.string().regex(/^[1-9]\d{0,18}$/), ...resultOffset }),
    (a, c) => memory.read(c.session, a.memory_id, a.result_offset),
  );
  tools.add(
    'memory_save',
    'Save one durable fact or attributed recommendation. Include a summary of at most 480 characters preserving attribution, negations, dates and qualifications. Assistant suggestions are not user decisions or completed actions. When the user explicitly corrects an old fact, search first and supply its IDs in supersedes. Never supersede advice merely because it was not accepted.',
    z.object({
      text,
      summary: z.string().min(1).max(480).optional(),
      supersedes: z
        .array(z.string().regex(/^[1-9]\d{0,18}$/))
        .max(20)
        .optional(),
      category: text,
      tags: z.array(z.string()).default([]),
    }),
    (a, c) => memory.save(c.session, a, undefined, c.signal),
  );
}
