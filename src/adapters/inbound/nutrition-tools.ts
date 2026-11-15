import { z } from 'zod';
import { Tools } from '../../application/tool-registry.js';
import { jsonPage } from '../../application/context-budget.js';
import type { NutritionPort } from '../../application/nutrition.js';
import type { NutritionCatalogSync } from '../../application/nutrition-catalog.js';
import { localClock } from '../../domain/time.js';
import { manualFoodId, nutrientKeys, type Nutrients } from '../../domain/nutrition.js';

const id = z.string().regex(/^[1-9]\d{0,18}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const meal = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);
const value = z.number().finite().min(0).max(100_000);
const nutrients = z.object({
  calories: value,
  protein: value.optional(),
  carbohydrates: value.optional(),
  fat: value.optional(),
  fiber: value.optional(),
  sugar: value.optional(),
  sodium: value.optional().describe('mg'),
});
const complete = (input: z.infer<typeof nutrients>) =>
  Object.fromEntries(nutrientKeys.map((key) => [key, input[key] ?? null])) as Nutrients;
const page = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(25).default(10),
  result_offset: z.number().int().min(0).default(0),
};

export function registerNutritionTools(
  tools: Tools,
  nutrition: NutritionPort,
  catalog: NutritionCatalogSync,
  profile: string,
  timezone: () => string,
) {
  const today = () => localClock(new Date(), timezone()).day;
  tools.add(
    'food_search',
    "Search the user's food catalog (imported MyFitnessPal foods, recipes and meals, plus saved foods) by words in name/brand. Most-logged first. Values are per listed serving. Use before food_log.",
    z.object({
      query: z.string().trim().max(200).default(''),
      kind: z.enum(['food', 'recipe', 'meal']).optional(),
      ...page,
    }),
    async (a) => {
      await catalog.sync();
      return jsonPage(
        await nutrition.searchFoods(profile, a.query, a.kind, a.offset, a.limit),
        a.result_offset,
      );
    },
  );
  tools.add(
    'food_get',
    'Read one catalog food with all nutrients per serving and recipe ingredients.',
    z.object({ food_id: id, result_offset: page.result_offset }),
    async (a) => jsonPage(await nutrition.food(profile, a.food_id), a.result_offset),
  );
  tools.add(
    'food_save',
    'Save or update a custom food in the catalog when the user asks or gives nutrition for something not found. Nutrients are per serving_amount serving_unit. Same name and unit updates the existing food.',
    z.object({
      name: z.string().trim().min(1).max(200),
      brand: z.string().trim().max(200).default(''),
      serving_amount: z.number().finite().positive().max(100_000).default(1),
      serving_unit: z.string().trim().min(1).max(50).default('serving'),
      nutrients,
    }),
    async (a) =>
      nutrition.saveFood(profile, {
        externalId: manualFoodId(a.name + ' ' + a.brand, a.serving_unit),
        kind: 'food',
        name: a.name,
        brand: a.brand,
        servingAmount: a.serving_amount,
        servingUnit: a.serving_unit,
        ingredients: [],
        ...complete(a.nutrients),
      }),
  );
  tools.add(
    'food_log',
    "Record food the user ate in their diary. Prefer food_id from food_search; servings multiplies that food's serving. Without a catalog match pass name and nutrients for the whole serving, and tell the user they are estimates. Returns the entry and the day's totals. Do not repeat after an uncertain failure; check food_diary.",
    z
      .object({
        food_id: id.optional(),
        name: z.string().trim().min(1).max(200).optional(),
        nutrients: nutrients.optional(),
        servings: z.number().finite().positive().max(100).default(1),
        meal,
        eaten_at: z.iso.datetime({ offset: true }).optional(),
      })
      .refine(
        (a) => a.food_id || (a.name && a.nutrients),
        'Provide food_id or name with nutrients',
      ),
    async (a) => {
      const eatenAt = a.eaten_at ? new Date(a.eaten_at) : new Date();
      return nutrition.log(profile, {
        foodId: a.food_id,
        name: a.name,
        nutrients: a.nutrients && complete(a.nutrients),
        servings: a.servings,
        meal: a.meal,
        eatenAt,
        day: localClock(eatenAt, timezone()).day,
      });
    },
  );
  tools.add(
    'food_diary',
    "Read the user's food diary. With only start (default today) returns that day's entries and totals; with end returns per-day totals and the daily average for the range (max 92 days).",
    z
      .object({ start: day.optional(), end: day.optional(), result_offset: page.result_offset })
      .refine((a) => !a.end || !a.start || a.end >= a.start, 'Invalid date interval'),
    async (a) => {
      const start = a.start || today();
      if (!a.end || a.end === start)
        return jsonPage(await nutrition.day(profile, start), a.result_offset);
      if (Date.parse(a.end) - Date.parse(start) > 92 * 86_400_000)
        throw new Error('Range is limited to 92 days');
      return jsonPage(await nutrition.range(profile, start, a.end), a.result_offset);
    },
  );
  tools.add(
    'food_log_delete',
    'Delete diary entries only when the user asks to remove or correct them. Read food_diary first and pass exact entry IDs.',
    z.object({ entry_ids: z.array(id).min(1).max(20) }),
    async (a) => ({ deleted: await nutrition.deleteEntries(profile, a.entry_ids) }),
  );
}
