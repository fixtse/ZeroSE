import type { DataPage } from './personal-data.js';
import type { FoodInput, FoodKind, Nutrients } from '../domain/nutrition.js';

export interface FoodLogInput {
  foodId?: string;
  name?: string;
  servings: number;
  meal: string;
  eatenAt: Date;
  day: string;
  nutrients?: Nutrients;
}
export interface NutritionPort {
  importFoods(profile: string, source: string, foods: FoodInput[]): Promise<number>;
  saveFood(profile: string, food: FoodInput): Promise<{ id: string }>;
  searchFoods(
    profile: string,
    query: string,
    kind: FoodKind | undefined,
    offset: number,
    limit: number,
  ): Promise<DataPage>;
  food(profile: string, id: string): Promise<unknown>;
  log(profile: string, entry: FoodLogInput): Promise<unknown>;
  day(profile: string, day: string): Promise<unknown>;
  range(profile: string, start: string, end: string): Promise<unknown>;
  deleteEntries(profile: string, ids: string[]): Promise<number>;
}
