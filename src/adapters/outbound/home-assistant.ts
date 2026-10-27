import { jsonRequest, jsonBody } from './http.js';
import type { AdminCatalogQuery } from '../../application/admin-catalog.js';
import { dailyWeatherEntity } from './weather-entity.js';
import type { Config } from '../../domain/config.js';

export class HomeAssistant {
  constructor(private config: Config['homeAssistant']) {}
  async services(
    signal?: AbortSignal,
  ): Promise<{ domain: string; services: Record<string, unknown> }[]> {
    return this.request('services', undefined, signal);
  }
  async entityCatalog(query: AdminCatalogQuery, signal: AbortSignal) {
    const states = await this.request('states', undefined, signal);
    const items = states
      .map((state: any) => {
        const id = String(state.entity_id);
        const access: string[] = [];
        if (this.permitted(id)) access.push('sensor');
        for (const [key, label] of [
          ['shoppingListEntity', 'shopping'],
          ['weatherEntity', 'weather'],
          ['locationEntity', 'location'],
          ['geocodedLocationEntity', 'address'],
        ] as const)
          if (this.config[key] === id) access.push(label);
        if (!this.config.weatherEntity && id.startsWith('weather.'))
          access.push('weather discovery');
        return { id, name: String(state.attributes?.friendly_name || id).slice(0, 200), access };
      })
      .filter(
        (item: { id: string }) =>
          !query.domains || query.domains.split(',').includes(item.id.split('.')[0]),
      )
      .filter((item: { id: string; name: string }) =>
        (item.id + ' ' + item.name).toLowerCase().includes(query.search.toLowerCase()),
      );
    return { items: items.slice(query.offset, query.offset + query.limit), total: items.length };
  }
  async serviceCatalog(query: AdminCatalogQuery, signal: AbortSignal) {
    const catalog = await this.services(signal);
    const items = catalog
      .flatMap((group) =>
        Object.entries(group.services).map(([key, value]) => ({
          id: group.domain + '.' + key,
          name: String((value as { name?: string })?.name || key).slice(0, 200),
        })),
      )
      .filter((item) =>
        (item.id + ' ' + item.name).toLowerCase().includes(query.search.toLowerCase()),
      );
    return { items: items.slice(query.offset, query.offset + query.limit), total: items.length };
  }
  async callService(service: string, data: Record<string, unknown>, signal?: AbortSignal) {
    if (!/^[a-z_]+\.[a-z_]+$/.test(service)) throw new Error('Invalid service');
    return this.request(
      'services/' +
        service.replace('.', '/') +
        (service === 'conversation.process' ? '?return_response' : ''),
      data,
      signal,
    );
  }
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
  async forecast(signal?: AbortSignal, type: 'daily' | 'hourly' = 'daily') {
    const entity =
      this.config.weatherEntity ||
      dailyWeatherEntity(await this.request('states', undefined, signal));
    const result = await this.request(
      'services/weather/get_forecasts?return_response',
      { entity_id: entity, type },
      signal,
    );
    if (type === 'daily') return result;
    const state = await this.request('states/' + encodeURIComponent(entity), undefined, signal);
    const forecast = result?.service_response?.[entity]?.forecast;
    if (!Array.isArray(forecast) || !forecast.length)
      throw new Error('Home Assistant did not return an hourly forecast');
    return {
      entity_id: entity,
      units: {
        temperature: state?.attributes?.temperature_unit,
        wind_speed: state?.attributes?.wind_speed_unit,
        precipitation: state?.attributes?.precipitation_unit,
      },
      forecast: forecast.slice(0, 24),
    };
  }
}
