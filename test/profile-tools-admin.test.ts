import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileToolsAdmin } from '../src/adapters/inbound/profile-tools-admin.js';

test('profile tools admin lists available tools and saves hidden ones', async () => {
  let disabledTools = ['calendar_list'];
  const admin = new ProfileToolsAdmin(
    {
      async profile(bot, chatId) {
        return bot === 'zero' && chatId === '42'
          ? ({ bot, chatId, disabledTools } as any)
          : undefined;
      },
      async setDisabledTools(_bot, _chatId, names) {
        disabledTools = names;
        return true;
      },
    },
    async () => [
      { name: 'web_search', description: 'Search' },
      { name: 'food_log', description: 'Log food' },
    ],
  );
  let response: [number, any] = [0, null];
  const send = (status: number, value: unknown) => (response = [status, value]);
  const req = (method: string) => ({ method }) as any;

  assert.equal(
    await admin.handle(req('GET'), '/v1/admin/profiles/zero/42/other', async () => ({}), send),
    false,
  );
  await admin.handle(req('GET'), '/v1/admin/profiles/zero/42/tools', async () => ({}), send);
  assert.deepEqual(
    response[1].tools.map((t: any) => [t.name, t.capability, t.enabled]),
    [
      ['food_log', 'homeAssistant', true],
      ['web_search', 'web', true],
    ],
  );
  await admin.handle(
    req('PUT'),
    '/v1/admin/profiles/zero/42/tools',
    async () => ({ disabled: ['food_log'] }),
    send,
  );
  assert.equal(response[0], 200);
  // Hidden tools that are not currently available are kept.
  assert.deepEqual(disabledTools.sort(), ['calendar_list', 'food_log']);
  await admin.handle(
    req('PUT'),
    '/v1/admin/profiles/zero/42/tools',
    async () => ({ disabled: ['nope'] }),
    send,
  );
  assert.equal(response[0], 400);
  await admin.handle(req('GET'), '/v1/admin/profiles/zero/7/tools', async () => ({}), send);
  assert.equal(response[0], 404);
});
