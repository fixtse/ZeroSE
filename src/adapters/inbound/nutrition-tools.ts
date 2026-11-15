import { z } from 'zod';
import { Tools } from '../../application/tool-registry.js';
import { jsonPage } from '../../application/context-budget.js';
import type { NutritionPort } from '../../application/nutrition.js';

const foodId = z.string().trim().min(1).max(80);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const kind = z.enum(['food', 'recipe', 'meal']).optional();
const amount = z.number().finite().min(0).max(100_000);
const macros = {
  calories: amount.optional(),
  protein: amount.optional(),
  carbohydrates: amount.optional(),
  fat: amount.optional(),
};
const nutrients = z.object({
  ...macros,
  calories: amount,
  fiber: amount.optional(),
  sugar: amount.optional(),
  sodium: amount.optional().describe('mg'),
});
const resultOffset = z.number().int().min(0).default(0);

export function registerNutritionTools(tools: Tools, nutrition: NutritionPort) {
  tools.add(
    'food_search',
    "Search the user's registered foods, recipes and saved meals (synced from MyFitnessPal plus saved foods) by name/brand words. Most used first; values are per listed serving. offset/limit; result_offset pages JSON fragments.",
    z.object({
      query: z.string().trim().max(200).default(''),
      kind,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(25).default(10),
      result_offset: resultOffset,
    }),
    async (a, c) =>
      jsonPage(
        await nutrition.search(a.query, a.kind, a.offset, a.limit, c.signal),
        a.result_offset,
      ),
  );
  tools.add(
    'food_get',
    'Read one registered food: all nutrients per serving, alternative serving sizes and ingredients.',
    z.object({ food_id: foodId, result_offset: resultOffset }),
    async (a, c) => jsonPage(await nutrition.food(a.food_id, c.signal), a.result_offset),
  );
  tools.add(
    'food_recommend',
    "Suggest the user's registered foods with portions. Without targets (\"what should I eat?\"): options that stay within this meal's share of today's remaining protein/carb/fat goals and the weekly calorie budget; none need to use them fully; pass meal. With calories/protein/carbohydrates/fat targets (any subset): closest portions that still stay within the remaining goals. Present options with portion and macros (mention when weekly calorie flexibility was used), let the user choose, then food_log with its food_id and servings. Uses the user's saved 'only foods eaten since' date unless since is given; since '' searches all history.",
    z.object({
      ...macros,
      meal: z.enum(['breakfast', 'lunch', 'dinner', 'snack']).optional(),
      since: z.union([day, z.literal('')]).optional(),
      kind,
      query: z.string().trim().max(200).default(''),
      limit: z.number().int().min(1).max(10).default(5),
      result_offset: resultOffset,
    }),
    async (a, c) =>
      jsonPage(
        await nutrition.recommend(
          { calories: a.calories, protein: a.protein, carbohydrates: a.carbohydrates, fat: a.fat },
          a.kind,
          a.query,
          a.limit,
          a.meal,
          a.since,
          c.signal,
        ),
        a.result_offset,
      ),
  );
  tools.add(
    'food_goals',
    "Read the user's daily calorie/protein/carbohydrate/fat goals, today's progress and the weekly calorie budget (today's allowance, week remaining, per day after today).",
    z.object({}),
    async (_a, c) => nutrition.goals(c.signal),
  );
  tools.add(
    'food_goals_set',
    "Set the user's daily goals when they ask. Omitted values keep their goal; 0 removes one. Calories balance across the week (Monday-Sunday) unless calorie_period is day. recommend_since (YYYY-MM-DD) limits recommendations to foods eaten on or after that date, e.g. since moving country; '' removes it.",
    z
      .object({
        ...macros,
        calorie_period: z.enum(['week', 'day']).optional(),
        recommend_since: z.union([day, z.literal('')]).optional(),
      })
      .refine(
        (a) => Object.values(a).some((v) => v !== undefined),
        'Give at least one goal or calorie_period',
      ),
    async (a, c) =>
      nutrition.setGoals(
        {
          calories: a.calories,
          protein: a.protein,
          carbohydrates: a.carbohydrates,
          fat: a.fat,
          caloriePeriod: a.calorie_period,
          recommendSince: a.recommend_since,
        },
        c.signal,
      ),
  );
  tools.add(
    'food_log',
    'Record food the user ate. meal: breakfast (desayuno), lunch (almuerzo), dinner (cena) or snack. Prefer food_id from food_search/food_recommend with servings (multiples of its serving) or quantity+unit (e.g. 250 g). Without a catalog match pass name and nutrients for the whole portion and say they are estimates. Returns the entry and day totals. Do not repeat after an uncertain failure; check food_diary.',
    z
      .object({
        meal: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
        food_id: foodId.optional(),
        servings: z.number().finite().positive().max(100).optional(),
        quantity: z.number().finite().positive().max(100_000).optional(),
        unit: z.string().trim().max(50).optional(),
        name: z.string().trim().min(1).max(200).optional(),
        nutrients: nutrients.optional(),
        eaten_at: z.iso.datetime({ offset: true }).optional(),
      })
      .refine((a) => a.food_id || (a.name && a.nutrients), 'Provide food_id or name with nutrients')
      .refine((a) => !(a.servings && a.quantity), 'Use servings or quantity, not both'),
    async (a, c) =>
      nutrition.log(
        {
          meal: a.meal,
          foodId: a.food_id,
          servings: a.servings,
          quantity: a.quantity,
          unit: a.unit,
          name: a.name,
          nutrients: a.nutrients,
          eatenAt: a.eaten_at,
        },
        c.signal,
      ),
  );
  tools.add(
    'food_diary',
    "Read the user's food diary. Only start (default today): that day's entries, per-meal and day totals. With end: per-day totals and daily average (max 366 days).",
    z
      .object({ start: day.optional(), end: day.optional(), result_offset: resultOffset })
      .refine((a) => !a.end || !a.start || a.end >= a.start, 'Invalid date interval'),
    async (a, c) => jsonPage(await nutrition.diary(a.start, a.end, c.signal), a.result_offset),
  );
  tools.add(
    'food_save',
    'Save or update a custom food when the user asks or gives nutrition for something not registered. Nutrients are per serving_amount serving_unit; same name, brand and unit updates it.',
    z.object({
      name: z.string().trim().min(1).max(200),
      brand: z.string().trim().max(200).default(''),
      serving_amount: z.number().finite().positive().max(100_000).default(1),
      serving_unit: z.string().trim().min(1).max(50).default('serving'),
      nutrients,
    }),
    async (a, c) =>
      nutrition.save(
        {
          name: a.name,
          brand: a.brand,
          servingAmount: a.serving_amount,
          servingUnit: a.serving_unit,
          nutrients: a.nutrients,
        },
        c.signal,
      ),
  );
  tools.add(
    'food_log_delete',
    'Delete diary entries only when the user asks to remove or correct them. Read food_diary first and pass exact entry IDs.',
    z.object({ entry_ids: z.array(z.string().trim().min(1).max(40)).min(1).max(20) }),
    async (a, c) => nutrition.deleteEntries(a.entry_ids, c.signal),
  );
}
