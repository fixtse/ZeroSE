import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tools } from '../src/application/tool-registry.js';
import { registerNutritionTools } from '../src/adapters/inbound/nutrition-tools.js';
import { HomeAssistantNutrition } from '../src/adapters/outbound/home-assistant-nutrition.js';
import { toolCapability } from '../src/domain/access.js';

test('nutrition tools call the Home Assistant calorie_tracker services', async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const ha = {
    async serviceResponse(service: string, data: Record<string, unknown>) {
      calls.push([service, data]);
      return { ok: service };
    },
    async callService() {},
  };
  const tools = new Tools({ audit: async () => {} } as any);
  registerNutritionTools(tools, new HomeAssistantNutrition(ha as any));
  const ctx = { session: 's', jobId: 'j', signal: new AbortController().signal };
  const call = (name: string, args: unknown) => tools.call(name, args, ctx);

  await call('food_recommend', { calories: 500, protein: 35 });
  assert.deepEqual(calls.at(-1), [
    'calorie_tracker.recommend_foods',
    { calories: 500, protein: 35, limit: 5 },
  ]);
  await call('food_log', { meal: 'dinner', food_id: 'mfp:1', quantity: 250, unit: 'g' });
  assert.deepEqual(calls.at(-1), [
    'calorie_tracker.log_food',
    { meal: 'dinner', food_id: 'mfp:1', quantity: 250, unit: 'g' },
  ]);
  await call('food_log', { meal: 'snack', name: 'Coffee', nutrients: { calories: 60 } });
  assert.deepEqual(calls.at(-1)?.[1], { meal: 'snack', name: 'Coffee', calories: 60 });
  await call('food_diary', {});
  assert.deepEqual(calls.at(-1), ['calorie_tracker.get_diary', {}]);

  await call('food_recommend', { meal: 'dinner' });
  assert.deepEqual(calls.at(-1), ['calorie_tracker.recommend_foods', { limit: 5, meal: 'dinner' }]);
  await call('food_goals_set', { protein: 140, fat: 60, calorie_period: 'week' });
  assert.deepEqual(calls.at(-1), [
    'calorie_tracker.set_goals',
    { protein: 140, fat: 60, calorie_period: 'week' },
  ]);
  await assert.rejects(call('food_goals_set', {}), /at least one goal/);
  await assert.rejects(call('food_log', { meal: 'lunch' }), /food_id or name/);
  await assert.rejects(
    call('food_log', { meal: 'lunch', food_id: 'x', servings: 1, quantity: 2 }),
    /not both/,
  );
  assert.equal(toolCapability('food_log'), 'homeAssistant');
});
