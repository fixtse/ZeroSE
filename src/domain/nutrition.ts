export const nutrientKeys = [
  'calories',
  'protein',
  'carbohydrates',
  'fat',
  'fiber',
  'sugar',
  'sodium',
] as const;
export type NutrientKey = (typeof nutrientKeys)[number];
/** Calories in kcal, sodium in mg, other nutrients in grams. Unknown values are null. */
export type Nutrients = Record<NutrientKey, number | null>;
export type FoodKind = 'food' | 'recipe' | 'meal';
export interface FoodInput extends Nutrients {
  externalId: string;
  kind: FoodKind;
  name: string;
  brand: string;
  servingAmount: number;
  servingUnit: string;
  ingredients: string[];
}

export function emptyNutrients(): Nutrients {
  return Object.fromEntries(nutrientKeys.map((key) => [key, null])) as Nutrients;
}
const round = (value: number) => Math.round(value * 10) / 10;
export function scaleNutrients(values: Nutrients, factor: number): Nutrients {
  return Object.fromEntries(
    nutrientKeys.map((key) => [key, values[key] === null ? null : round(values[key]! * factor)]),
  ) as Nutrients;
}
export function sumNutrients(values: Nutrients[]): Nutrients {
  return Object.fromEntries(
    nutrientKeys.map((key) => {
      const known = values.map((value) => value[key]).filter((value) => value !== null);
      return [key, known.length ? round(known.reduce((total, value) => total + value!, 0)) : null];
    }),
  ) as Nutrients;
}
/** Stable identity for user-entered foods so repeating a save updates instead of duplicating. */
export function manualFoodId(name: string, servingUnit: string) {
  return (
    'manual:' +
    `${name} ${servingUnit}`
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  );
}
