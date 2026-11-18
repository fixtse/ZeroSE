import { z } from 'zod';
import type { AdminCatalogQuery } from '../../application/admin-catalog.js';
import type { HomeAssistant } from './home-assistant.js';
import type { FoodEntryUpdate, NutritionPort } from '../../application/nutrition.js';

const DOMAIN = 'calorie_tracker';
const defined = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''));

/** NutritionPort backed by the Home Assistant `calorie_tracker` integration's services. */
export class HomeAssistantNutrition implements NutritionPort {
  constructor(
    private ha: Pick<HomeAssistant, 'serviceResponse' | 'callService'>,
    private userId?: string,
  ) {}
  static async users(
    ha: Pick<HomeAssistant, 'serviceCatalog' | 'serviceResponse'>,
    query: AdminCatalogQuery,
    signal: AbortSignal,
  ) {
    const services = await ha.serviceCatalog(
      { search: 'calorie_tracker.list_users', offset: 0, limit: 1 },
      signal,
    );
    if (!services.items.some((item) => item.id === 'calorie_tracker.list_users'))
      return { available: false, items: [], total: 0 };
    const response = await ha.serviceResponse(
      'calorie_tracker.list_users',
      defined({ search: query.search, offset: query.offset, limit: query.limit, id: query.id }),
      signal,
    );
    const page = z
      .object({
        items: z
          .array(z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(200) }))
          .max(50),
        total: z.number().int().nonnegative(),
      })
      .parse(response);
    return { available: true, ...page };
  }
  private read(service: string, data: Record<string, unknown>, signal?: AbortSignal) {
    return this.ha.serviceResponse(
      `${DOMAIN}.${service}`,
      defined({ ...data, user_id: this.userId }),
      signal,
    );
  }
  search(
    query: string,
    kind: string | undefined,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ) {
    return this.read('search_foods', { query, kind, offset, limit }, signal);
  }
  food(id: string, signal?: AbortSignal) {
    return this.read('get_food', { food_id: id }, signal);
  }
  recommend(
    targets: Record<string, number | undefined>,
    kind: string | undefined,
    query: string,
    limit: number,
    meal: string | undefined,
    since: string | undefined,
    signal?: AbortSignal,
  ) {
    const data = defined({ ...targets, kind, query, limit, meal });
    if (since !== undefined) data.since = since; // '' disables the saved date filter
    return this.ha.serviceResponse(
      `${DOMAIN}.recommend_foods`,
      { ...data, ...(this.userId ? { user_id: this.userId } : {}) },
      signal,
    );
  }
  goals(signal?: AbortSignal) {
    return this.read('get_goals', {}, signal);
  }
  setGoals(goals: Parameters<NutritionPort['setGoals']>[0], signal?: AbortSignal) {
    const { caloriePeriod, recommendSince, ...values } = goals;
    const data = defined({ ...values, calorie_period: caloriePeriod });
    if (recommendSince !== undefined) data.recommend_since = recommendSince; // '' clears it
    return this.ha.serviceResponse(
      `${DOMAIN}.set_goals`,
      { ...data, ...(this.userId ? { user_id: this.userId } : {}) },
      signal,
    );
  }
  log(entry: Parameters<NutritionPort['log']>[0], signal?: AbortSignal) {
    return this.read(
      'log_food',
      {
        meal: entry.meal,
        food_id: entry.foodId,
        servings: entry.servings,
        quantity: entry.quantity,
        unit: entry.unit,
        name: entry.name,
        eaten_at: entry.eatenAt,
        ...entry.nutrients,
      },
      signal,
    );
  }
  diary(start: string | undefined, end: string | undefined, signal?: AbortSignal) {
    return this.read('get_diary', { start, end }, signal);
  }
  save(food: Parameters<NutritionPort['save']>[0], signal?: AbortSignal) {
    return this.read(
      'save_food',
      {
        name: food.name,
        brand: food.brand,
        serving_amount: food.servingAmount,
        serving_unit: food.servingUnit,
        ...food.nutrients,
        kind: food.kind,
        ingredients: food.ingredients,
        instructions: food.instructions,
        recipe_servings: food.recipeServings,
      },
      signal,
    );
  }
  deleteEntries(ids: string[], signal?: AbortSignal) {
    return this.read('delete_entries', { entry_ids: ids }, signal);
  }
  updateEntry(change: FoodEntryUpdate, signal?: AbortSignal) {
    return this.read(
      'update_entry',
      {
        entry_id: change.entryId,
        meal: change.meal,
        name: change.name,
        servings: change.servings,
        quantity: change.quantity,
        unit: change.unit,
        eaten_at: change.eatenAt,
        ...change.nutrients,
      },
      signal,
    );
  }
  copyDay(copy: Parameters<NutritionPort['copyDay']>[0], signal?: AbortSignal) {
    return this.read(
      'copy_day',
      { from: copy.from, to: copy.to, meals: copy.meals, to_meal: copy.toMeal },
      signal,
    );
  }
}
