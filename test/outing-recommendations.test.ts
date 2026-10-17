import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema } from '../src/adapters/outbound/config.js';
import { Tools } from '../src/application/tool-registry.js';
import {
  registerGoogleTools,
  registerHomeAssistantTools,
} from '../src/adapters/inbound/integration-tools.js';
import type { GoogleToolsPort, HomeAssistantToolsPort } from '../src/application/ports.js';

test('weather discovery is exposed without an explicit entity, preserves daily default and supports hourly scoped results', async () => {
  const config = ConfigSchema.parse({ homeAssistant: { token: 'test-only', weatherEntity: '' } });
  const calls: string[] = [];
  const tools = new Tools({ audit: async () => {} });
  registerHomeAssistantTools(
    tools,
    {
      forecast: async (_signal, type) => {
        calls.push(type || 'missing');
        return type === 'hourly'
          ? {
              entity_id: 'weather.home',
              units: { temperature: '°C' },
              forecast: [{ datetime: '2026-10-18T12:00:00Z', temperature: 20 }],
            }
          : { service_response: { 'weather.home': { forecast: [] } } };
      },
    } as HomeAssistantToolsPort,
    config.homeAssistant,
  );
  const context = { session: 'owner', jobId: 'weather', signal: new AbortController().signal };
  const daily = await tools.call('weather_forecast', {}, context);
  assert.deepEqual(daily, { 'weather.home': { forecast: [] } });
  const hourly = (await tools.call('weather_forecast', { type: 'hourly' }, context)) as any;
  assert.equal(hourly.units.temperature, '°C');
  assert.equal(hourly.forecast[0].temperature, 20);
  assert.deepEqual(calls, ['daily', 'hourly']);
  await assert.rejects(tools.call('weather_forecast', { type: 'weekly' }, context));
  const disabled = new Tools({ audit: async () => {} });
  registerHomeAssistantTools(disabled, {} as HomeAssistantToolsPort, {
    ...config.homeAssistant,
    token: '',
  });
  assert(!disabled.definitions().some((tool) => tool.name === 'weather_forecast'));
});

test('calendar creation preserves agreed place and Maps link and rejects an invalid duration before any write', async () => {
  const writes: any[] = [];
  const tools = new Tools({ audit: async () => {} });
  registerGoogleTools(tools, {
    enabled: true,
    createEvent: async (value: unknown) => {
      writes.push(value);
      return {
        id: 'accepted-activity',
        status: 'confirmed',
        htmlLink: 'https://calendar.google.com/event?eid=test',
      };
    },
  } as GoogleToolsPort);
  const context = { session: 'owner', jobId: 'accepted', signal: new AbortController().signal };
  const event = {
    summary: 'Paseo por el Retiro',
    start: '2026-10-18T16:00:00+02:00',
    end: '2026-10-18T17:00:00+02:00',
    location: 'Parque del Retiro, Madrid',
    description: 'https://www.google.com/maps/search/?api=1&query=Parque+del+Retiro+Madrid',
  };
  await assert.rejects(
    tools.call('calendar_create', { ...event, end: event.start }, context),
    /Event end must follow start/,
  );
  assert.equal(writes.length, 0);
  const receipt = (await tools.call('calendar_create', event, context)) as any;
  assert.equal(receipt.id, 'accepted-activity');
  assert.deepEqual(writes, [event]);
});
