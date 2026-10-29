import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { ServiceSettingsAdmin } from '../src/adapters/inbound/service-settings-admin.js';
import { PostgresServiceSettings } from '../src/adapters/outbound/postgres-service-settings.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { loadConfig } from '../src/adapters/outbound/config.js';
import { loadRuntimeConfig } from '../src/adapters/outbound/runtime-config.js';
import { serviceConfig, type ServiceConfig } from '../src/application/service-settings.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture as databaseFixture } from './helpers.js';

function fixture() {
  let value = serviceConfig(
    ConfigSchema.parse({
      google: { clientSecret: 'private-google-secret' },
      reader: { apiKey: 'private-reader-secret' },
    }),
  );
  let revision = 1;
  const applied: ServiceConfig[] = [];
  const admin = new ServiceSettingsAdmin(
    {
      initialize: async () => {},
      read: async () => ({ revision, value }),
      update: async (expected, next) => {
        if (expected !== revision) return false;
        value = next;
        revision++;
        return true;
      },
    },
    async (next) => {
      applied.push(structuredClone(next));
    },
  );
  return { admin, value: () => value, applied };
}
async function request(
  admin: ServiceSettingsAdmin,
  method: string,
  body?: unknown,
  path = '/v1/admin/setup/services',
) {
  let status = 0;
  let result: any;
  await admin.handle(
    { method } as IncomingMessage,
    path,
    async () => body,
    (code, value) => {
      status = code;
      result = value;
    },
  );
  return { status, result };
}
test('service catalog exposes shared infrastructure only and redacts secrets', async () => {
  const { admin } = fixture();
  const { result, status } = await request(admin, 'GET');
  assert.equal(status, 200);
  assert(
    !result.fields.some(
      (field: any) =>
        ['memory', 'codex', 'telegram', 'google', 'homeAssistant'].includes(field.group) ||
        field.path === 'schedules.consolidate',
    ),
  );
  const secret = result.fields.find((field: any) => field.path === 'reader.apiKey');
  assert.equal(secret.value, '');
  assert.equal(secret.configured, true);
  assert.equal(secret.secretHint, 'priv••••••••cret');
  assert(!result.fields.some((field: any) => field.path.startsWith('schedulerSE.')));
  assert(!JSON.stringify(result).includes('private-google-secret'));
  assert(!JSON.stringify(result).includes('private-reader-secret'));
  for (const path of [
    'media.ffmpegCommand',
    'media.audioExtractionUrl',
    'reader.apiKey',
    'places.photonUrl',
  ]) {
    assert(
      result.fields.some((field: any) => field.path === path),
      path,
    );
  }
  assert(!result.fields.some((field: any) => field.path === 'database.url'));
  assert(!result.fields.some((field: any) => field.path === 'reader.url'));
});
test('service updates preserve secrets, reject stale writes, and validate without echoing secrets', async () => {
  const { admin, value } = fixture();
  assert.equal(
    (
      await request(admin, 'PUT', {
        revision: 1,
        changes: {
          'reader.apiKey': '',
          'media.ffmpegCommand': '/usr/bin/ffmpeg',
        },
      })
    ).status,
    200,
  );
  assert.equal(value().google.clientSecret, 'private-google-secret');
  assert.equal(value().reader?.apiKey, 'private-reader-secret');
  assert.equal(value().media.ffmpegCommand, '/usr/bin/ffmpeg');
  assert.equal((await request(admin, 'PUT', { revision: 1, changes: {} })).status, 409);
  const invalid = await request(admin, 'PUT', {
    revision: 2,
    changes: { 'places.photonUrl': 'private-invalid-value' },
  });
  assert.equal(invalid.status, 400);
  assert(!JSON.stringify(invalid.result).includes('private-invalid-value'));
  for (const path of ['__proto__.polluted', 'database.url', 'apiKey']) {
    assert.equal(
      (await request(admin, 'PUT', { revision: 2, changes: { [path]: 'x' } })).status,
      400,
    );
  }
  assert.equal(
    (await request(admin, 'PUT', { revision: 2, changes: { 'reader.apiKey': null } })).status,
    200,
  );
  assert.equal(value().reader?.apiKey, '');
});
test('service settings encrypt at rest, import once, roundtrip, and compare revisions', async () => {
  const f = await databaseFixture();
  try {
    const settings = new PostgresServiceSettings(f.store.db, 'stable-private-key');
    const initial = serviceConfig(ConfigSchema.parse({ braveApiKey: 'private-search-key' }));
    await settings.initialize(initial);
    const row = (await f.store.pool.query('SELECT value FROM service_settings')).rows[0];
    assert(!row.value.includes('private-search-key'));
    await settings.initialize(serviceConfig(ConfigSchema.parse({})));
    assert.equal((await settings.read()).value.braveApiKey, 'private-search-key');
    assert(await settings.update(1, { ...initial, timezone: 'UTC' }));
    assert.equal(await settings.update(1, initial), false);
    assert.equal((await settings.read()).value.timezone, 'UTC');
    await assert.rejects(new PostgresServiceSettings(f.store.db, 'wrong-key').read());
  } finally {
    await f.close();
  }
});
test('bootstrap ignores legacy configuration files and only loads environment settings', () => {
  const old = { ...process.env };
  const directory = mkdtempSync(join(tmpdir(), 'service-config-'));
  const cwd = process.cwd();
  try {
    process.env.ASSISTANT_API_KEY = 'a-stable-api-key-at-least-24-characters';
    process.env.ASSISTANT_DATABASE_URL = 'postgresql://test@localhost/test';
    writeFileSync(join(directory, 'config.json'), 'invalid legacy JSON');
    process.chdir(directory);
    process.env.ASSISTANT_CONFIG = join(directory, 'config.json');
    const config = loadConfig();
    assert.equal(config.apiKey, process.env.ASSISTANT_API_KEY);
    assert.equal(config.database.url, process.env.ASSISTANT_DATABASE_URL);
  } finally {
    process.env = old;
    process.chdir(cwd);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PostgreSQL service settings survive reopening and retain imported values', async () => {
  const db = await databaseFixture();
  try {
    const first = new PostgresServiceSettings(db.store.db, 'stable-key');
    await first.initialize(serviceConfig(db.config));
    const current = await first.read();
    assert(
      await first.update(current.revision, {
        ...current.value,
        reader: { url: 'https://r.jina.ai/', apiKey: 'jina-private-test' },
      }),
    );
    const reopened = new PostgresServiceSettings(db.store.db, 'stable-key');
    await reopened.initialize(serviceConfig(ConfigSchema.parse({})));
    const saved = await reopened.read();
    assert.equal(saved.value.reader?.apiKey, 'jina-private-test');
    assert.equal(await reopened.update(current.revision, current.value), false);
    const raw = await db.store.pool.query('SELECT value FROM service_settings');
    assert(!raw.rows[0].value.includes('jina-private-test'));
  } finally {
    await db.close();
  }
});

test('setup can save defaults with every integration left unconfigured', async () => {
  const { admin, value } = fixture();
  const result = await request(admin, 'PUT', {
    revision: 1,
    changes: {},
  });
  assert.equal(result.status, 200);
  assert.equal(value().google.clientSecret, 'private-google-secret');
  assert.equal(value().homeAssistant.token, '');
  assert.equal(value().telegram.token, '');
  assert.equal('schedulerSE' in value(), false);
});

test('retired service settings stay private and inert when unrelated settings are saved', async () => {
  const { admin, value } = fixture();
  const legacy = {
    url: 'http://old-private-service:8789',
    token: 'legacy-private-token',
    enabled: true,
  };
  Object.assign(value(), { schedulerSE: legacy });
  const catalog = await request(admin, 'GET');
  assert(!JSON.stringify(catalog.result).includes('legacy-private-token'));
  assert(!catalog.result.fields.some((field: any) => field.path.startsWith('schedulerSE.')));
  assert.equal(
    (await request(admin, 'PUT', { revision: 1, changes: { 'schedulerSE.enabled': true } })).status,
    400,
  );
  assert.equal(
    (await request(admin, 'PUT', { revision: 1, changes: { timezone: 'UTC' } })).status,
    200,
  );
  assert.deepEqual((value() as unknown as Record<string, unknown>).schedulerSE, legacy);
  assert.equal('schedulerSE' in ConfigSchema.parse(value()), false);
  for (const method of ['GET', 'POST']) {
    const handled = await admin.handle(
      { method } as IncomingMessage,
      '/v1/admin/setup/services/schedulerse/pairing',
      async () => assert.fail('retired pairing must not read mutation payloads'),
      () => assert.fail('retired pairing must not respond as an active service'),
    );
    assert.equal(handled, false);
  }
});

test('runtime creates empty service settings and reopens saved setup without a file', async () => {
  const db = await databaseFixture();
  const old = { ...process.env };
  try {
    const url = new URL(db.url);
    url.searchParams.set('options', '-c search_path=' + db.schema + ',public');
    process.env.ASSISTANT_DATABASE_URL = url.href;
    delete process.env.ASSISTANT_API_KEY;
    delete process.env.ASSISTANT_SECRETS_KEY;
    process.env.ASSISTANT_DATA_DIR = db.dir;
    delete process.env.ASSISTANT_PHOTON_URL;
    delete process.env.ASSISTANT_OSRM_URL;
    const first = await loadRuntimeConfig();
    assert.equal(first.telegram.token, '');
    assert.equal(first.google.refreshToken, '');
    assert.equal(first.homeAssistant.token, '');
    assert.equal('schedulerSE' in first, false);
    const settings = new PostgresServiceSettings(db.store.db, first.apiKey);
    const saved = await settings.read();
    assert(
      await settings.update(saved.revision, {
        ...saved.value,
        timezone: 'UTC',
        braveApiKey: 'configured-in-setup',
      }),
    );
    const reopened = await loadRuntimeConfig();
    assert.equal(reopened.apiKey, first.apiKey);
    assert.equal(reopened.timezone, 'UTC');
    assert.equal(reopened.braveApiKey, 'configured-in-setup');
  } finally {
    process.env = old;
    await db.close();
  }
});

test('first startup generates a private persistent key and environment overrides retain priority', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bootstrap-key-'));
  const old = { ...process.env };
  try {
    delete process.env.ASSISTANT_API_KEY;
    process.env.ASSISTANT_DATA_DIR = join(directory, 'data');
    process.env.ASSISTANT_DATABASE_URL = 'postgresql://test@localhost/test';
    const first = loadConfig();
    assert.match(first.apiKey, /^[a-f0-9]{64}$/);
    const file = join(first.dataDir, 'bootstrap.key');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(loadConfig().apiKey, first.apiKey);
    process.env.ASSISTANT_API_KEY = 'existing-key-with-at-least-24-characters';
    assert.equal(loadConfig().apiKey, process.env.ASSISTANT_API_KEY);
    assert.equal(readFileSync(file, 'utf8'), first.apiKey);
    delete process.env.ASSISTANT_API_KEY;
    writeFileSync(file, 'damaged-key');
    assert.throws(() => loadConfig(), /restore it from your private backup/);
    assert.equal(readFileSync(file, 'utf8'), 'damaged-key');
  } finally {
    process.env = old;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy memory categories and consolidation times are ignored when loading settings', () => {
  const config = ConfigSchema.parse({
    memory: { categories: ['Old'] },
    schedules: { consolidate: '23:59' },
  });
  assert(!('categories' in config.memory));
  assert(!('schedules' in config));
});

test('service settings cannot change memory and preserve legacy identities on unrelated saves', async () => {
  const { admin, value } = fixture();
  const before = structuredClone(value().memory);
  for (const [path, next] of Object.entries({
    'memory.mode': 'none',
    'memory.geminiApiKey': 'private',
    'memory.sharedProfile': 'other',
    'memory.embeddingModel': 'other',
    'memory.embeddingDimensions': 123,
  })) {
    assert.equal(
      (await request(admin, 'PUT', { revision: 1, changes: { [path]: next } })).status,
      400,
    );
  }
  assert.equal(
    (await request(admin, 'PUT', { revision: 1, changes: { timezone: 'UTC' } })).status,
    200,
  );
  assert.deepEqual(value().memory, before);
});

test('dedicated settings cannot be discovered or changed through global services', async () => {
  const { admin, value } = fixture();
  const before = structuredClone(value());
  for (const [path, next] of Object.entries({
    'codex.command': '/other/codex',
    'codex.model': 'other',
    'codex.effort': 'high',
    'telegram.token': 'private',
    'telegram.webhookSecret': 'private',
    'telegram.allowedUsers': ['other'],
    'telegram.voiceReplies': false,
    'google.clientSecret': 'other',
    'google.credentials.docs.refreshToken': 'other',
    'google.calendarId': 'other',
    'google.taskListId': 'other',
    'homeAssistant.url': 'https://other.example',
  })) {
    assert.equal(
      (await request(admin, 'PUT', { revision: 1, changes: { [path]: next } })).status,
      400,
      path,
    );
  }
  assert.equal(
    (await request(admin, 'PUT', { revision: 1, changes: { timezone: 'UTC' } })).status,
    200,
  );
  for (const group of ['codex', 'telegram', 'google', 'homeAssistant'] as const) {
    assert.deepEqual(value()[group], before[group]);
  }
});

test('retired Codex settings are neither exposed nor editable', async () => {
  const { admin, value } = fixture();
  const before = structuredClone(value().codex);
  for (const method of ['GET', 'PUT']) {
    const handled = await admin.handle(
      { method } as IncomingMessage,
      '/v1/admin/setup/codex',
      async () => {
        throw new Error('Retired settings must not read input');
      },
      () => assert.fail('Retired settings must not expose a response'),
    );
    assert.equal(handled, false);
  }
  assert.deepEqual(value().codex, before);
});

test('Jina reader settings preserve the endpoint and reject URL-only provider changes', async () => {
  const { admin, value } = fixture();
  const before = value().reader?.url;
  const rejected = await request(admin, 'PUT', {
    revision: 1,
    changes: { 'reader.url': 'https://other-reader.example/' },
  });
  assert.equal(rejected.status, 400);
  assert.equal(value().reader?.url, before);
});

test('service saves apply validated settings without a restart and preserve hidden speech fields', async () => {
  const { admin, applied, value } = fixture();
  const result = await request(admin, 'PUT', {
    revision: 1,
    changes: { concurrency: 2, 'media.speech.tts': 'default', 'media.voice': 'es-MX-JorgeNeural' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.result.restartRequired, false);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].concurrency, 2);
  assert.equal(applied[0].media.voice, 'es-MX-JorgeNeural');
  assert.deepEqual(applied[0].media.speech, {
    stt: 'default',
    sttLanguage: '',
    tts: 'default',
    ttsLanguage: '',
    voice: '',
  });
  assert.equal(value().reader?.apiKey, 'private-reader-secret');
  await request(admin, 'PUT', { revision: 1, changes: { concurrency: 3 } });
  assert.equal(applied.length, 1, 'A stale save must not change active settings');
});

test('speech discovery forwards bounded filters and returns pagination without service secrets', async () => {
  let observed: unknown;
  const admin = new ServiceSettingsAdmin(
    {
      initialize: async () => {},
      read: async () => {
        throw new Error('Discovery must not expose saved settings');
      },
      update: async () => false,
    },
    undefined,
    async (kind, language, query) => {
      observed = { kind, language, search: query.search, offset: query.offset, limit: query.limit };
      return { items: [{ id: 'es-ES-AlvaroNeural', name: 'es-ES-AlvaroNeural' }], total: 3 };
    },
  );
  let status = 0;
  let result: any;
  await admin.handle(
    {
      method: 'GET',
      url: '/v1/admin/setup/services/speech?kind=voices&language=es-ES&search=Alvaro&offset=1&limit=1',
    } as IncomingMessage,
    '/v1/admin/setup/services/speech',
    async () => {
      throw new Error('GET must not read a mutation payload');
    },
    (code, value) => {
      status = code;
      result = value;
    },
  );
  assert.equal(status, 200);
  assert.deepEqual(observed, {
    kind: 'voices',
    language: 'es-ES',
    search: 'Alvaro',
    offset: 1,
    limit: 1,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.next_offset, 2);
});
