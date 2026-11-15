import type { HomeAssistant } from './home-assistant.js';
import type { NutritionPort } from '../../application/nutrition.js';

const DOMAIN = 'calorie_tracker';
const defined = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''));

/** NutritionPort backed by the Home Assistant `calorie_tracker` integration's services. */
export class HomeAssistantNutrition implements NutritionPort {
  constructor(private ha: Pick<HomeAssistant, 'serviceResponse' | 'callService'>) {}
  private read(service: string, data: Record<string, unknown>, signal?: AbortSignal) {
    return this.ha.serviceResponse(`${DOMAIN}.${service}`, defined(data), signal);
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
    signal?: AbortSignal,
  ) {
    return this.read('recommend_foods', { ...targets, kind, query, limit }, signal);
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
      },
      signal,
    );
  }
  deleteEntries(ids: string[], signal?: AbortSignal) {
    return this.read('delete_entries', { entry_ids: ids }, signal);
  }
}
