import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { fixture } from './helpers.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { PostgresZeroSettings } from '../src/adapters/outbound/postgres-zero-settings.js';
import { UserContext } from '../src/application/user-context.js';
import { Access } from '../src/application/access.js';
import { voiceUserSession } from '../src/application/voice-bridge.js';
import {
  registerContextTools,
  registerGoogleTools,
} from '../src/adapters/inbound/integration-tools.js';
import { Tools } from '../src/application/tool-registry.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import { ProcessMessage } from '../src/application/use-cases/process-message.js';
import type { GooglePort, GoogleToolsPort, TelegramPort } from '../src/application/ports.js';

test('local context supports edits without Google, isolates profiles and rejects stale or disabled writes', async () => {
  const f = await fixture();
  try {
    const profiles = new PostgresAccess(f.store.db, f.config.apiKey);
    await profiles.initialize(f.config);
    await profiles.saveProfile({
      bot: 'zero',
      chatId: '123',
      kind: 'user',
      label: 'User',
      enabled: true,
      owner: false,
      capabilities: [],
    });
    await profiles.saveProfile({
      bot: 'zero',
      chatId: '-123',
      kind: 'group',
      label: 'Group',
      enabled: true,
      owner: false,
      capabilities: [],
    });
    const context = new UserContext(profiles);
    const tools = new Tools(f.store);
    registerGoogleTools(tools, { enabled: false } as GoogleToolsPort);
    registerContextTools(tools, context, 0, true);
    assert.deepEqual(
      tools.definitions().map((t) => t.name),
      ['context_get', 'context_save'],
    );
    const turn = {
      session: 'telegram:123',
      jobId: 'context-test',
      signal: AbortSignal.timeout(10000),
    };
    await tools.call('context_save', { memory: 'First fact' }, turn);
    await tools.call(
      'context_save',
      { memory: 'Corrected fact', mode: 'replace', revision: 1 },
      turn,
    );
    assert.equal((await profiles.profile('zero', '123'))?.context, 'Corrected fact');
    assert.equal((await profiles.profile('zero', '-123'))?.context, '');
    await assert.rejects(context.save('telegram:123', 'Stale', 'replace', 0), /changed/);
    const writes = await Promise.allSettled([
      context.save('telegram:123', 'A', 'replace', 2),
      context.save('telegram:123', 'B', 'replace', 2),
    ]);
    assert.equal(writes.filter((w) => w.status === 'fulfilled').length, 1);
    await assert.rejects(context.save('telegram:123', 'x'.repeat(16001), 'replace', 3), /exceeds/);
    await context.save('telegram:123', '', 'replace', 3);
    assert.equal((await profiles.profile('zero', '123'))?.context, '');
    await context.save('telegram:-123', 'Group fact', 'replace', 0);
    await profiles.migrateGroup('zero', '-123', '-456');
    assert.equal((await profiles.profile('zero', '-456'))?.context, 'Group fact');
    const group = (await profiles.profile('zero', '-123'))!;
    await profiles.saveProfile({ ...group, memoryMode: 'none' });
    await assert.rejects(context.save('telegram:-123', 'No', 'replace', 1), /disabled/);
    assert.equal((await profiles.profile('zero', '-123'))?.context, 'Group fact');
    const disabledTools = new Tools(f.store);
    registerContextTools(disabledTools, context, 1, false);
    assert.equal(disabledTools.definitions().length, 0);
  } finally {
    await f.close();
  }
});

