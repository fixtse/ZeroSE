import { z } from 'zod';
import { Tools } from '../../application/tool-registry.js';
import { jsonPage } from '../../application/context-budget.js';
import type { ZeroSettingsPort } from '../../application/zero-settings.js';
import type { HomeAssistant } from '../outbound/home-assistant.js';

export function registerHomeAssistantControl(
  tools: Tools,
  ha: HomeAssistant,
  settings: ZeroSettingsPort,
) {
  const enabled = async () => {
    if (!(await settings.read()).homeAssistant)
      throw new Error('Home Assistant access is disabled');
  };
  tools.add(
    'ha_entities',
    'Discover entities exposed to Home Assistant Assist. Search and paginate; inspect an entity before controlling it.',
    z.object({
      search: z.string().max(200).default(''),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    async (a, c) => {
      await enabled();
      return ha.assistCommand({ type: 'assistant_zero/assist/entities', ...a }, c.signal);
    },
  );
  tools.add(
    'ha_entity',
    'Read the current state and attributes of an entity exposed to Assist. Continue large JSON with result_offset=next_offset.',
    z.object({
      entity_id: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/),
      result_offset: z.number().int().min(0).default(0),
    }),
    async (a, c) => {
      await enabled();
      return jsonPage(
        await ha.assistCommand(
          { type: 'assistant_zero/assist/entity', entity_id: a.entity_id },
          c.signal,
        ),
        a.result_offset,
      );
    },
  );
  tools.add(
    'ha_services',
    'Discover Home Assistant services for entities exposed to Assist and their field descriptions. Filter and paginate before calling a service; continue large JSON with result_offset=next_offset.',
    z.object({
      result_offset: z.number().int().min(0).default(0),
      search: z.string().max(200).default(''),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    async (a, c) => {
      await enabled();
      const { result_offset, ...query } = a;
      return jsonPage(
        await ha.assistCommand({ type: 'assistant_zero/assist/services', ...query }, c.signal),
        result_offset,
      );
    },
  );
  tools.add(
    'ha_service_call',
    'Call a Home Assistant service on explicit entity_id targets exposed to Assist, or an exposed named script. Discover entities and service fields first. Area/device/all targets and untargeted administrative services are unavailable. Never repeat an uncertain action.',
    z.object({
      service: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/),
      data: z.record(z.string(), z.unknown()),
    }),
    async (a, c) => {
      await enabled();
      return ha.assistCommand(
        { type: 'assistant_zero/assist/call', service: a.service, data: a.data },
        c.signal,
      );
    },
  );
}
