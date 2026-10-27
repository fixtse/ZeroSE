import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/domain/config.js';
import type { Media } from '../src/adapters/outbound/media.js';
import type { AccessRepository } from '../src/application/access.js';
import { Telegram } from '../src/adapters/outbound/telegram.js';
import { Admin } from '../src/adapters/inbound/admin.js';

for (const chatId of ['42', '-42', '-1001234567890']) {
  test(`Telegram avatar uses the correct photo API for ${chatId}`, async () => {
    const calls: Array<[string, unknown]> = [];
    const config = { telegram: { token: 'test-token' } } as Config;
    const media = {
      download: async (url: string) => {
        assert.equal(url, 'https://api.telegram.org/file/bottest-token/photos/avatar.jpg');
        return Buffer.from('photo');
      },
    } as unknown as Media;
    const telegram = new Telegram(config, media);
    telegram.call = async (method, body) => {
      calls.push([method, body]);
      if (method === 'getFile') return { file_path: 'photos/avatar.jpg' };
      return Number(chatId) < 0
        ? { photo: { small_file_id: 'group-photo' } }
        : { photos: [[{ file_id: 'user-photo' }]] };
    };
    assert.equal(await telegram.profilePhoto(chatId), 'data:image/jpeg;base64,cGhvdG8=');
    assert.deepEqual(
      calls,
      Number(chatId) < 0
        ? [
            ['getChat', { chat_id: chatId }],
            ['getFile', { file_id: 'group-photo' }],
          ]
        : [
            ['getUserProfilePhotos', { user_id: 42, limit: 1 }],
            ['getFile', { file_id: 'user-photo' }],
          ],
    );
  });
}
test('a group without a Telegram photo keeps the initial fallback without downloading', async () => {
  const telegram = new Telegram(
    {} as Config,
    {
      download: async () => {
        throw new Error('Unexpected download');
      },
    } as unknown as Media,
  );
  telegram.call = async () => ({});
  assert.equal(await telegram.profilePhoto('-42'), undefined);
});
test('admin photo endpoint serves registered groups through their assistant connection', async () => {
  const repository = { profile: async () => ({ kind: 'group' }) } as unknown as AccessRepository;
  const admin = new Admin(
    {} as Config,
    repository,
    async () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (bot, chatId) => {
      assert.equal(bot, '12345678-1234-1234-1234-123456789abc');
      assert.equal(chatId, '-1001234567890');
      return 'data:image/jpeg;base64,cGhvdG8=';
    },
  );
  let response: unknown;
  assert.equal(
    await admin.handle(
      { method: 'GET' } as any,
      '/v1/admin/profiles/12345678-1234-1234-1234-123456789abc/-1001234567890/photo',
      async () => ({}),
      (status, value) => {
        assert.equal(status, 200);
        response = value;
      },
    ),
    true,
  );
  assert.deepEqual(response, { image: 'data:image/jpeg;base64,cGhvdG8=' });
});
