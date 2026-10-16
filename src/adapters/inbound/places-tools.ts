import { z } from 'zod';
import { Tools } from '../../application/tool-registry.js';
import { jsonPage } from '../../application/context-budget.js';
import type { PlacesPort } from '../../application/places.js';
const coordinates = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export function registerPlacesTools(tools: Tools, places: PlacesPort) {
  tools.add(
    'places_search',
    'Find named places and addresses in OpenStreetMap (limited business/category coverage). Include a city or use near for location bias; bias is not a radius filter. Each result includes a Maps link; preserve it when suggesting places. No reliable opening hours or ratings. For broad recommendations supplement with web search. result_offset pages JSON fragments with identical arguments.',
    z.object({
      query: z.string().trim().min(1).max(300),
      near: coordinates.optional(),
      limit: z.number().int().min(1).max(10).default(5),
      result_offset: z.number().int().min(0).default(0),
    }),
    async (a, c) =>
      jsonPage(
        {
          places: await places.search(a.query, a.near, a.limit, c.signal),
          attribution: '© OpenStreetMap contributors',
          attribution_url: 'https://www.openstreetmap.org/copyright',
        },
        a.result_offset,
      ),
  );
  tools.add(
    'route_estimate',
    'Estimate driving distance/time between explicit coordinates; no live traffic. Resolve ambiguous addresses with places_search first. Other travel modes return a Maps directions link without an estimate. Always include the Maps link.',
    z.object({
      origin: coordinates,
      destination: coordinates,
      mode: z.enum(['driving', 'walking', 'bicycling', 'transit']).default('driving'),
      result_offset: z.number().int().min(0).default(0),
    }),
    async (a, c) =>
      jsonPage(await places.route(a.origin, a.destination, a.mode, c.signal), a.result_offset),
  );
}
