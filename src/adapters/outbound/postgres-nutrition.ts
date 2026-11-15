import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Database } from './database.js';
import { nutritionEntries as entries, nutritionFoods as foods } from './database-schema.js';
import type { FoodLogInput, NutritionPort } from '../../application/nutrition.js';
import {
  nutrientKeys,
  scaleNutrients,
  sumNutrients,
  type FoodInput,
  type FoodKind,
  type Nutrients,
} from '../../domain/nutrition.js';

const nutrientsOf = (row: Record<NutrientKeyRow, number | null>): Nutrients =>
  Object.fromEntries(nutrientKeys.map((key) => [key, row[key]])) as Nutrients;
type NutrientKeyRow = (typeof nutrientKeys)[number];
const row = (profile: string, source: string, food: FoodInput) => ({
  profile,
  source,
  external_id: food.externalId,
  kind: food.kind,
  name: food.name,
  brand: food.brand,
  serving_amount: food.servingAmount,
  serving_unit: food.servingUnit,
  ingredients: food.ingredients,
  ...Object.fromEntries(nutrientKeys.map((key) => [key, food[key]])),
});
const serving = (amount: number, unit: string) =>
  `${Number.isInteger(amount) ? amount : Number(amount.toFixed(2))} ${unit}`.trim();
const pageOf = <T>(items: T[], total: number, offset: number) => ({
  items,
  total,
  next_offset: offset + items.length < total ? offset + items.length : null,
});

