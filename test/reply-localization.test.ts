import assert from 'node:assert/strict';
import test from 'node:test';
import { Admin } from '../src/adapters/inbound/admin.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { scopedConfig } from '../src/application/access.js';
import { ProcessMessage } from '../src/application/use-cases/process-message.js';
import { PrepareNotification } from '../src/application/use-cases/prepare-notification.js';
import { WeatherNotification, weatherFacts } from '../src/application/weather-notification.js';
import type { AccessProfile } from '../src/domain/access.js';
import type { GooglePort, TelegramPort } from '../src/application/ports.js';
import type { WeatherChange } from '../src/domain/weather-change.js';
import { fixture } from './helpers.js';

const profile: AccessProfile = {
  bot: 'zero',
  chatId: '123',
  label: 'Alice',
  kind: 'user',
  enabled: true,
  owner: false,
  capabilities: [],
};
const google = {
  enabled: false,
  events: async () => [],
  tasks: async () => [],
  cleanTasks: async () => ({ deleted: 0 }),
  context: async () => '',
} as GooglePort;

const context = () => ({
  session: 'telegram:123',
  jobId: 'locale',
  signal: AbortSignal.timeout(10000),
});

test('reply language persists through admin edits and group migration, with a Spanish legacy default', async () => {
  const f = await fixture();
  try {
    const repository = new PostgresAccess(f.store.db, f.config.apiKey);
    await repository.initialize(f.config);
    await repository.saveProfile(profile);
    assert.equal(
      scopedConfig(f.config, (await repository.profile('zero', '123'))!).replyLanguage,
      'es',
    );
    const admin = new Admin(f.config, repository, async () => {});
    const request = async (method: string, body?: unknown) => {
      let status = 0;
      let value: any;
      await admin.handle(
        { method } as any,
        '/v1/admin/profiles/zero/123',
        async () => body,
        (s, v) => {
          status = s;
          value = v;
        },
      );
      return { status, value };
    };
    assert.equal((await request('PUT', { ...profile, replyLanguage: 'en' })).status, 200);
    assert.equal((await request('GET')).value.replyLanguage, 'en');
    assert.equal((await request('PUT', { ...profile, label: 'Renamed' })).status, 200);
    const saved = (await repository.profile('zero', '123'))!;
    assert.equal(saved.replyLanguage, 'en');
    assert.equal(scopedConfig(f.config, saved).replyLanguage, 'en');
    await assert.rejects(() => request('PUT', { ...profile, replyLanguage: 'fr' }));
    assert.equal((await repository.profile('zero', '123'))!.replyLanguage, 'en');
    await repository.saveProfile({ ...saved, kind: 'group', chatId: '-123' });
    await repository.migrateGroup('zero', '-123', '-456');
    assert.equal((await repository.profile('zero', '-456'))?.replyLanguage, 'en');
  } finally {
    await f.close();
  }
});

test('profile language overrides a saved Spanish personality without rewriting prompts or conversation content', async () => {
  const f = await fixture();
  try {
    const config = scopedConfig(f.config, { ...profile, replyLanguage: 'en' });
    const personality = 'Responde siempre en español. Keep this personality.';
    const process = new ProcessMessage(
      config,
      f.store,
      {
        async run(_session, prompt, instructions) {
          assert.match(instructions, /Keep this personality/);
          assert.match(instructions, /Reply language for this profile: English/);
          assert.match(prompt, /Hola, ¿qué hora es\?/);
          return 'It is noon.';
        },
      },
      google,
      {} as TelegramPort,
      personality,
    );
    const result = await process.execute(
      {
        id: 'locale',
        session: 'telegram:123',
        status: 'running',
        payload: { kind: 'chat', text: 'Hola, ¿qué hora es?' },
      },
      context(),
    );
    assert.equal(result.output, 'It is noon.');
    const history = await f.store.history('telegram:123');
    assert.match(JSON.stringify(history), /Hola, ¿qué hora es\?/);
    assert.match(JSON.stringify(history), /It is noon\./);
    const reset = await process.execute(
      {
        id: 'reset',
        session: 'telegram:123',
        status: 'running',
        payload: { kind: 'chat', text: '/nuevo' },
      },
      context(),
    );
    assert.equal(reset.output, 'Zero: New Session Started');
  } finally {
    await f.close();
  }
});

test('briefings apply the profile language to generated text while retaining user reminder wording', async () => {
  const f = await fixture();
  try {
    const config = scopedConfig(f.config, { ...profile, replyLanguage: 'en' });
    const service = new PrepareNotification(
      config,
      f.store,
      {
        async run(_session, _prompt, instructions, _context, _images, _schema, tools) {
          assert.match(instructions, /write the entire notification in English/);
          assert.equal(tools, false);
          return 'Good morning.';
        },
      },
      google,
      {} as any,
      { morning: 'Resume en español.' },
      {
        wakeReminders: async () => [{ message: 'Tomar la medicina' }] as any,
        completeWakeReminders: async () => {},
      },
    );
    const result = await service.execute(
      {
        id: 'locale',
        session: 'telegram:123',
        status: 'running',
        payload: { kind: 'morning', wakeUp: true },
      },
      context(),
    );
    assert.match(result.output, /Wake-up reminders:/);
    assert.match(result.output, /Tomar la medicina/);
  } finally {
    await f.close();
  }
});

test('weather generation and evidence fallback both use the selected reply language', async () => {
  const evidence: WeatherChange = {
    entity_id: 'weather.home',
    units: { temperature: '°C' },
    truncated: false,
    changes: [
      {
        datetime: '2026-11-05T00:00:00Z',
        before: { condition: 'sunny', temperature: 24 },
        after: { condition: 'rainy', temperature: 19 },
      },
    ],
  };
  const service = new WeatherNotification(
    {
      async run(_session, _prompt, instructions) {
        assert.match(instructions, /Reply language for this profile: English/);
        throw new Error('model unavailable');
      },
    },
    undefined,
    'en',
  );
  const output = await service.explain(
    evidence,
    new Date().toISOString(),
    'Europe/Madrid',
    context(),
  );
  assert.match(output, /Forecast change/);
  assert.match(output, /sunny → rain/);
  assert.match(output, /24 °C → 19 °C/);
  assert.match(weatherFacts(evidence, 'Europe/Madrid'), /soleado → lluvia/);
});
