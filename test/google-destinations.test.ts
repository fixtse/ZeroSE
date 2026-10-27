import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleDestinations } from '../src/application/google-destinations.js';
import { Google } from '../src/adapters/outbound/google.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import { fixture } from './helpers.js';
import type { IncomingMessage } from 'node:http';
import type { AccessProfile } from '../src/domain/access.js';

test('destination changes save immediately, preserve OAuth and survive a later unrelated profile save', async () => {
  const f = await fixture();
  try {
    const repository = new PostgresAccess(f.store.db, f.config.apiKey);
    const profile: AccessProfile = {
      bot: 'zero',
      chatId: '123',
      label: 'User',
      kind: 'user',
      owner: false,
      enabled: true,
      capabilities: ['calendar', 'tasks', 'documents'],
      google: {
        ...f.config.google,
        clientId: 'client',
        clientSecret: 'private-client',
        refreshToken: 'private-refresh',
        contextDocumentId: 'retained-doc',
      },
      homeAssistant: { ...f.config.homeAssistant, token: 'private-ha' },
    };
    await repository.saveProfile(profile);
    const seen: unknown[] = [];
    const settings = new GoogleDestinations(repository, f.config, () => ({
      async destination(kind, id) {
        seen.push([kind, id]);
        return { id, name: 'Selected destination' };
      },
    }));
    const admin = new Admin(f.config, repository, async () => {}).withGoogleDestinations(settings);
    async function request(path: string, body: unknown) {
      let status = 0;
      let value: any;
      await admin.handle(
        { method: 'PUT', url: path } as IncomingMessage,
        path,
        async () => body,
        (code, result) => {
          status = code;
          value = result;
        },
      );
      return { status, value };
    }
    const path = '/v1/admin/profiles/zero/123';
    const saved = await request(path + '/google/destination', {
      kind: 'document-folders',
      id: 'folder',
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.value.selected.name, 'Selected destination');
    let current = (await repository.profile('zero', '123'))!;
    assert.equal(current.google?.documentFolderId, 'folder');
    assert.equal(current.google?.destinationNames?.documentFolderId, 'Selected destination');
    assert.equal(current.google?.refreshToken, 'private-refresh');
    assert.equal(current.google?.contextDocumentId, 'retained-doc');
    assert.equal(
      (
        await request(path, {
          kind: 'user',
          label: 'Renamed',
          enabled: true,
          capabilities: profile.capabilities,
        })
      ).status,
      200,
    );
    current = (await repository.profile('zero', '123'))!;
    assert.equal(current.google?.documentFolderId, 'folder');
    assert.equal(current.homeAssistant?.token, 'private-ha');
    assert(!JSON.stringify(saved.value).includes('private-'));
    await repository.saveProfile({
      ...current,
      homeAssistant: { ...current.homeAssistant!, taskProvider: 'home_assistant' },
    });
    assert.equal(
      (await request(path + '/google/destination', { kind: 'task-lists', id: 'list' })).status,
      403,
    );
    assert.deepEqual(seen, [['document-folders', 'folder']]);
  } finally {
    await f.close();
  }
});

test('destination resolver verifies metadata and rejects read-only or non-folder destinations', async () => {
  const { ConfigSchema } = await import('../src/adapters/outbound/config-schema.js');
  const config = ConfigSchema.parse({});
  const google = new Google(config.google, config.timezone);
  const requests: string[] = [];
  google.request = async (path) => {
    requests.push(path);
    return path.startsWith('calendar')
      ? { id: 'calendar', summary: 'Calendar', accessRole: 'writer' }
      : path.startsWith('tasks')
        ? { id: 'list', title: 'My tasks' }
        : {
            id: 'folder',
            name: 'Documents',
            mimeType: 'application/vnd.google-apps.folder',
            capabilities: { canAddChildren: true },
          };
  };
  assert.deepEqual(await google.destination('calendars', 'calendar', AbortSignal.timeout(1000)), {
    id: 'calendar',
    name: 'Calendar',
  });
  assert.deepEqual(await google.destination('task-lists', 'list', AbortSignal.timeout(1000)), {
    id: 'list',
    name: 'My tasks',
  });
  assert.deepEqual(
    await google.destination('document-folders', 'folder', AbortSignal.timeout(1000)),
    { id: 'folder', name: 'Documents' },
  );
  assert.equal(requests.length, 3);
  google.request = async () => ({ id: 'wrong', accessRole: 'reader', mimeType: 'text/plain' });
  await assert.rejects(() => google.destination('calendars', 'wrong', AbortSignal.timeout(1000)));
  await assert.rejects(() =>
    google.destination('document-folders', 'wrong', AbortSignal.timeout(1000)),
  );
  assert.equal(
    (await google.destination('document-folders', '', AbortSignal.timeout(1000))).id,
    '',
  );
});
