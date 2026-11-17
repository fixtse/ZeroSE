/**
 * Calorie tracking. The food catalog and diary live in the Home Assistant `calorie_tracker`
 * integration, which also syncs MyFitnessPal; Zero only reads and writes through it.
 */
export type FoodKind = 'food' | 'recipe' | 'meal';
export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export interface MacroTargets {
  calories?: number;
  protein?: number;
  carbohydrates?: number;
  fat?: number;
}
export interface Nutrients extends MacroTargets {
  fiber?: number;
  sugar?: number;
  sodium?: number;
}
export interface FoodLogRequest {
  meal: Meal;
  foodId?: string;
  servings?: number;
  quantity?: number;
  unit?: string;
  name?: string;
  nutrients?: Nutrients;
  eatenAt?: string;
}
export interface NutritionPort {
  search(
    query: string,
    kind: FoodKind | undefined,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
  food(id: string, signal?: AbortSignal): Promise<unknown>;
  recommend(
    targets: MacroTargets,
    kind: FoodKind | undefined,
    query: string,
    limit: number,
    meal: Meal | undefined,
    since: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown>;
  goals(signal?: AbortSignal): Promise<unknown>;
  setGoals(
    goals: MacroTargets & { caloriePeriod?: 'day' | 'week'; recommendSince?: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
  log(entry: FoodLogRequest, signal?: AbortSignal): Promise<unknown>;
  diary(start: string | undefined, end: string | undefined, signal?: AbortSignal): Promise<unknown>;
  save(
    food: {
      name: string;
      brand: string;
      servingAmount: number;
      servingUnit: string;
      nutrients: Nutrients;
      kind?: FoodKind;
      ingredients?: string[];
      instructions?: string[];
      recipeServings?: number;
    },
    signal?: AbortSignal,
  ): Promise<unknown>;
  deleteEntries(ids: string[], signal?: AbortSignal): Promise<unknown>;
  updateEntry(change: FoodEntryUpdate, signal?: AbortSignal): Promise<unknown>;
  copyDay(
    copy: { from: string; to?: string; meals?: Meal[]; toMeal?: Meal },
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export type FoodEntryUpdate = {
  entryId: string;
  meal?: Meal;
  name?: string;
  servings?: number;
  quantity?: number;
  unit?: string;
  nutrients?: Partial<Nutrients>;
  eatenAt?: string;
};
