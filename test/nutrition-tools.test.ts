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
  await call('food_save', {
    name: 'Soup',
    kind: 'recipe',
    ingredients: ['400 g beans'],
    instructions: ['Simmer.'],
    recipe_servings: 4,
    nutrients: { calories: 200 },
  });
  assert.deepEqual(calls.at(-1), [
    'calorie_tracker.save_food',
    {
      name: 'Soup',
      serving_amount: 1,
      serving_unit: 'serving',
      calories: 200,
      kind: 'recipe',
      ingredients: ['400 g beans'],
      instructions: ['Simmer.'],
      recipe_servings: 4,
    },
  ]);
  await assert.rejects(
    call('food_save', { name: 'Soup', nutrients: { calories: 200 }, recipe_servings: 0 }),
  );
  await call('food_diary', {});
  assert.deepEqual(calls.at(-1), ['calorie_tracker.get_diary', {}]);

  await call('food_recommend', { meal: 'dinner' });
  assert.deepEqual(calls.at(-1), ['calorie_tracker.recommend_foods', { limit: 5, meal: 'dinner' }]);
  await call('food_goals_set', { protein: 140, fat: 60, calorie_period: 'week' });
  assert.deepEqual(calls.at(-1), [
    'calorie_tracker.set_goals',
    { protein: 140, fat: 60, calorie_period: 'week' },
  ]);
  await call('food_goals_set', { recommend_since: '2025-03-01' });
  assert.deepEqual(calls.at(-1), ['calorie_tracker.set_goals', { recommend_since: '2025-03-01' }]);
  await call('food_goals_set', { recommend_since: '' });
  assert.deepEqual(calls.at(-1), ['calorie_tracker.set_goals', { recommend_since: '' }]);
  await call('food_recommend', { meal: 'lunch', since: '' });
  assert.deepEqual(calls.at(-1), [
    'calorie_tracker.recommend_foods',
    { limit: 5, meal: 'lunch', since: '' },
  ]);
  await assert.rejects(call('food_goals_set', {}), /at least one goal/);
  await assert.rejects(call('food_log', { meal: 'lunch' }), /food_id or name/);
  await assert.rejects(
    call('food_log', { meal: 'lunch', food_id: 'x', servings: 1, quantity: 2 }),
    /not both/,
  );
  await call('food_log_update', { entry_id: 'mfp:9', meal: 'lunch', nutrients: { protein: 30 } });
  assert.deepEqual(calls.at(-1), [
    'calorie_tracker.update_entry',
    { entry_id: 'mfp:9', meal: 'lunch', protein: 30 },
  ]);
  await assert.rejects(call('food_log_update', { entry_id: 'x' }), /at least one field/);
  await call('food_copy_day', { from: '2026-11-13', meals: ['dinner'] });
  assert.deepEqual(calls.at(-1), [
    'calorie_tracker.copy_day',
    { from: '2026-11-13', meals: ['dinner'] },
  ]);
  assert.equal(toolCapability('food_log'), 'homeAssistant');
  assert.equal(toolCapability('food_copy_day'), 'homeAssistant');
});
