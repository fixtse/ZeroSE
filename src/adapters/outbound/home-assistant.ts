import { jsonRequest, jsonBody } from './http.js';
import { dailyWeatherEntity } from './weather-entity.js';
import type { Config } from '../../domain/config.js';

export class HomeAssistant {
  constructor(private config: Config['homeAssistant']) {}
  async location(signal?: AbortSignal) {
    const entities = [this.config.locationEntity, this.config.geocodedLocationEntity];
    if (!entities.some(Boolean)) throw new Error('Location entities are not configured');
    const results = await Promise.allSettled(
      entities.map((entity) =>
        entity ? this.request('states/' + encodeURIComponent(entity), undefined, signal) : null,
      ),
    );
    signal?.throwIfAborted();
    const observedAt = new Date().toISOString();
    const source = (index: number) => {
      const result = results[index]!;
      if (!entities[index]) return null;
      if (result.status === 'rejected')
        return {
          entity_id: entities[index],
          available: false,
          error: 'Location source could not be retrieved',
        };
      const value = result.value;
      const state = typeof value?.state === 'string' ? value.state.trim() : '';
      const available = !!state && !['unknown', 'unavailable'].includes(state.toLowerCase());
      const timestamp = value?.last_reported || value?.last_updated;
      const age = Date.parse(observedAt) - Date.parse(timestamp);
      const attributes = value?.attributes || {};
      const placemark = attributes.location ?? attributes.Location;
      const latitude = attributes.latitude ?? (Array.isArray(placemark) ? placemark[0] : undefined),
        longitude = attributes.longitude ?? (Array.isArray(placemark) ? placemark[1] : undefined);
      const coordinates =
        available &&
        typeof latitude === 'number' &&
        Number.isFinite(latitude) &&
        Math.abs(latitude) <= 90 &&
        typeof longitude === 'number' &&
        Number.isFinite(longitude) &&
        Math.abs(longitude) <= 180
          ? {
              latitude,
              longitude,
              ...(typeof attributes.gps_accuracy === 'number' &&
              Number.isFinite(attributes.gps_accuracy) &&
              attributes.gps_accuracy >= 0
                ? { accuracy_m: attributes.gps_accuracy }
                : {}),
            }
          : null;
      return {
        entity_id: entities[index],
        available,
        state: available ? state : null,
        last_changed: value?.last_changed ?? null,
        last_updated: value?.last_updated ?? null,
        last_reported: value?.last_reported ?? null,
        age_seconds: Number.isFinite(age) && age >= 0 ? Math.floor(age / 1000) : null,
        coordinates,
      };
    };
    const tracker = source(0),
      geocoded = source(1);
    return {
      observed_at: observedAt,
      presence: !tracker?.available ? 'unknown' : tracker.state === 'home' ? 'home' : 'away',
      zone: !tracker?.available || tracker.state === 'not_home' ? null : tracker.state,
      tracker,
      geocoded,
    };
  }
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
    const entity =
      this.config.weatherEntity ||
      dailyWeatherEntity(await this.request('states', undefined, signal));
    return this.request(
      'services/weather/get_forecasts?return_response',
      { entity_id: entity, type: 'daily' },
      signal,
    );
  }
}
