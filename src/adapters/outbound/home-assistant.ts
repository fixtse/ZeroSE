import { jsonRequest, jsonBody } from './http.js';
import type { Config } from '../../domain/config.js';

export class HomeAssistant {
  constructor(private config: Config['homeAssistant']) {}
  private request(endpoint: string, body?: unknown, signal?: AbortSignal) {
    if (!this.config.token) throw new Error('Home Assistant token is not configured');
    return jsonRequest(
      this.config.url.replace(/\/$/, '') + '/api/' + endpoint,
      {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : jsonBody(body)),
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          'Content-Type': 'application/json',
        },
        signal,
      },
      'Home Assistant',
    );
  }
  private permitted(entity: string) {
    return (
      /^(sensor|binary_sensor)\.[a-z0-9_]+$/.test(entity) &&
      (!this.config.sensorEntities.length || this.config.sensorEntities.includes(entity))
    );
  }
  async sensors(search = '', signal?: AbortSignal) {
    const states = await this.request('states', undefined, signal);
    return states.filter(
      (s: any) =>
        this.permitted(s.entity_id) &&
        `${s.entity_id} ${s.attributes?.friendly_name || ''}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    );
  }
  async sensor(entity: string, signal?: AbortSignal) {
    if (!this.permitted(entity)) throw new Error('Sensor entity is not permitted');
    return this.request('states/' + encodeURIComponent(entity), undefined, signal);
  }
  async history(entity: string, start: string, end: string, signal?: AbortSignal) {
    if (!this.permitted(entity)) throw new Error('Sensor entity is not permitted');
    const a = Date.parse(start),
      b = Date.parse(end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || b - a > 7 * 86400_000)
      throw new Error('Use a valid sensor history interval of at most seven days');
    const query = new URLSearchParams({
      filter_entity_id: entity,
      end_time: new Date(b).toISOString(),
      minimal_response: '',
      no_attributes: '',
    });
    return this.request(
      `history/period/${encodeURIComponent(new Date(a).toISOString())}?${query}`,
      undefined,
      signal,
    );
  }
  async shopping(signal?: AbortSignal) {
    const entity = this.config.shoppingListEntity;
    const result = await this.request(
      'services/todo/get_items?return_response',
      { entity_id: entity },
      signal,
    );
    const items = result?.service_response?.[entity]?.items;
    if (!Array.isArray(items))
      throw new Error('Home Assistant did not return the configured to-do list');
    return items;
  }
  async changeShopping(
    operation: 'add' | 'complete' | 'uncomplete' | 'remove',
    item: string,
    signal?: AbortSignal,
  ) {
    const before = await this.shopping(signal);
    if (operation === 'add') {
      await this.request(
        'services/todo/add_item',
        { entity_id: this.config.shoppingListEntity, item },
        signal,
      );
      const after = await this.shopping(signal);
      if (
        after.filter((i: any) => i.summary === item).length <=
        before.filter((i: any) => i.summary === item).length
      )
        throw new Error('Shopping-list addition could not be verified; inspect before retrying');
      return after;
    }
    const matches = before.filter((i: any) => i.uid === item || i.summary === item);
    if (matches.length !== 1) throw new Error('Use the unique item UID from shopping_list_get');
    const uid = matches[0].uid;
    const service = operation === 'remove' ? 'remove_item' : 'update_item';
    const status = operation === 'complete' ? 'completed' : 'needs_action';
    await this.request(
      `services/todo/${service}`,
      {
        entity_id: this.config.shoppingListEntity,
        item: uid,
        ...(operation === 'remove' ? {} : { status }),
      },
      signal,
    );
    const after = await this.shopping(signal),
      current = after.find((i: any) => i.uid === uid);
    if (operation === 'remove' ? !!current : current?.status !== status)
      throw new Error('Shopping-list update could not be verified; inspect before retrying');
    return after;
  }
  async forecast(signal?: AbortSignal) {
    if (!this.config.weatherEntity)
      throw new Error('Home Assistant weather entity is not configured');
    return this.request(
      'services/weather/get_forecasts?return_response',
      { entity_id: this.config.weatherEntity, type: 'daily' },
      signal,
    );
  }
}
