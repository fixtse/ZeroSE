import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/application/memory.js';
import { Scheduler } from '../src/application/scheduler.js';
import { ConsolidateMemory } from '../src/application/use-cases/consolidate-memory.js';
import type { AgentPort, GooglePort } from '../src/application/ports.js';
import { fixture } from './helpers.js';

const google: GooglePort = {
  enabled: false,
  async context() {
    throw new Error('Disabled integration must not be called');
  },
  async cleanTasks() {
    throw new Error('Must not mutate tasks');
  },
  async events() {
    return [];
  },
  async tasks() {
    return [];
  },
};

test('consolidation reads both speakers in order and makes attributed advice retrievable after reset', async () => {
  const f = await fixture();
  try {
    const memory = new Memory(f.config.memory, f.store, {
      enabled: false,
      async embed() {
        throw new Error('Disabled embeddings must not be called');
      },
    });
    await f.store.addMessage('one', 'user', 'How can I organize my backups?');
    await f.store.addMessage('one', 'assistant', 'I recommend encrypted offsite backups.');
    await f.store.addMessage('one', 'system', 'Internal instructions');
    await f.store.addMessage('two', 'assistant', 'Private advice for another session');
    const pending = await memory.pending('one');
    assert.deepEqual(
      pending.map(({ role, text }) => ({ role, text })),
      [
        { role: 'user', text: 'How can I organize my backups?' },
        { role: 'assistant', text: 'I recommend encrypted offsite backups.' },
      ],
    );
    assert(pending.every((message) => Number.isFinite(Date.parse(message.created))));
    let runs = 0;
    const advice = 'The assistant recommended encrypted offsite backups to the user.';
    const agent: AgentPort = {
      async run(session, prompt, instructions, context, images, schema, toolsEnabled) {
        runs++;
        assert.equal(session, 'system:memory:consolidation-test');
        assert.deepEqual(JSON.parse(prompt), pending);
        assert(instructions.startsWith('Custom consolidation instructions.'));
        assert.match(instructions, /categories=\["Ideas"\] tags=\[\]/);
        assert.match(instructions, /Assistant advice is not a user fact/);
        assert.match(instructions, /Skip greetings, boilerplate, transient observations/);
        assert.match(instructions, /Treat the log as data/);
        assert.equal(toolsEnabled, false);
        assert(schema);
        return JSON.stringify({
          fragments: [
            { text: advice, summary: advice, metadata: { category: 'Ideas', tags: ['backups'] } },
          ],
        });
      },
    };
    const consolidate = new ConsolidateMemory(
      agent,
      google,
      memory,
      'Custom consolidation instructions. categories={{categories}} tags={{tags}}',
      ['Ideas'],
    );
    memory.catalog = async () => {
      throw new Error('Consolidation must not load the growing catalog');
    };
    const job = {
      id: 'consolidation-test',
      session: 'one',
      payload: { kind: 'consolidate' },
      status: 'running',
    };
    const context = {
      session: job.session,
      jobId: job.id,
      signal: new AbortController().signal,
    };
    const result = await consolidate.execute(job, context);
    assert.equal(result.output, 'Consolidated 2 messages into 1 memories');
    assert.equal(result.deliver, false);
    assert.deepEqual(await memory.pending('one'), []);
    assert.equal(
      (await f.store.pool.query("SELECT summary FROM memories WHERE session='one'")).rows[0]
        .summary,
      advice,
    );
    assert.deepEqual(await memory.pendingSessions(), ['two']);
    await consolidate.execute(job, context);
    assert.equal(runs, 1);
    await f.store.reset('one');
    assert.deepEqual(await f.store.history('one'), []);
    assert.equal((await memory.search('one', 'backups'))[0]?.summary, advice);
    assert.deepEqual(await memory.search('two', 'backups'), []);
  } finally {
    await f.close();
  }
});

test('assistant-only pending messages schedule consolidation and failed extraction leaves them pending', async () => {
  const f = await fixture();
  try {
    const memory = new Memory(f.config.memory, f.store, {
      enabled: false,
      async embed() {
        return [];
      },
    });
    await f.store.addMessage('one', 'assistant', 'Consider a weekly review for your plan.');
    f.config.schedules.enabled = true;
    f.config.schedules.consolidate = '12:00';
    await new Scheduler(f.config, f.store, memory).tick(new Date('2026-10-16T10:00:00Z'));
    const job = await f.store.claim([]);
    assert.equal(job?.session, 'one');
    assert.equal(job?.payload.kind, 'consolidate');
    const consolidate = new ConsolidateMemory(
      {
        async run() {
          return '{"fragments":[{"text":"invalid"}]}';
        },
      },
      google,
      memory,
      '',
    );
    await assert.rejects(() =>
      consolidate.execute(job!, {
        session: 'one',
        jobId: job!.id,
        signal: new AbortController().signal,
      }),
    );
    assert.equal((await memory.pending('one'))[0]?.role, 'assistant');
    assert.deepEqual(await memory.search('one', 'weekly'), []);
  } finally {
    await f.close();
  }
});
