import { resolvePersonReference } from '../../domain/location-access.js';
import { groupDistance } from '../../application/location-distance.js';
import { UserContext, contextLimit } from '../../application/user-context.js';
import { z } from 'zod';
import type { MemoryMode } from '../../domain/memory.js';
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
    'Create an explicitly requested event or accepted activity with agreed start/end and location. Check availability and existing events first; a suggestion alone is not acceptance. Timed reminders use reminder_create.',
    z
      .object(event)
      .refine((a) => Date.parse(a.end) > Date.parse(a.start), 'Event end must follow start'),
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
    'document_create',
    'Create a formatted Google Doc from HTML. Always supply HTML, never Markdown. To edit an existing Doc, supply document_id and explicit append/replace mode; replace only when requested by the user. Supports headings, text styles, lists, tables and inline images sized to fit. After success, include both the returned document URL and PDF download URL in your reply. Never replay an uncertain mutation.',
    z
      .object({
        title: text.optional(),
        html: text,
        document_id: z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,200}$/)
          .optional(),
        mode: z.enum(['replace', 'append']).optional(),
      })
      .refine((a) => !!a.document_id === !!a.mode, 'Provide document_id and mode together')
      .refine((a) => !!a.document_id || !!a.title, 'New documents require a title'),
    async (a, c) =>
      jsonPage(
        await google.createDocument(a.title || '', a.html, c.signal, {
          documentId: a.document_id,
          mode: a.mode,
        }),
      ),
  );
}
export function registerHomeAssistantTools(
  tools: Tools,
  ha: HomeAssistantToolsPort,
  config: Config['homeAssistant'],
  group?: {
    list(search: string, offset: number, limit: number): Promise<unknown>;
    location(userId: string, signal: AbortSignal): Promise<unknown>;
  },
  setPerson?: (entity: string, confirmed?: boolean) => Promise<unknown>,
) {
  if (!config.token) return;
  if (setPerson && !group)
    tools.add(
      'location_set_person',
      'Save the own person or device_tracker GPS entity explicitly declared by the user in this private chat (for example "my entity is person.sergio"). Use only when the user explicitly wants to set or change their own entity. If their profile already has a location, use it automatically for "me"; do not ask them to declare or confirm it. If not yet exposed to Assist, this returns confirmationRequired without saving. Explain that exposing makes it available to Assist across the HA instance, and call again with confirm_exposure=true only after the user agrees. Never automatically retry an uncertain result. Never use this to assign another person or infer an identity from an alert target.',
      z.object({
        entity_id: z.string().regex(/^(person|device_tracker)\.[a-z0-9_]+$/),
        confirm_exposure: z.boolean().default(false),
      }),
      async (a) => {
        const result = await setPerson(a.entity_id, a.confirm_exposure);
        if (!(result && typeof result === 'object' && 'confirmationRequired' in result))
          config.locationEntity = a.entity_id;
        return result;
      },
    );
  if (group)
    tools.add(
      'group_members_list',
      'Find this group’s known members and whether location is assigned. Search by name or Telegram ID before requesting another member’s location.' +
        pagingHelp,
      z.object({ search: z.string().max(200).default(''), ...pagination }),
      async (a) => jsonPage(await group.list(a.search, a.offset, a.limit), a.result_offset),
    );
  if (group || setPerson || config.locationEntity || config.geocodedLocationEntity)
    tools.add(
      'location_get',
      'Read the user’s profile-configured location automatically; never ask for their entity when configured. Read home/away presence, known zone, GPS coordinates/accuracy and geocoded address from Home Assistant, with source timestamps. In a group, pass member_name for a named person (for example Ken), or user_id from group_members_list. Omit both only for the message sender. A missing known zone does not imply missing location: use returned coordinates/address. Use those same coordinates for nearby places_search and preserve Google Maps links. Qualify old coordinates with their age.' +
        pagingHelp,
      z.object({
        ...resultOffset,
        ...(group
          ? {
              member_name: z.string().trim().min(1).max(100).optional(),
              user_id: z
                .string()
                .regex(/^[1-9]\d{0,15}$/)
                .optional(),
            }
          : {}),
      }),
      async (a, c) => {
        if (a.member_name && a.user_id) throw new Error('Choose member_name or user_id, not both');
        let userId = a.user_id || c.telegramUserId;
        if (group && a.member_name) {
          const page = (await group.list(a.member_name, 0, 20)) as {
            items?: { userId: string; name: string; username?: string; present?: boolean }[];
            total?: number;
          };
          if ((page.total || 0) > (page.items?.length || 0))
            throw new Error(
              'Several group members match. Page group_members_list and choose a user_id.',
            );
          const candidates = (page.items || []).filter((member) => member.present !== false);
          const normalize = (name: string) => name.trim().replace(/^@/, '').toLowerCase();
          const name = normalize(a.member_name);
          const exact = candidates.filter((member) =>
            [member.name, member.username || '', member.userId].some(
              (value) => normalize(value) === name,
            ),
          );
          const matches = exact.length ? exact : candidates;
          if (matches.length !== 1)
            throw new Error(
              matches.length
                ? 'Several group members match this name. Use group_members_list and choose a user_id.'
                : 'No active member matches this name. Check group_members_list and Integrantes.',
            );
          userId = matches[0].userId;
        }
        if (group && !userId)
          throw new Error(
            'Choose a member from group_members_list; the sender is not identifiable.',
          );
        const observation = await (group
          ? group.location(userId!, c.signal)
          : ha.location(c.signal));
        return jsonPage(
          group && observation && typeof observation === 'object'
            ? { ...observation, subject_user_id: userId }
            : observation && typeof observation === 'object'
              ? { ...observation, subject_entity_id: config.locationEntity || null }
              : observation,
          a.result_offset,
        );
      },
    );
  if (ha.locationEntities && ha.locationEntity) {
    tools.add(
      'ha_location_entities',
      'Discover permitted person, device_tracker and zone IDs for distance queries and location alerts. Search and paginate; group membership does not grant monitoring permission.',
      z.object({ search: z.string().max(200).default(''), ...pagination }),
      async (a, c) =>
        jsonPage(
          await ha.locationEntities!(a.search, a.offset, a.limit, c.signal),
          a.result_offset,
        ),
    );
    tools.add(
      'ha_location_entity',
      'Read one permitted person, device_tracker or zone: coordinates, GPS accuracy, radius and timestamps.',
      z.object({
        entity_id: z.string().regex(/^(person|device_tracker|zone)\.[a-z0-9_]+$/),
        ...resultOffset,
      }),
      async (a, c) => jsonPage(await ha.locationEntity!(a.entity_id, c.signal), a.result_offset),
    );
  }
  if (ha.distance) {
    const personReference =
      setPerson && !group
        ? z.union([z.string().regex(/^(person|device_tracker)\.[a-z0-9_]+$/), z.literal('self')])
        : z.string().regex(/^(person|device_tracker)\.[a-z0-9_]+$/);
    const personPair = z
      .object({
        person_a: personReference,
        person_b: personReference,
        ...resultOffset,
      })
      .strict()
      .refine((a) => a.person_a !== a.person_b, 'Choose two different people');
    const memberPair = z
      .object({
        user_a: z.string().regex(/^[1-9]\d{0,15}$/),
        user_b: z.string().regex(/^[1-9]\d{0,15}$/),
        ...resultOffset,
      })
      .strict()
      .refine((a) => a.user_a !== a.user_b, 'Choose two different members');
    tools.add(
      'ha_distance',
      'Read approximate straight-line distance in metres from latest reported coordinates. In groups, discover members with group_members_list and pass user_a/user_b to use their assigned locations. In private chats use "self" for the user, automatically resolving their saved profile location without asking for their entity. Otherwise discover permitted person or device_tracker IDs with ha_location_entities and pass person_a/person_b. Clarify ambiguous names. Old coordinates still yield distance with current=false; identify stale/uncertain people and warn using source age/accuracy. No usable coordinates means no distance. No alerts or monitoring are created.',
      group ? z.union([memberPair, personPair]) : personPair,
      async (a, c) =>
        jsonPage(
          'user_a' in a && group
            ? await groupDistance(group, a.user_a, a.user_b, c.signal)
            : await ha.distance!(
                resolvePersonReference(a.person_a, config.locationEntity),
                resolvePersonReference(a.person_b, config.locationEntity),
                c.signal,
              ),
          a.result_offset,
        ),
    );
  }
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
  tools.add(
    'weather_forecast',
    'Read the Home Assistant forecast for its configured home location, which may differ from the current user location or destination. Daily by default; hourly returns up to 24 hours and source units. If no entity is configured, discover the sole daily source; ambiguity is an error. Use web search for other destinations or dates.' +
      pagingHelp,
    z.object({ type: z.enum(['daily', 'hourly']).default('daily'), ...resultOffset }),
    async (a, c) => {
      const value = (await ha.forecast(c.signal, a.type)) as any;
      return jsonPage(value?.service_response ?? value, a.result_offset);
    },
  );
}
export function registerMemoryTools(
  tools: Tools,
  memory: MemoryPort,
  mode: MemoryMode = 'advanced',
) {
  if (mode === 'none') return;
  tools.add(
    'memory_catalog',
    'Discover existing memory categories or tags in the current profile only when needed. Filter by search; lists use offset/limit and large JSON fragments use result_offset=next_offset.',
    z.object({
      kind: z.enum(['categories', 'tags']).default('categories'),
      search: z.string().max(200).default(''),
      ...pagination,
    }),
    async (a, c) => {
      const catalog = await memory.catalog(c.session);
      const items = [...new Set(a.kind === 'tags' ? catalog.tags : catalog.categories)]
        .filter((value) => value.toLocaleLowerCase().includes(a.search.toLocaleLowerCase()))
        .sort();
      return jsonPage(listPage(items, a.offset, a.limit), a.result_offset);
    },
  );
  const date = z
    .string()
    .refine((value) => !value || Number.isFinite(Date.parse(value)), 'Invalid date')
    .optional();
  tools.add(
    'memories_get',
    (mode === 'simple'
      ? 'Search long-term memory by keywords'
      : 'Search long-term memory by meaning and keywords') +
      ', optional categories and save-date range (not the date of the activity described). Omit categories when no clear match exists; omit dates unless filtering by save date, then supply both start_date and end_date. If relevant personal context is missing, ask for clarification instead of guessing. Returns at most three short results within 900 tokens. Use memory_read with an ID for full details, especially for excerpts. Preserve attribution; do not invent missing memories.',
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
    'Save one durable fact or attributed recommendation. Optional expiresAt is an ISO timestamp only when the user explicitly requests expiration; omit for permanent memory. Optional entities and subject/predicate/object relations must be explicit in the saved fact; preserve attribution and never invent relationships. Include a summary of at most 480 characters preserving attribution, negations, dates and qualifications. Assistant suggestions are not user decisions or completed actions. When the user explicitly corrects an old fact, search first and supply its IDs in supersedes. Never supersede advice merely because it was not accepted.',
    z.object({
      text,
      summary: z.string().min(1).max(480).optional(),
      expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
      entities: z.array(z.string().trim().min(2).max(120)).max(48).optional(),
      relations: z
        .array(
          z.object({
            subject: z.string().trim().min(2).max(120),
            predicate: z.string().trim().min(1).max(120),
            object: z.string().trim().min(2).max(120),
          }),
        )
        .max(16)
        .optional(),
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

export function registerContextTools(
  tools: Tools,
  context: UserContext,
  revision: number,
  enabled: boolean,
) {
  if (!enabled) return;
  tools.add(
    'context_get',
    'Read current user or group context and revision, including after an edit conflict. Large results use result_offset=next_offset.',
    z.object(resultOffset),
    async (a, c) => jsonPage(await context.read(c.session), a.result_offset),
  );
  tools.add(
    'context_save',
    'Edit this user or group context. Append by default; replace to correct or remove existing facts (empty text clears it). Use the current context revision; after success use the returned revision. Never replay a write to retrieve output.',
    z.object({
      memory: z.string().max(contextLimit),
      mode: z.enum(['append', 'replace']).default('append'),
      revision: z.number().int().min(0).default(revision),
    }),
    (a, c) => context.save(c.session, a.memory, a.mode, a.revision),
  );
}