test('HA-only profiles expose settings and context; linking merges atomically with HA precedence', async () => {
  const f = await fixture();
  try {
    const profiles = new PostgresAccess(f.store.db, f.config.apiKey);
    await profiles.initialize(f.config);
    const userId = 'a'.repeat(32);
    await profiles.ensureHomeAssistantUser(userId, 'HA person', {
      ...f.config.homeAssistant,
      url: 'https://ha.example',
      token: 'ha-private-token',
    });
    const haProfile = (await profiles.profile('zero', 'ha:' + userId))!;
    await profiles.saveProfile({ ...haProfile, timezone: 'UTC', memoryMode: 'simple' });
    const context = new UserContext(profiles);
    await context.save('home-assistant:' + userId, 'HA context', 'replace', 0);
    const access = new Access(profiles, f.store);
    const settings = new PostgresZeroSettings(f.store.db, profiles);
    await settings.initialize('Zero');
    const bots = { isEnabled: async () => true };
    assert.equal(
      await voiceUserSession(userId, settings, access, bots),
      'home-assistant:' + userId,
    );
    const admin = new Admin(
      f.config,
      profiles,
      async () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      context,
    );
    const request = async (method: string, suffix = '', value: unknown = {}) => {
      let status = 0,
        result: any;
      await admin.handle(
        { method } as IncomingMessage,
        '/v1/admin/profiles/zero/ha:' + userId + suffix,
        async () => value,
        (code, body) => {
          status = code;
          result = body;
        },
      );
      return { status, result };
    };
    const details = await request('GET');
    assert.equal(details.status, 200);
    assert.equal(details.result.source, 'home_assistant');
    assert.equal(details.result.context, 'HA context');
    assert(!JSON.stringify(details.result).includes('ha-private-token'));
    assert.equal(
      (await request('PUT', '', { ...haProfile, homeAssistant: { url: 'https://other.example' } }))
        .status,
      400,
    );
    assert.equal(
      (await request('PUT', '/context', { memory: 'Edited in UI', revision: 1 })).status,
      200,
    );
    await profiles.saveProfile({
      ...haProfile,
      chatId: '123',
      label: 'Telegram',
      timezone: 'Europe/Madrid',
      memoryMode: 'advanced',
      homeAssistant: undefined,
      google: { ...f.config.google, refreshToken: 'telegram-google' },
    });
    await context.save('telegram:123', 'Telegram context', 'replace', 0);
    const before = await settings.read();
    assert.equal(
      await settings.update({
        ...before,
        revision: before.revision + 1,
        homeAssistantUsers: { [userId]: '123' },
      }),
      undefined,
    );
    assert.equal((await profiles.profile('zero', '123'))?.context, 'Telegram context');
    await settings.update({ ...before, homeAssistantUsers: { [userId]: '123' } });
    const merged = (await profiles.profile('zero', '123'))!;
    assert.equal(merged.context, 'Edited in UI');
    assert.equal(merged.memoryMode, 'simple');
    assert.equal(merged.timezone, 'UTC');
    assert.equal(merged.google?.refreshToken, 'telegram-google');
    assert.equal(merged.homeAssistant?.token, 'ha-private-token');
    assert.equal(await voiceUserSession(userId, settings, access, bots), 'telegram:123');
    assert.equal(
      (await profiles.profiles('', 0, 20)).items.some((p) => p.chatId.startsWith('ha:')),
      false,
    );
    const linked = await settings.read();
    await settings.update({ ...linked, homeAssistantUsers: {} });
    assert.equal(
      await voiceUserSession(userId, settings, access, bots),
      'home-assistant:' + userId,
    );
    assert.equal(
      (await profiles.profiles('', 0, 20)).items.some((p) => p.chatId.startsWith('ha:')),
      true,
    );
    await context.save('home-assistant:' + userId, '', 'replace', 2);
    const unlinked = await settings.read();
    await settings.update({ ...unlinked, homeAssistantUsers: { [userId]: '123' } });
    assert.equal(
      (await profiles.profile('zero', '123'))?.context,
      '',
      'An explicitly cleared HA context wins when linking',
    );
  } finally {
    await f.close();
  }
});

test('prompt context comes from the profile and is empty with memory disabled', async () => {
  const f = await fixture();
  try {
    for (const enabled of [true, false]) {
      f.config.memory.mode = enabled ? 'simple' : 'none';
      const useCase = new ProcessMessage(
        f.config,
        f.store,
        {
          async run(_session, _prompt, instructions) {
            assert(
              instructions.includes(
                enabled ? 'Profile context: local context' : 'Profile context: .',
              ),
            );
            return 'Done';
          },
        },
        {
          enabled: true,
          context: async () => {
            throw new Error('Must not read Google context');
          },
        } as unknown as GooglePort,
        {} as TelegramPort,
        'Profile context: {{context}}.',
        'Zero',
        'automatic',
        'local context',
      );
      await useCase.execute(
        {
          id: 'context-prompt',
          session: 'telegram:123',
          payload: { kind: 'chat', text: 'Hello' },
          status: 'running',
        } as any,
        { session: 'telegram:123', jobId: 'context-prompt', signal: AbortSignal.timeout(10000) },
      );
    }
  } finally {
    await f.close();
  }
});
