import type { LocationExposureResult } from '../../application/location-exposure.js';
import type { Config } from '../../domain/config.js';
import { homeAssistantCommand } from './home-assistant-socket.js';

/** Ask HA for its effective Assist policy on every operation; never cache an allow decision. */
export class HomeAssistantExposure {
  constructor(
    private config: Config['homeAssistant'],
    private command: typeof homeAssistantCommand = homeAssistantCommand,
  ) {}
  async locations(entities: string[], confirmed: boolean): Promise<LocationExposureResult> {
    const ids = [...new Set(entities.filter(Boolean))];
    if (!ids.length) return { exposed: [] };
    if (ids.some((id) => !/^(person|device_tracker|sensor)\.[a-z0-9_]+$/.test(id)))
      throw new Error('Invalid location assignment');
    const result = await this.command(
      this.config,
      { type: 'assistant_zero/assist/expose_locations', entity_ids: ids, confirmed },
      AbortSignal.timeout(15000),
    );
    const changed = result?.exposed;
    const pending = result?.confirmationRequired;
    if (
      !result ||
      (!Array.isArray(changed) && (!Array.isArray(pending) || !pending.length)) ||
      [changed, pending].some(
        (items) =>
          items !== undefined &&
          (!Array.isArray(items) ||
            !items.every((id) => typeof id === 'string' && ids.includes(id))),
      )
    )
      throw new Error('Invalid location exposure response');
    return result;
  }
  async filter(entities: string[], signal?: AbortSignal, control = false, assignment = false) {
    const allowed = new Set<string>();
    for (let offset = 0; offset < entities.length; offset += 100) {
      const ids = entities.slice(offset, offset + 100);
      const result = await this.command(
        this.config,
        {
          type: 'assistant_zero/assist/check',
          entity_ids: ids,
          control,
          ...(assignment ? { assignment: true } : {}),
        },
        signal ?? AbortSignal.timeout(15000),
      );
      if (
        !Array.isArray(result) ||
        !result.every((id) => typeof id === 'string' && ids.includes(id))
      )
        throw new Error('Invalid Assist exposure response; upgrade the Zero HA integration');
      for (const id of result) allowed.add(id);
    }
    return allowed;
  }
  async assert(entities: string[], signal?: AbortSignal, control = false) {
    const allowed = await this.filter(entities, signal, control);
    if (entities.some((id) => !allowed.has(id)))
      throw new Error(
        'Entity is not exposed to Assist or is not permitted for this Home Assistant user',
      );
  }
}
