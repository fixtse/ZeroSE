import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Codex } from '../src/adapters/outbound/codex-app-server.js';
import { Tools } from '../src/application/tool-registry.js';
import { fixture } from './helpers.js';

test('app-server multiplexes tools, preserves threads, resumes after restart and rejects failures', async () => {
  const f = fixture();
  f.config.codex.command = process.execPath;
  f.config.codex.args = [resolve('test/fake-app-server.mjs')];
  const tools = new Tools(f.store);
  tools.add('echo', 'Echo', z.object({ value: z.string() }), async (value) => value);
  let codex = new Codex(f.config, f.store, tools);
  const context = (session: string) => ({
    session,
    jobId: 'test',
    signal: AbortSignal.timeout(5000),
  });
  try {
    const [one, two] = await Promise.all([
      codex.run('one', 'hello', 'instructions', context('one')),
      codex.run('two', 'world', 'instructions', context('two')),
    ]);
    assert.match(one, /hello/);
    assert.match(two, /world/);
    const thread = f.store.thread('one');
    await codex.run('one', 'again', 'instructions', context('one'));
    assert.equal(f.store.thread('one'), thread);
    codex.close();
    codex = new Codex(f.config, f.store, tools);
    await codex.run('one', 'resumed', 'instructions', context('one'));
    assert.equal(f.store.thread('one'), thread);
    await assert.rejects(
      () => codex.run('one', 'fail', 'instructions', context('one')),
      /turn failed/,
    );
    assert.equal(
      await codex.run(
        'readonly',
        'hello',
        'instructions',
        context('readonly'),
        [],
        undefined,
        false,
      ),
      'final result',
    );
    await assert.rejects(
      () =>
        codex.run('timeout', 'slow', 'instructions', {
          session: 'timeout',
          jobId: 'test',
          signal: AbortSignal.timeout(100),
        }),
      /timed out/,
    );
    assert.equal(f.store.thread('timeout'), '');
  } finally {
    codex.close();
    f.close();
  }
});
