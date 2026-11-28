import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceBridge, voiceOriginInstruction } from '../src/application/voice-bridge.js';
import { fixture } from './helpers.js';

test('voice origin instruction names the device, area and exposed entities', () => {
  assert.equal(voiceOriginInstruction(undefined), '');
  const line = voiceOriginInstruction({
    device: 'Bedroom panel',
    area: 'Bedroom',
    entities: ['select.bedroom_panel_show_entity', 'select.bedroom_panel_page'],
  });
  assert.match(line, /"Bedroom panel" in area "Bedroom"/);
  assert.match(line, /select\.bedroom_panel_show_entity, select\.bedroom_panel_page/);
  assert.doesNotMatch(voiceOriginInstruction({ device: 'Panel', entities: [] }), /in area|exposed/);
});

test('voice turns keep the originating device in the job payload', async () => {
  const f = await fixture();
  const voice = new VoiceBridge(f.store, 'assist_satellite.fixture', async () => 'telegram:1');
  const origin = { device: 'Bedroom panel', area: 'Bedroom', entities: ['select.panel_page'] };
  try {
    const job = await voice.submit({
      request_id: crypto.randomUUID(),
      satellite_id: 'assist_satellite.fixture',
      text: 'show the desk lamp',
      origin,
    });
    assert.ok(job);
    assert.deepEqual((await f.store.job(job.id))?.payload.origin, origin);
  } finally {
    await f.close();
  }
});
