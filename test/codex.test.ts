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

test('per-chat tool catalogs, working directories and web permissions change on resume and checks run again at invocation', async () => {
  const f = await fixture();
  f.config.codex.command = process.execPath;
  f.config.codex.args = [resolve('test/fake-app-server.mjs')];
  let permitted = true,
    executed = 0,
    expanded = false;
  const fallback = new Tools(f.store);
  fallback.add('owner_only', 'Never expose owner tool', z.object({}), async () => {
    throw new Error('Owner tools must not run');
  });
  let resolutions = 0;
  const codex = new Codex(f.config, f.store, fallback, async (context) => {
    resolutions++;
    context.capabilities =
      context.session === 'salem:1' ? ['transcription'] : ['web', 'transcription'];
    const scoped = new Tools(f.store, async () => permitted);
    scoped.add('echo', 'Public echo', z.object({ value: z.string() }), async (value) => {
      executed++;
      return value;
    });
    if (expanded)
      scoped.add('calendar_list', 'Calendar enabled manually', z.object({}), async () => []);
    return scoped;
  });
  const context = (session: string) => ({
    session,
    jobId: 'policy',
    signal: AbortSignal.timeout(5000),
  });
  try {
    const one = JSON.parse(
      await codex.run('salem:1', 'inspect-tools', 'Salem', context('salem:1')),
    ).settings;
    const two = JSON.parse(
      await codex.run('salem:2', 'inspect-tools', 'Salem', context('salem:2')),
    ).settings;
    assert.equal(one.config.web_search, 'disabled');
    assert.equal(two.config.web_search, 'live');
    assert.notEqual(one.cwd, two.cwd);
    assert.match(one.cwd, /workspaces/);
    assert.deepEqual(
      one.dynamicTools.map((t: any) => t.name),
      ['echo'],
    );
    assert(!JSON.stringify(one).includes('owner_only'));
    assert.equal(
      JSON.parse(await codex.run('salem:1', 'allowed', 'Salem', context('salem:1'))).success,
      true,
    );
    permitted = false;
    const denied = JSON.parse(await codex.run('salem:1', 'denied', 'Salem', context('salem:1')));
    assert.equal(denied.success, false);
    assert.match(JSON.stringify(denied), /not permitted/);
    assert.equal(executed, 1);
    permitted = true;
    const oldThread = await f.store.thread('salem:1');
    await f.store.addMessage('salem:1', 'user', 'Retained conversation in this chat');
    expanded = true;
    const refreshed = JSON.parse(
      await codex.run('salem:1', 'after policy change', 'Salem', context('salem:1')),
    );
    assert.equal(refreshed.success, true);
    assert.match(JSON.stringify(refreshed), /Retained conversation in this chat/);
    assert.notEqual(await f.store.thread('salem:1'), oldThread);
    const updated = JSON.parse(
      await codex.run('salem:1', 'inspect-tools', 'Salem', context('salem:1')),
    ).settings;
    assert(updated.dynamicTools.some((tool: any) => tool.name === 'calendar_list'));

    assert(resolutions >= 6, 'Resolve a fresh policy at invocation, not only catalog creation');
  } finally {
    codex.close();
    await f.close();
  }
});

test('Codex collects generated image events per turn, deduplicates them and honors tools-disabled turns', async () => {
  const f = await fixture();
  f.config.codex.command = process.execPath;
  f.config.codex.args = [resolve('test/fake-app-server.mjs')];
  const codex = new Codex(f.config, f.store, new Tools(f.store));
  const context = (session: string): import('../src/domain/models.js').ToolContext => ({
    session,
    jobId: 'image',
    signal: AbortSignal.timeout(30_000),
  });
  try {
    const one = context('telegram:1'),
      two = context('salem:2');
    const inspect = JSON.parse(await codex.run(one.session, 'inspect-tools', '', one));
    assert.equal(inspect.settings.config['features.image_generation'], true);
    assert.equal(inspect.settings.sandbox, 'read-only');
    assert.match(inspect.settings.developerInstructions, /built-in image generation/);
    await Promise.all([
      codex.run(one.session, 'image-png', '', one),
      codex.run(two.session, 'image-jpeg', '', two),
    ]);
    assert.deepEqual(
      one.generatedImages?.map((i) => i.mimeType),
      ['image/png'],
    );
    assert.deepEqual(
      two.generatedImages?.map((i) => i.mimeType),
      ['image/jpeg'],
    );
    for (const format of ['webp', 'gif']) {
      const c = context('salem:3');
      await codex.run(c.session, `image-${format}`, '', c);
      assert.equal(c.generatedImages?.[0]?.mimeType, `image/${format}`);
    }
    const failed = context('salem:3');
    await codex.run(failed.session, 'image-failed', '', failed);
    assert.equal(failed.generatedImages, undefined);
    await assert.rejects(
      codex.run(failed.session, 'image-invalid', '', failed),
      /Invalid generated image/,
    );
    const interrupted = context('salem:4');
    await assert.rejects(
      codex.run(interrupted.session, 'image-interrupted', '', interrupted),
      /interrupted/,
    );
    assert.equal(interrupted.generatedImages, undefined);
    const disabled = context('salem:5');
    const settings = JSON.parse(
      await codex.run(disabled.session, 'inspect-tools', '', disabled, [], undefined, false),
    ).settings;
    assert.equal(settings.config['features.image_generation'], false);
    await codex.run(disabled.session, 'image-png', '', disabled, [], undefined, false);
    assert.equal(disabled.generatedImages, undefined);
    const http = context('http-test');
    await codex.run(http.session, 'image-png', '', http);
    assert.equal(http.generatedImages, undefined);
    f.config.media.maxBytes = 1;
    await assert.rejects(
      codex.run(two.session, 'image-png', '', context(two.session)),
      /size limit/,
    );
  } finally {
    codex.close();
    await f.close();
  }
});