export class PostgresNutrition implements NutritionPort {
  constructor(private db: Database) {}
  async importFoods(profile: string, source: string, list: FoodInput[]) {
    let changed = 0;
    for (let index = 0; index < list.length; index += 200) {
      const chunk = list.slice(index, index + 200);
      if (!chunk.length) continue;
      const rows = await this.db
        .insert(foods)
        .values(chunk.map((food) => row(profile, source, food)))
        .onConflictDoUpdate({
          target: [foods.profile, foods.source, foods.external_id],
          set: {
            kind: sql`excluded.kind`,
            name: sql`excluded.name`,
            brand: sql`excluded.brand`,
            serving_amount: sql`excluded.serving_amount`,
            serving_unit: sql`excluded.serving_unit`,
            ingredients: sql`excluded.ingredients`,
            ...Object.fromEntries(nutrientKeys.map((key) => [key, sql.raw(`excluded.${key}`)])),
            updated: sql`now()`,
          },
        })
        .returning({ id: foods.id });
      changed += rows.length;
    }
    return changed;
  }
  async saveFood(profile: string, food: FoodInput) {
    await this.importFoods(profile, 'manual', [food]);
    const [saved] = await this.db
      .select({ id: sql<string>`${foods.id}::text` })
      .from(foods)
      .where(
        and(
          eq(foods.profile, profile),
          eq(foods.source, 'manual'),
          eq(foods.external_id, food.externalId),
        ),
      );
    return saved;
  }
  async searchFoods(
    profile: string,
    query: string,
    kind: FoodKind | undefined,
    offset: number,
    limit: number,
  ) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const haystack = sql`lower(${foods.name} || ' ' || ${foods.brand})`;
    const filter = and(
      eq(foods.profile, profile),
      kind ? eq(foods.kind, kind) : undefined,
      ...words.map((word) => sql`strpos(${haystack}, ${word}) > 0`),
    );
    const usage = sql<number>`(select count(*) from ${entries} where ${entries.food_id} = ${foods.id})`;
    const items = await this.db
      .select({
        id: sql<string>`${foods.id}::text`,
        kind: foods.kind,
        name: foods.name,
        brand: foods.brand,
        serving_amount: foods.serving_amount,
        serving_unit: foods.serving_unit,
        calories: foods.calories,
        protein: foods.protein,
        carbohydrates: foods.carbohydrates,
        fat: foods.fat,
        source: foods.source,
      })
      .from(foods)
      .where(filter)
      .orderBy(desc(usage), asc(sql`length(${foods.name})`), asc(foods.name))
      .offset(offset)
      .limit(limit);
    const [{ total }] = await this.db.select({ total: count() }).from(foods).where(filter);
    return pageOf(items, total, offset);
  }
  async food(profile: string, id: string) {
    const [found] = await this.db
      .select()
      .from(foods)
      .where(and(eq(foods.profile, profile), eq(foods.id, BigInt(id))));
    if (!found) throw new Error('Food not found');
    return {
      id: String(found.id),
      kind: found.kind,
      name: found.name,
      brand: found.brand,
      source: found.source,
      serving: serving(found.serving_amount, found.serving_unit),
      nutrients_per_serving: nutrientsOf(found),
      ingredients: found.ingredients,
    };
  }
  async log(profile: string, entry: FoodLogInput) {
    let name = entry.name?.trim() || '';
    let label = '';
    let perServing = entry.nutrients;
    let foodId: bigint | null = null;
    if (entry.foodId) {
      const [found] = await this.db
        .select()
        .from(foods)
        .where(and(eq(foods.profile, profile), eq(foods.id, BigInt(entry.foodId))));
      if (!found) throw new Error('Food not found; search the catalog first');
      foodId = found.id;
      name ||= found.name + (found.brand ? ` (${found.brand})` : '');
      label = serving(found.serving_amount, found.serving_unit);
      perServing = nutrientsOf(found);
    }
    if (!perServing || !name) throw new Error('Provide food_id or a name with nutrients');
    const [saved] = await this.db
      .insert(entries)
      .values({
        profile,
        food_id: foodId,
        name,
        meal: entry.meal,
        servings: entry.servings,
        serving_label: label,
        day: entry.day,
        eaten_at: entry.eatenAt,
        ...scaleNutrients(perServing, entry.servings),
      })
      .returning();
    return {
      entry_id: String(saved.id),
      name: saved.name,
      day: saved.day,
      meal: saved.meal,
      servings: saved.servings,
      serving: label || undefined,
      nutrients: nutrientsOf(saved),
      day_totals: (await this.totals(profile, entry.day, entry.day))[0]?.totals,
    };
  }
  private async totals(profile: string, start: string, end: string) {
    const rows = await this.db
      .select()
      .from(entries)
      .where(and(eq(entries.profile, profile), gte(entries.day, start), lte(entries.day, end)))
      .orderBy(asc(entries.day), asc(entries.eaten_at), asc(entries.id));
    const days = new Map<string, (typeof rows)[number][]>();
    for (const item of rows) days.set(item.day, [...(days.get(item.day) || []), item]);
    return [...days].map(([day, items]) => ({
      day,
      items,
      totals: sumNutrients(items.map(nutrientsOf)),
    }));
  }
  async day(profile: string, day: string) {
    const [found] = await this.totals(profile, day, day);
    return {
      day,
      totals: found?.totals || sumNutrients([]),
      entries: (found?.items || []).map((item) => ({
        entry_id: String(item.id),
        meal: item.meal,
        name: item.name,
        servings: item.servings,
        serving: item.serving_label || undefined,
        eaten_at: item.eaten_at.toISOString(),
        calories: item.calories,
        protein: item.protein,
        carbohydrates: item.carbohydrates,
        fat: item.fat,
      })),
    };
  }
  async range(profile: string, start: string, end: string) {
    const days = await this.totals(profile, start, end);
    const totals = days.map((day) => day.totals);
    const average = sumNutrients(totals);
    return {
      start,
      end,
      logged_days: days.length,
      daily_average: days.length ? scaleNutrients(average, 1 / days.length) : null,
      days: days.map(({ day, items, totals }) => ({ day, entries: items.length, totals })),
    };
  }
  async deleteEntries(profile: string, ids: string[]) {
    return this.db.transaction(async (client) => {
      const unique = [...new Set(ids)].map(BigInt);
      const rows = await client
        .delete(entries)
        .where(and(eq(entries.profile, profile), inArray(entries.id, unique)))
        .returning({ id: entries.id });
      if (rows.length !== unique.length)
        throw new Error('Every entry must exist in this diary; nothing was deleted');
      return rows.length;
    });
  }
}
