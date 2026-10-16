import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Codex } from '../src/adapters/outbound/codex-app-server.js';
import { Tools } from '../src/application/tool-registry.js';
import { fixture } from './helpers.js';
test('app-server multiplexes tools, preserves threads, resumes after restart and rejects failures', async () => {
  const f = await fixture();
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
    const inspect = async () =>
      JSON.parse(await codex.run('catalog', 'inspect-tools', 'instructions', context('catalog')));
    const catalog = await inspect();
    assert(catalog.args.includes('web_search="live"'));
    assert.equal(catalog.settings.config.web_search, 'live');
    assert.equal(catalog.settings.sandbox, 'read-only');
    assert.match(catalog.settings.developerInstructions, /built-in live web search/);
    assert.match(catalog.settings.developerInstructions, /weather/);
    assert.deepEqual(catalog.settings.dynamicTools, [
      { type: 'function', ...tools.definitions()[0] },
    ]);
    assert.equal((await inspect()).settings.config.web_search, 'live', 'Resume keeps live search');
    const [one, two] = await Promise.all([
      codex.run('one', 'hello', 'instructions', context('one')),
      codex.run('two', 'world', 'instructions', context('two')),
    ]);
    assert.match(one, /hello/);
    assert.match(two, /world/);
    const thread = await f.store.thread('one');
    await codex.run('one', 'again', 'instructions', context('one'));
    assert.equal(await f.store.thread('one'), thread);
    codex.close();
    codex = new Codex(f.config, f.store, tools);
    assert.equal((await inspect()).settings.config.web_search, 'live', 'Restart keeps live search');
    await codex.run('one', 'resumed', 'instructions', context('one'));
    assert.equal(await f.store.thread('one'), thread);
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
    assert.equal(await f.store.thread('timeout'), '');
  } finally {
    codex.close();
    await f.close();
  }
});
