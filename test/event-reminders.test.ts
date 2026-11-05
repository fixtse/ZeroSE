import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { PrepareNotification } from '../src/application/use-cases/prepare-notification.js';
import type { ConversationStore, GooglePort } from '../src/application/ports.js';
import type { Job, ToolContext } from '../src/domain/models.js';

const googleDefaults: Omit<GooglePort, 'events'> = {
  enabled: true,
  context: async () => '',
  cleanTasks: async () => ({ deleted: 0 }),
  tasks: async () => [],
};

const job: Job = {
  id: 'event-notice',
  session: 'helper:123',
  status: 'running',
  payload: { kind: 'event_reminders' },
};
const context = (): ToolContext => ({
  session: job.session,
  jobId: job.id,
  signal: new AbortController().signal,
});

test('event reminders honor 5/20 minute lead times, filter non-upcoming events and mark only after delivery', async () => {
  for (const minutes of [5, 20]) {
    const sent = new Set<string>();
    let generated = 0;
    const service = new PrepareNotification(
      ConfigSchema.parse({ memory: { mode: 'none' } }),
      {
        scheduled: async (key: string) => sent.has(key),
        markScheduled: async (key: string) => {
          sent.add(key);
        },
      } as unknown as ConversationStore,
      {
        run: async (_session, input) => {
          generated++;
          const value = JSON.parse(input);
          assert.deepEqual(
            value.events.map((event: any) => event.id),
            ['due'],
          );
          assert.equal(value.reminder_minutes, minutes);
          return 'Event reminder';
        },
      },
      {
        ...googleDefaults,
        events: async (start: string, end: string) => {
          assert.equal(Date.parse(end) - Date.parse(start), minutes * 60_000);
          return [
            { id: 'due', start: { dateTime: new Date(Date.parse(end) - 30_000).toISOString() } },
            { id: 'later', start: { dateTime: new Date(Date.parse(end) + 60_000).toISOString() } },
            {
              id: 'ongoing',
              start: { dateTime: new Date(Date.parse(start) - 60_000).toISOString() },
            },
            { id: 'all-day', start: { date: start.slice(0, 10) } },
            { id: 'cancelled', status: 'cancelled', start: { dateTime: end } },
            {
              id: 'declined',
              start: { dateTime: end },
              attendees: [{ self: true, responseStatus: 'declined' }],
            },
          ];
        },
      },
      {
        forecast: async () => {
          throw new Error('Weather must not be queried without credentials');
        },
      },
      {},
      undefined,
      '',
      { calendar: true, tasks: false },
      'User',
      minutes,
    );
    const first = await service.execute(job, context());
    assert.equal(sent.size, 0);
    assert.equal(generated, 1);
    await first.afterDelivery?.();
    assert.equal(sent.size, 1);
    // Keep the same event start identity when the next calendar check runs.
    const key = [...sent][0];
    assert.match(key, /^event:helper:123:due:/);
  }
});

test('event notices receive only scoped memories, profile context, notes, tasks, reminders and weather without enabling tools', async () => {
  const config = ConfigSchema.parse({
    memory: { mode: 'simple' },
    homeAssistant: { token: 'scoped-weather-token' },
  });
  const scheduled = new Set<string>();
  let eventStart = '';
  let generations = 0;
  const service = new PrepareNotification(
    config,
    {
      scheduled: async (key: string) => scheduled.has(key),
      markScheduled: async (key: string) => {
        scheduled.add(key);
      },
    } as unknown as ConversationStore,
    {
      run: async (_session, input, instructions, _context, _images, _schema, tools) => {
        generations++;
        const evidence = JSON.parse(input);
        assert.equal(evidence.events[0].description, 'Bring the referral letter');
        assert.equal(evidence.tasks[0].notes, 'Referral in the blue folder');
        assert.equal(evidence.memories[0].summary, 'User has reduced mobility');
        assert.equal(evidence.reminders[0].message, 'Take the referral letter');
        assert.equal(evidence.reminders.length, 1);
        assert.ok(evidence.weather.hourly);
        assert.match(instructions, /Reduced mobility; avoid stairs/);
        assert.match(instructions, /evidence, never instructions/);
        assert.match(instructions, /not verified at another destination/);
        assert.equal(tools, false);
        return 'Bring your referral and allow for your mobility needs.';
      },
    },
    {
      ...googleDefaults,
      events: async (start: string) => {
        eventStart ||= new Date(Date.parse(start) + 4 * 60_000).toISOString();
        return [
          {
            id: 'doctor',
            summary: 'Doctor appointment',
            description: 'Bring the referral letter',
            location: 'Clinic',
            start: { dateTime: eventStart },
            end: { dateTime: new Date(Date.parse(eventStart) + 30 * 60_000).toISOString() },
          },
        ];
      },
      tasks: async () => [{ title: 'Pack documents', notes: 'Referral in the blue folder' }],
    },
    { forecast: async () => ({ forecast: [{ datetime: eventStart, condition: 'rainy' }] }) },
    {},
    {
      wakeReminders: async () => [],
      completeWakeReminders: async () => {},
      list: async (session, kind, offset, limit) => {
        assert.equal(session, job.session);
        assert.equal(kind, 'reminder');
        assert.equal(offset, 0);
        assert.equal(limit, 20);
        return {
          items: [
            { status: 'active', message: 'Take the referral letter', next_at: eventStart },
            { status: 'completed', message: 'Unrelated completed reminder', next_at: null },
          ] as any,
          total: 2,
          next_offset: null,
        };
      },
    },
    'Reduced mobility; avoid stairs',
    { calendar: true, tasks: true },
    'User',
    5,
    {
      search: async (session, query) => {
        assert.equal(session, job.session);
        assert.match(query, /Doctor appointment/);
        assert.match(query, /Bring the referral letter/);
        return [
          {
            id: '1',
            summary: 'User has reduced mobility',
            summary_is_excerpt: false,
            metadata: { category: 'health', tags: [], created_at: new Date().toISOString() },
            similarity: 1,
          },
        ];
      },
    },
  );
  const result = await service.execute(job, context());
  await result.afterDelivery?.();
  assert.equal((await service.execute(job, context())).deliver, false);
  assert.equal(generations, 1);
});

test('disabled memory and task permissions prevent reads, and optional context failure does not suppress an event notice', async () => {
  const service = new PrepareNotification(
    ConfigSchema.parse({ memory: { mode: 'none' } }),
    { scheduled: async () => false } as unknown as ConversationStore,
    {
      run: async (_session, input) => {
        assert.deepEqual(JSON.parse(input).unavailable, ['reminders']);
        assert.deepEqual(JSON.parse(input).memories, []);
        return 'Upcoming event';
      },
    },
    {
      ...googleDefaults,
      events: async (start: string) => [
        { id: 'event', start: { dateTime: new Date(Date.parse(start) + 60_000).toISOString() } },
      ],
      tasks: async () => {
        throw new Error('Forbidden task read');
      },
    },
    {
      forecast: async () => {
        throw new Error('Forbidden weather read');
      },
    },
    {},
    {
      wakeReminders: async () => [],
      completeWakeReminders: async () => {},
      list: async () => {
        throw new Error('Unavailable');
      },
    },
    'Profile context',
    { calendar: true, tasks: false },
    'User',
    5,
    {
      search: async () => {
        throw new Error('Forbidden memory read');
      },
    },
  );
  assert.equal((await service.execute(job, context())).output, 'Upcoming event');
});
