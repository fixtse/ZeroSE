import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { NutritionPort } from './nutrition.js';
import { nutrientKeys, type FoodInput } from '../domain/nutrition.js';

const amount = z.number().finite().min(0).nullable().optional();
const ExportFood = z.object({
  external_id: z.string().min(1).max(300),
  kind: z.enum(['food', 'recipe', 'meal']).default('food'),
  name: z.string().trim().min(1).max(300),
  brand: z.string().max(200).nullish(),
  serving_amount: z.number().finite().positive().nullish(),
  serving_unit: z.string().max(100).nullish(),
  ingredients: z.array(z.string().max(500)).max(200).nullish(),
  ...Object.fromEntries(nutrientKeys.map((key) => [key, amount])),
});
export const NutritionExport = z.object({
  version: z.literal(1),
  source: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/),
  foods: z.array(z.unknown()).max(100_000),
});

/** Parse an exporter file. Invalid individual foods are skipped rather than failing the import. */
export function parseNutritionExport(raw: unknown) {
  const file = NutritionExport.parse(raw);
  const foods: FoodInput[] = [];
  let skipped = 0;
  for (const candidate of file.foods) {
    const parsed = ExportFood.safeParse(candidate);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const food = parsed.data as z.infer<typeof ExportFood> & Record<string, number | null>;
    foods.push({
      externalId: food.external_id,
      kind: food.kind,
      name: food.name,
      brand: food.brand || '',
      servingAmount: food.serving_amount || 1,
      servingUnit: food.serving_unit || 'serving',
      ingredients: food.ingredients || [],
      ...(Object.fromEntries(nutrientKeys.map((key) => [key, food[key] ?? null])) as Record<
        (typeof nutrientKeys)[number],
        number | null
      >),
    });
  }
  return { source: file.source, foods, skipped };
}

/**
 * Imports the exporter's JSON file whenever it changes, so running the exporter is the only
 * step needed to add new foods. Imports are upserts and never delete foods or diary entries.
 */
export class NutritionCatalogSync {
  private imported = '';
  private running?: Promise<void>;
  constructor(
    private nutrition: NutritionPort,
    private file: string,
    private profile: string,
  ) {}
  async sync() {
    this.running ??= this.run().finally(() => (this.running = undefined));
    return this.running;
  }
  private async run() {
    let version: string;
    try {
      const info = await stat(this.file);
      version = `${info.mtimeMs}:${info.size}`;
    } catch {
      return;
    }
    if (version === this.imported) return;
    try {
      const { source, foods, skipped } = parseNutritionExport(
        JSON.parse(await readFile(this.file, 'utf8')),
      );
      const count = await this.nutrition.importFoods(this.profile, source, foods);
      console.log(JSON.stringify({ event: 'nutrition_catalog_imported', count, skipped }));
    } catch (error) {
      console.error(
        JSON.stringify({ event: 'nutrition_catalog_import_failed', error: String(error) }),
      );
    }
    this.imported = version;
  }
}
