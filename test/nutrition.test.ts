import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPGlite } from '../src/adapters/outbound/pglite-runtime.js';
import { Store } from '../src/adapters/outbound/postgres-store.js';
import { PostgresNutrition } from '../src/adapters/outbound/postgres-nutrition.js';
import {
  NutritionCatalogSync,
  parseNutritionExport,
} from '../src/application/nutrition-catalog.js';
import { registerNutritionTools } from '../src/adapters/inbound/nutrition-tools.js';
import { Tools } from '../src/application/tool-registry.js';
import { manualFoodId, scaleNutrients, sumNutrients } from '../src/domain/nutrition.js';

test('nutrient arithmetic keeps unknown values unknown', () => {
  const values = {
    calories: 100,
    protein: 10,
    carbohydrates: null,
    fat: 2,
    fiber: null,
    sugar: null,
    sodium: 5,
  };
  assert.deepEqual(scaleNutrients(values, 1.5), {
    ...values,
    calories: 150,
    protein: 15,
    fat: 3,
    sodium: 7.5,
  });
  assert.equal(sumNutrients([values, { ...values, carbohydrates: 4 }]).carbohydrates, 4);
  assert.equal(manualFoodId('Arepa de Maíz', 'unit'), 'manual:arepa-de-maiz-unit');
});

test('export parsing skips invalid foods instead of failing the import', () => {
  const parsed = parseNutritionExport({
    version: 1,
    source: 'myfitnesspal',
    foods: [
      {
        external_id: 'diary:egg',
        name: 'Egg',
        serving_amount: 1,
        serving_unit: 'large',
        calories: 72,
      },
      { external_id: 'bad', name: '' },
    ],
  });
  assert.equal(parsed.foods.length, 1);
  assert.equal(parsed.skipped, 1);
  assert.equal(parsed.foods[0].protein, null);
});

test('catalog sync, search, logging, diary totals and deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero-nutrition-test-'));
  const runtime = await openPGlite(join(dir, 'db'));
  let store: Store | undefined;
  try {
    store = await Store.open(runtime.url, 3);
    const nutrition = new PostgresNutrition(store.db);
    const file = join(dir, 'nutrition', 'mfp-export.json');
    await mkdir(join(dir, 'nutrition'));
    const exportFile = (foods: unknown[]) =>
      writeFile(file, JSON.stringify({ version: 1, source: 'myfitnesspal', foods }));
    await exportFile([
      {
        external_id: 'diary:egg-large',
        name: 'Egg',
        serving_amount: 1,
        serving_unit: 'large',
        calories: 72,
        protein: 6.3,
      },
      {
        external_id: 'recipe:1',
        kind: 'recipe',
        name: 'Chicken soup',
        calories: 250,
        ingredients: ['1 chicken breast'],
      },
    ]);
    const sync = new NutritionCatalogSync(nutrition, file, 'owner');
    const tools = new Tools({ audit: async () => {} } as any);
    registerNutritionTools(tools, nutrition, sync, 'owner', () => 'America/Lima');
    const ctx = { session: 's', jobId: 'j', signal: new AbortController().signal };
    const call = (name: string, args: unknown) => tools.call(name, args, ctx) as Promise<any>;

    const found = await call('food_search', { query: 'egg' });
    assert.equal(found.total, 1);
    const egg = found.items[0];
    assert.equal(egg.serving_unit, 'large');
    assert.equal(
      (await call('food_search', { query: '', kind: 'recipe' })).items[0].name,
      'Chicken soup',
    );

    // Re-exporting updates in place and adds new foods.
    await exportFile([
      {
        external_id: 'diary:egg-large',
        name: 'Egg',
        serving_amount: 1,
        serving_unit: 'large',
        calories: 70,
      },
      {
        external_id: 'diary:rice',
        name: 'White rice',
        serving_amount: 100,
        serving_unit: 'g',
        calories: 130,
      },
    ]);
    assert.equal((await call('food_search', { query: '' })).total, 3);

    const logged = await call('food_log', {
      food_id: egg.id,
      servings: 2,
      meal: 'breakfast',
      eaten_at: '2026-11-15T13:00:00Z',
    });
    assert.equal(logged.day, '2026-11-15');
    assert.equal(logged.nutrients.calories, 140);
    const saved = await call('food_save', {
      name: 'Arepa',
      serving_unit: 'unit',
      nutrients: { calories: 180, carbohydrates: 30 },
    });
    assert.deepEqual(
      await call('food_save', {
        name: 'Arepa',
        serving_unit: 'unit',
        nutrients: { calories: 190 },
      }),
      saved,
    );
    await call('food_log', {
      name: 'Coffee with milk',
      nutrients: { calories: 60 },
      meal: 'breakfast',
      eaten_at: '2026-11-15T14:00:00Z',
    });
    const diary = await call('food_diary', { start: '2026-11-15' });
    assert.equal(diary.entries.length, 2);
    assert.equal(diary.totals.calories, 200);
    assert.equal(diary.totals.carbohydrates, null);
    const range = await call('food_diary', { start: '2026-11-14', end: '2026-11-16' });
    assert.equal(range.logged_days, 1);
    // Searches rank foods the user logs most first.
    assert.equal((await call('food_search', { query: '' })).items[0].name, 'Egg');

    await assert.rejects(
      call('food_log_delete', { entry_ids: [diary.entries[0].entry_id, '999'] }),
      /nothing was deleted/,
    );
    assert.equal(
      (await call('food_log_delete', { entry_ids: [diary.entries[0].entry_id] })).deleted,
      1,
    );
    assert.equal((await call('food_diary', { start: '2026-11-15' })).totals.calories, 60);
  } finally {
    await store?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
