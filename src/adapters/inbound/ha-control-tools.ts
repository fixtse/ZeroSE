import { z } from 'zod';
import { Tools } from '../../application/tool-registry.js';
import { jsonPage, listPage } from '../../application/context-budget.js';
import type { ZeroSettingsPort } from '../../application/zero-settings.js';
import type { HomeAssistant } from '../outbound/home-assistant.js';

export function registerHomeAssistantControl(
  tools: Tools,
  ha: HomeAssistant,
  settings: ZeroSettingsPort,
) {
  const allowed = async (service: string) => {
    const value = await settings.read();
    return (
      value.homeAssistant &&
      value.services.includes(service) &&
      (!service.startsWith('conversation.') || value.assist) &&
      (!service.startsWith('frigate.') || value.frigate)
    );
  };
  tools.add(
    'ha_services',
    'Discover explicitly allowed Home Assistant services and their field descriptions. Filter and paginate before calling a service; continue large JSON with result_offset=next_offset.',
    z.object({
      result_offset: z.number().int().min(0).default(0),
      search: z.string().max(200).default(''),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    async (a, c) => {
      const services = await ha.services(c.signal);
      const items = [];
      for (const domain of services)
        for (const [name, description] of Object.entries(domain.services)) {
          const service = domain.domain + '.' + name;
          if (service.includes(a.search) && (await allowed(service)))
            items.push({ service, description });
        }
      return jsonPage(listPage(items, a.offset, a.limit), a.result_offset);
    },
  );
  tools.add(
    'ha_service_call',
    'Call an explicitly allowed Home Assistant service for a user-requested action. Discover its fields first. Never repeat an uncertain action.',
    z.object({
      service: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
      data: z.record(z.string(), z.unknown()),
    }),
    async (a, c) => {
      if (!(await allowed(a.service))) throw new Error('Home Assistant service is not allowed');
      // Zero must not send its own request back into the Zero Assist agent.
      if (a.service === 'conversation.process' && a.data.agent_id !== 'homeassistant')
        throw new Error('Choose a separate Home Assistant conversation agent explicitly');
      await ha.callService(a.service, a.data, c.signal);
      return { accepted: true, service: a.service };
    },
  );
}
