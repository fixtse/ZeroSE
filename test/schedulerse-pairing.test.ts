import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  SchedulerSEPairing,
  type SchedulerPairingPort,
} from '../src/application/schedulerse-pairing.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { serviceConfig } from '../src/application/service-settings.js';

function fixture() {
  let value = serviceConfig(
    ConfigSchema.parse({ apiKey: 'test-only-key', database: { url: 'postgres://test' } }),
  );
  let revision = 1;
  let writes = 0;
  let registered: Parameters<SchedulerPairingPort['begin']>[1];
  let remoteState: 'pending' | 'approved' = 'pending';
  let uncertain = false;
  let now = 1000000;
  const settings = {
    initialize: async () => {},
    read: async () => ({ value: structuredClone(value), revision }),
    update: async (expected: number, next: typeof value) => {
      writes++;
      if (expected !== revision) return false;
      value = structuredClone(next);
      revision++;
      if (uncertain) throw new Error('lost response after commit');
      return true;
    },
  };
  const remote: SchedulerPairingPort = {
    validateUrl: async () => {},
    begin: async (_url, input) => {
      registered = input;
    },
    status: async () => remoteState,
    ready: async () => {},
  };
  const crypto = {
    id: randomUUID,
    secret: randomUUID,
    digest: (value: string) => createHash('sha256').update(value).digest('hex'),
  };
  const pairing = new SchedulerSEPairing(
    settings,
    remote,
    crypto,
    'Bearer callback-private',
    'https://zero.example',
    () => now,
  );
  return {
    pairing,
    settings,
    remote,
    get value() {
      return value;
    },
    get writes() {
      return writes;
    },
    get registered() {
      return registered;
    },
    approve: () => {
      remoteState = 'approved';
    },
    expire: () => {
      now += 300001;
    },
    uncertain: () => {
      uncertain = true;
    },
    edit: () => {
      value.timezone = 'UTC';
      revision++;
    },
  };
}

test('pairing exchanges digests, preserves unrelated edits and never exposes secrets', async () => {
  const f = fixture();
  const started = await f.pairing.begin('https://scheduler.example/');
  assert.equal(started.callbackUrl, 'https://zero.example/v1/triggers/schedulerse-events');
  assert.match(f.registered.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(started).includes('private'), false);
  await assert.rejects(f.pairing.finish(), /Aprueba/);
  assert.equal(f.writes, 0);
  f.approve();
  f.edit();
  await f.pairing.finish();
  assert.equal(f.value.timezone, 'UTC');
  assert.equal(f.value.schedulerSE?.enabled, true);
  assert.equal((await f.pairing.status()).state, 'configured');
  assert.equal(
    JSON.stringify(await f.pairing.status()).includes(f.value.schedulerSE!.token),
    false,
  );
  await assert.rejects(f.pairing.finish(), /Consulta/);
  assert.equal(f.writes, 1);
});

test('lost commit response is reconciled by reading without replaying a write', async () => {
  const f = fixture();
  await f.pairing.begin('https://scheduler.example');
  f.approve();
  f.uncertain();
  await assert.rejects(f.pairing.finish(), /lost response/);
  await assert.rejects(f.pairing.finish(), /Consulta/);
  assert.equal((await f.pairing.status()).state, 'configured');
  assert.equal(f.writes, 1);
});

test('lost registration response retains a GET-only recovery handle', async () => {
  const f = fixture();
  let registrations = 0;
  f.remote.begin = async () => {
    registrations++;
    throw new Error('lost response');
  };
  await assert.rejects(f.pairing.begin('https://scheduler.example'), /lost response/);
  assert.equal((await f.pairing.status()).state, 'pending');
  await assert.rejects(f.pairing.begin('https://scheduler.example'), /curso/);
  assert.equal(registrations, 1);
});

test('pairing refuses replacement credentials, expired requests and malformed origins', async () => {
  const f = fixture();
  await assert.rejects(f.pairing.begin('https://user:secret@scheduler.example'), /sin rutas/);
  await f.pairing.begin('https://scheduler.example');
  f.approve();
  f.expire();
  await assert.rejects(f.pairing.finish(), /caducado/);
  assert.equal(f.writes, 0);
  f.value.schedulerSE = { url: 'https://existing.example', token: 'saved', enabled: true };
  await assert.rejects(f.pairing.begin('https://scheduler.example'), /conservado/);
});

test('private Docker URL stays separate from browser approval and is validated before registration', async () => {
  const f = fixture();
  const checked: string[] = [];
  f.remote.validateUrl = async (url) => {
    checked.push(url);
  };
  const started = await f.pairing.begin('http://schedulerse:3000', 'http://localhost:4300');
  assert.deepEqual(checked, ['http://schedulerse:3000']);
  assert.equal(started.serviceUrl, 'http://schedulerse:3000');
  assert.match(started.approvalUrl, /^http:\/\/localhost:4300\/pairing\//);
  const recovered = await f.pairing.status();
  assert.ok('approvalUrl' in recovered);
  assert.equal(recovered.approvalUrl, started.approvalUrl);
  f.approve();
  await f.pairing.finish();
  assert.equal(f.value.schedulerSE?.url, 'http://schedulerse:3000');
  assert.equal(JSON.stringify(f.value).includes('4300'), false);
  const blocked = fixture();
  blocked.remote.validateUrl = async () => {
    throw new Error('HTTPS required');
  };
  await assert.rejects(blocked.pairing.begin('http://public.example'), /HTTPS/);
  assert.equal((await blocked.pairing.status()).state, 'idle');
  assert.equal(blocked.registered, undefined);
});

test('concurrent finishing cannot write twice and connection edits win over pairing', async () => {
  const f = fixture();
  await f.pairing.begin('https://scheduler.example');
  f.approve();
  const results = await Promise.allSettled([f.pairing.finish(), f.pairing.finish()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.writes, 1);
  const other = fixture();
  await other.pairing.begin('https://scheduler.example');
  other.approve();
  other.value.schedulerSE = { url: 'https://other.example', token: 'other', enabled: false };
  await assert.rejects(other.pairing.finish(), /ha cambiado/);
  assert.equal(other.writes, 0);
});
