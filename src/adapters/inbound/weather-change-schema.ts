import { z } from 'zod';
import { forecastFields } from '../../domain/weather-change.js';
const period = z.partialRecord(
  z.enum(forecastFields),
  z.union([z.string().max(40), z.number().finite(), z.null()]),
);
export const weatherChangeSchema = z
  .object({
    entity_id: z
      .string()
      .regex(/^weather\.[a-z0-9_]+$/)
      .max(200),
    units: z
      .object({
        temperature: z.string().max(16).optional(),
        precipitation: z.string().max(16).optional(),
        wind_speed: z.string().max(16).optional(),
        pressure: z.string().max(16).optional(),
      })
      .strict(),
    changes: z
      .array(
        z
          .object({
            datetime: z.iso.datetime({ offset: true }),
            before: period.nullable(),
            after: period.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    truncated: z.boolean(),
  })
  .strict();
