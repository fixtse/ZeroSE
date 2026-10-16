import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema } from '../src/adapters/outbound/config.js';
import { Media } from '../src/adapters/outbound/media.js';
import { Telegram } from '../src/adapters/outbound/telegram.js';
import { ProcessMessage } from '../src/application/use-cases/process-message.js';
import type { AgentPort, ConversationStore, GooglePort } from '../src/application/ports.js';

function unused<T extends object>(): T {
  return new Proxy({} as T, {
    get(_target, key) {
      throw new Error(`Membership events must not access ${String(key)}`);
    },
  });
}

test('group membership replies welcome only Zero, with the exact chat ID and no agent or voice', async () => {
  const config = ConfigSchema.parse({ telegram: { token: 'test-only' } });
  const signal = new AbortController().signal;
  const methods: string[] = [];
  class TestTelegram extends Telegram {
    async call(method: string, body: unknown, requestSignal?: AbortSignal) {
      methods.push(method);
      assert.equal(method, 'getMe');
      assert.deepEqual(body, {});
      assert.equal(requestSignal, signal);
      return { id: 42, is_bot: true, first_name: 'Zero' };
    }
  }
  const telegram = new TestTelegram(config, new Media(config));
  const process = new ProcessMessage(
    config,
    unused<ConversationStore>(),
    unused<AgentPort>(),
    unused<GooglePort>(),
    telegram,
    '',
  );
  for (const type of ['group', 'supergroup']) {
    for (const joined of [true, false]) {
      const chatId = -1001234567890;
      const result = await process.execute(
        {
          id: 'membership',
          session: `telegram:${chatId}`,
          status: 'running',
          payload: {
            kind: 'telegram',
            message: {
              chat: { id: chatId, type },
              new_chat_members: [
                { id: 7, is_bot: false, first_name: 'Zero' },
                { id: joined ? 42 : 43, is_bot: true, first_name: 'Zero' },
              ],
            },
          },
        },
        { session: `telegram:${chatId}`, jobId: 'membership', signal },
      );
      assert.deepEqual(result, {
        output: joined
          ? `¡Hola! Soy Zero, vuestro asistente. Gracias por añadirme al grupo.\n\nChat ID: ${chatId}`
          : '',
        voice: false,
        deliver: joined,
      });
    }
  }
  for (const type of ['group', 'supergroup']) {
    const result = await process.execute(
      {
        id: 'created',
        session: 'telegram:-5363460418',
        status: 'running',
        payload: {
          kind: 'telegram',
          message: {
            chat: { id: -5363460418, type },
            [type === 'group' ? 'group_chat_created' : 'supergroup_chat_created']: true,
          },
        },
      },
      { session: 'telegram:-5363460418', jobId: 'created', signal },
    );
    assert.deepEqual(result, {
      output:
        '¡Hola! Soy Zero, vuestro asistente. Gracias por añadirme al grupo.\n\nChat ID: -5363460418',
      voice: false,
      deliver: true,
    });
  }
  assert.deepEqual(methods, ['getMe', 'getMe', 'getMe', 'getMe']);
  assert.deepEqual(await telegram.input({ text: 'Hola' }, 'ordinary', signal), {
    text: 'Hola',
    images: [],
    transcriptionOnly: false,
  });
  assert.equal(methods.length, 4, 'Ordinary messages must not fetch the bot identity');
});
