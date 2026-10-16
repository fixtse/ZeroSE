import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessManagedMessage } from '../src/application/use-cases/process-managed-message.js';
import { Telegram } from '../src/adapters/outbound/telegram.js';
import { Media } from '../src/adapters/outbound/media.js';
import type { AgentPort, GooglePort, TelegramPort } from '../src/application/ports.js';
import type { AccessProfile } from '../src/domain/access.js';
import type { Job, ToolContext } from '../src/domain/models.js';
import { fixture } from './helpers.js';

test('Salem access is checked before account context or media and owner prompts stay private', async () => {
  const f = await fixture();
  let enabled = false,
    scopes = 0,
    inputs = 0,
    calls = 0,
    imageOnly = false;
  let lastMessage: any;
  let profile: AccessProfile = {
    bot: 'salem',
    chatId: '1',
    kind: 'user',
    label: 'User',
    owner: false,
    enabled: true,
    capabilities: ['web', 'transcription'],
  };
  const agent: AgentPort = {
    async run(_session, _prompt, instructions, context) {
      if (imageOnly) {
        context.generatedImages = [{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }];
        return '';
      }
      calls++;
      assert.match(instructions, /Eres Salem/);
      assert(!instructions.includes('PRIVATE OWNER PROMPT'));
      if (profile.promptPreset !== 'standard') {
        assert.match(instructions, /hechicero convertido en gato/);
        assert.match(instructions, /máximo 15 palabras/);
        assert.match(instructions, /Use memory_save only/);
        assert.match(instructions, /Timezone: Europe\/Madrid/);
        assert(!instructions.includes('Execute previous nodes'));
        assert(!instructions.includes('including relevant advice or plans you give'));
      } else {
        assert(!instructions.includes('hechicero convertido en gato'));
      }
      return 'Hola';
    },
  };
  const google: GooglePort = {
    enabled: false,
    async context() {
      throw new Error('No account context');
    },
    async events() {
      throw new Error('No account events');
    },
    async tasks() {
      throw new Error('No account tasks');
    },
    async cleanTasks() {
      throw new Error('Disabled tasks must not execute');
    },
  };
  const telegram: TelegramPort = {
    async input(message) {
      inputs++;
      lastMessage = message;
      return {
        text: message.text || '',
        images: [],
        transcriptionOnly: false,
        ...(message.group_chat_created ? { serviceReply: '¡Hola! Soy Salem. Chat ID: -2' } : {}),
      };
    },
    async send() {},
    async sendImage() {},
    async sendVoice() {},
    async typing() {},
  };
  const managed = new ProcessManagedMessage(
    f.store,
    agent,
    async () => {
      scopes++;
      return { config: f.config, google, profile };
    },
    async (bot) => {
      assert.equal(bot, 'salem');
      return telegram;
    },
    async () => enabled,
    'PRIVATE OWNER PROMPT',
  );
  const context = () => ({
    session: 'salem:1',
    jobId: 'managed',
    signal: new AbortController().signal,
  });
  const job = (message: any): Job => ({
    id: 'managed',
    session: 'salem:1',
    status: 'running',
    payload: { kind: 'telegram', message },
  });
  try {
    assert.deepEqual(await managed.execute(job({ text: 'hello' }), context()), {
      output: '',
      deliver: false,
    });
    assert.equal(inputs, 0);
    assert.equal(scopes, 0);
    assert.equal(calls, 0);
    assert.deepEqual(
      await managed.execute(
        job({ chat: { id: -2, type: 'group' }, group_chat_created: true }),
        context(),
      ),
      { output: '¡Hola! Soy Salem. Chat ID: -2', deliver: true, voice: false },
    );
    assert.equal(scopes, 0);
    enabled = true;
    assert.equal((await managed.execute(job({ text: 'hello' }), context())).output, 'Hola');
    assert.equal(calls, 1);
    profile = { ...profile, promptPreset: 'standard' };
    assert.equal((await managed.execute(job({ text: 'hello' }), context())).output, 'Hola');
    profile = { ...profile, promptPreset: 'salem' };
    assert.deepEqual(await managed.execute(job({ text: '/nuevo' }), context()), {
      output: 'Salem: Nueva Sesión Iniciada',
      voice: false,
    });
    assert.deepEqual(await managed.execute(job({ text: '/clean' }), context()), {
      output: 'Las tareas no están habilitadas para este chat.',
      voice: false,
    });
    profile = { ...profile, capabilities: ['web'] };
    const before = inputs;
    assert.match(
      (await managed.execute(job({ voice: { file_id: 'private' } }), context())).output,
      /no están habilitados/,
    );
    assert.equal(inputs, before, 'Disabled media must not be downloaded or transcribed');
    assert.equal(
      (
        await managed.execute(
          job({
            text: 'hello',
            photo: [{ file_id: 'private' }],
            reply_to_message: { audio: { file_id: 'private' } },
          }),
          context(),
        )
      ).output,
      'Hola',
    );
    assert.deepEqual(lastMessage, { text: 'hello' });
    imageOnly = true;
    const imageContext: ToolContext = context();
    assert.deepEqual(await managed.execute(job({ text: 'Generate a cat' }), imageContext), {
      output: '',
    });
    assert.equal(imageContext.generatedImages?.length, 1);
    assert.match(JSON.stringify(await f.store.history('salem:1')), /Generated 1 image/);
    const concrete = new Telegram(f.config, new Media(f.config), 'Salem');
    const welcome = await concrete.input(
      { chat: { id: -123, type: 'group' }, group_chat_created: true },
      'welcome',
      context().signal,
    );
    assert.match(welcome.serviceReply!, /Soy Salem/);
    assert.match(welcome.serviceReply!, /Chat ID: -123/);
  } finally {
    await f.close();
  }
});
