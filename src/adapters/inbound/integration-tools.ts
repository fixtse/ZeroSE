import { z } from 'zod';
import { Tools, text } from '../../application/tool-registry.js';
import type {
  GoogleToolsPort,
  HomeAssistantToolsPort,
  MemoryPort,
} from '../../application/ports.js';
import type { Config } from '../../domain/config.js';

export function registerGoogleTools(tools: Tools, google: GoogleToolsPort) {
  if (!google.enabled) return;
  const range = z.object({
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  });
  tools.add('calendar_list', 'Get calendar events in an ISO date/time range.', range, (a, c) =>
    google.events(a.start, a.end, c.signal),
  );
  tools.add(
    'calendar_availability',
    'Check busy intervals in an ISO date/time range.',
    range,
    (a, c) => google.availability(a.start, a.end, c.signal),
  );
  tools.add('calendar_get', 'Get an event by ID.', z.object({ event_id: text }), (a, c) =>
    google.event(a.event_id, c.signal),
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
    (a, c) => google.createEvent(a, c.signal),
  );
  tools.add(
    'calendar_update',
    'Update or reschedule an event. Supply its intended current fields.',
    z.object({ event_id: text, ...event }),
    (a, c) => {
      const { event_id, ...value } = a;
      return google.updateEvent(event_id, value, c.signal);
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
    'List pending tasks, optionally including completed ones.',
    z.object({ include_completed: z.boolean().default(false) }),
    (a, c) => google.tasks(a.include_completed, c.signal),
  );
  tools.add('task_get', 'Get a task by ID.', z.object({ task_id: text }), (a, c) =>
    google.task(a.task_id, c.signal),
  );
  tools.add(
    'task_create',
    'Create a task or note when no specific appointment time is given.',
    z.object({ title: text, notes: z.string().optional(), due: z.string().optional() }),
    (a, c) => google.createTask(a, c.signal),
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
    (a, c) => {
      const { task_id, ...value } = a;
      return google.updateTask(task_id, value, c.signal);
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
    (a, c) => google.saveContext(a.memory, c.signal),
  );
  tools.add(
    'document_create',
    'Create a formatted Google document from Markdown; return document and PDF URLs.',
    z.object({ title: text, markdown: text }),
    (a, c) => google.createDocument(a.title, a.markdown, c.signal),
  );
}
export function registerHomeAssistantTools(
  tools: Tools,
  ha: HomeAssistantToolsPort,
  config: Config['homeAssistant'],
) {
  if (!config.token) return;
  tools.add(
    'sensors_list',
    'Find Home Assistant sensor and binary-sensor readings by name.',
    z.object({ search: z.string().default('') }),
    (a, c) => ha.sensors(a.search, c.signal),
  );
  tools.add(
    'sensor_get',
    'Read a sensor value, units and timestamps. Unknown/unavailable are not measurements.',
    z.object({ entity_id: text }),
    (a, c) => ha.sensor(a.entity_id, c.signal),
  );
  tools.add(
    'sensor_history',
    'Read recorded sensor history over a date range of at most seven days.',
    z.object({
      entity_id: text,
      start: z.iso.datetime({ offset: true }),
      end: z.iso.datetime({ offset: true }),
    }),
    (a, c) => ha.history(a.entity_id, a.start, a.end, c.signal),
  );
  tools.add(
    'shopping_list_get',
    'Read Home Assistant shopping items and their UIDs.',
    z.object({}),
    (_a, c) => ha.shopping(c.signal),
  );
  tools.add(
    'shopping_list_change',
    'Add, complete, uncomplete or remove a shopping item. Use a UID for existing items.',
    z.object({ operation: z.enum(['add', 'complete', 'uncomplete', 'remove']), item: text }),
    (a, c) => ha.changeShopping(a.operation, a.item, c.signal),
  );
  if (config.weatherEntity)
    tools.add(
      'weather_forecast',
      'Read the local Home Assistant weather forecast.',
      z.object({}),
      (_a, c) => ha.forecast(c.signal),
    );
}
export function registerMemoryTools(tools: Tools, memory: MemoryPort) {
  const date = z
    .string()
    .refine((value) => !value || Number.isFinite(Date.parse(value)), 'Invalid date')
    .optional();
  tools.add(
    'memories_get',
    'Search personal long-term memory by meaning, categories and date range. Do not invent missing personal facts.',
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
    'memory_save',
    'Save a self-contained personal fact, activity or idea with category and tags.',
    z.object({ text, category: text, tags: z.array(z.string()).default([]) }),
    (a, c) => memory.save(c.session, a, undefined, c.signal),
  );
}
