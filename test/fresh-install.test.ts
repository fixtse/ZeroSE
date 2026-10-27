import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';

test('fresh configuration contains no personal accounts or Home Assistant bindings', () => {
  for (const input of [{}, { homeAssistant: {} }]) {
    const config = ConfigSchema.parse(input);
    assert.deepEqual(config.telegram.allowedUsers, []);
    assert.equal(config.telegram.token, '');
    assert.equal(config.google.refreshToken, '');
    for (const key of [
      'url',
      'token',
      'voiceSatellite',
      'shoppingListEntity',
      'weatherEntity',
      'locationEntity',
      'geocodedLocationEntity',
    ] as const)
      assert.equal(config.homeAssistant[key], '');
    assert.deepEqual(config.homeAssistant.sensorEntities, []);
  }
  const homeAssistant = {
    url: 'https://ha.example.test',
    token: 'test-token',
    locationEntity: 'person.example',
  };
  assert.deepEqual(ConfigSchema.parse({ homeAssistant }).homeAssistant, {
    ...ConfigSchema.parse({}).homeAssistant,
    ...homeAssistant,
  });
});
