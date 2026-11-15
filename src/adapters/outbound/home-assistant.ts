import { homeAssistantCommand } from './home-assistant-socket.js';
import { personDistance } from '../../domain/location-distance.js';
import { HomeAssistantExposure } from './home-assistant-exposure.js';
import { jsonRequest, jsonBody } from './http.js';
import type { AdminCatalogQuery } from '../../application/admin-catalog.js';
import { dailyWeatherEntity } from './weather-entity.js';
import type { Config } from '../../domain/config.js';

export class HomeAssistant {
  private exposure: HomeAssistantExposure;
  constructor(
    private config: Config['homeAssistant'],
    command = homeAssistantCommand,
  ) {
    this.exposure = new HomeAssistantExposure(config, command);
  }
  async assertExposed(entities: string[], signal?: AbortSignal, control = false) {
    await this.exposure.assert(entities, signal, control);
  }
  private async exposedStates(signal?: AbortSignal, assignment = false) {
    const states = await this.request('states', undefined, signal);
    const allowed = await this.exposure.filter(
      states.map((state: any) => state.entity_id),
      signal,
      false,
      assignment,
    );
    return states.filter((state: any) => allowed.has(state.entity_id));
  }
  async assistCommand(command: Record<string, unknown>, signal?: AbortSignal) {
    if (!this.config.token) throw new Error('Home Assistant token is not configured');
    return homeAssistantCommand(this.config, command, signal ?? AbortSignal.timeout(15000));
  }
  async services(
    signal?: AbortSignal,
  ): Promise<{ domain: string; services: Record<string, unknown> }[]> {
    return this.request('services', undefined, signal);
  }
  async entityCatalog(query: AdminCatalogQuery, signal: AbortSignal) {
    const assignment = query.purpose === 'location-assignment';
    if (
      assignment &&
      (!query.domains ||
        query.domains
          .split(',')
          .some((domain) => !['person', 'device_tracker', 'sensor'].includes(domain)))
    )
      throw new Error('Location assignment discovery requires scoped location domains');
    const states = await this.exposedStates(signal, assignment);
    const items = states
      .map((state: any) => {
        const id = String(state.entity_id);
        const access: string[] = [];
        if (/^(sensor|binary_sensor)\./.test(id)) access.push('sensor');
        if (/^(person|device_tracker|zone)\./.test(id)) access.push('location alerts');
        if (!assignment) access.push('Assist');
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
  /** Call a service that returns data (HA `return_response`). */
  async serviceResponse(service: string, data: Record<string, unknown>, signal?: AbortSignal) {
    if (!/^[a-z_]+\.[a-z_]+$/.test(service)) throw new Error('Invalid service');
    const result = await this.request(
      'services/' + service.replace('.', '/') + '?return_response',
      data,
      signal,
    );
    return result?.service_response;
  }
  async location(signal?: AbortSignal) {
    const entities = [this.config.locationEntity, this.config.geocodedLocationEntity];
    if (!entities.some(Boolean)) throw new Error('Location entities are not configured');
    await this.assertExposed(entities.filter(Boolean), signal);
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
    const coordinateSource = [tracker, geocoded]
      .filter((source) => source?.coordinates)
      .sort((a, b) => (a?.age_seconds ?? Infinity) - (b?.age_seconds ?? Infinity))[0];
    const zone = !tracker?.available || tracker.state === 'not_home' ? null : tracker.state;
    const address = geocoded?.available ? geocoded.state : null;
    return {
      location_available: !!(coordinateSource?.coordinates || zone || address),
      coordinates: coordinateSource?.coordinates ?? null,
      coordinates_source: coordinateSource?.entity_id ?? null,
      coordinates_age_seconds: coordinateSource?.age_seconds ?? null,
      coordinates_current:
        !!coordinateSource?.available &&
        coordinateSource.age_seconds != null &&
        coordinateSource.age_seconds <= 3600 &&
        (coordinateSource.coordinates?.accuracy_m ?? 0) <= 200,
      address,
      observed_at: observedAt,
      presence: !tracker?.available ? 'unknown' : tracker.state === 'home' ? 'home' : 'away',
      zone,
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
  async locationEntities(search: string, offset: number, limit: number, signal?: AbortSignal) {
    const states = await this.exposedStates(signal);
    const items = states
      .filter((s: any) => /^(person|device_tracker|zone)\.[a-z0-9_]+$/.test(s.entity_id))
      .map((s: any) => ({
        entity_id: s.entity_id,
        name: String(s.attributes?.friendly_name || s.entity_id).slice(0, 200),
      }))
      .filter((s: any) => (s.entity_id + ' ' + s.name).toLowerCase().includes(search.toLowerCase()))
      .sort((a: any, b: any) => a.entity_id.localeCompare(b.entity_id));
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      next_offset: offset + limit < items.length ? offset + limit : null,
    };
  }
  async locationEntity(entity: string, signal?: AbortSignal) {
    if (!/^(person|device_tracker|zone)\.[a-z0-9_]+$/.test(entity))
      throw new Error('Location entity is not permitted');
    await this.assertExposed([entity], signal);
    const state = await this.request('states/' + encodeURIComponent(entity), undefined, signal);
    return {
      entity_id: state.entity_id,
      state: state.state,
      last_updated: state.last_updated,
      last_reported: state.last_reported,
      attributes: Object.fromEntries(
        ['friendly_name', 'latitude', 'longitude', 'gps_accuracy', 'radius']
          .filter((key) => key in (state.attributes || {}))
          .map((key) => [key, state.attributes[key]]),
      ),
    };
  }
  async distance(first: string, second: string, signal?: AbortSignal) {
    if (first === second) throw new Error('Choose two different people');
    for (const entity of [first, second])
      if (!/^(person|device_tracker)\.[a-z0-9_]+$/.test(entity))
        throw new Error('Person entity is not permitted');
    await this.assertExposed([first, second], signal);
    const [a, b] = await Promise.all([
      this.locationEntity(first, signal),
      this.locationEntity(second, signal),
    ]);
    return personDistance(a, b);
  }
  async sensors(search = '', signal?: AbortSignal) {
    const states = await this.exposedStates(signal);
    return states.filter(
      (s: any) =>
        /^(sensor|binary_sensor)\.[a-z0-9_]+$/.test(s.entity_id) &&
        `${s.entity_id} ${s.attributes?.friendly_name || ''}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    );
  }
  async sensor(entity: string, signal?: AbortSignal) {
    if (!/^(sensor|binary_sensor)\.[a-z0-9_]+$/.test(entity))
      throw new Error('Sensor entity is not permitted');
    await this.assertExposed([entity], signal);
    return this.request('states/' + encodeURIComponent(entity), undefined, signal);
  }
  async history(entity: string, start: string, end: string, signal?: AbortSignal) {
    if (!/^(sensor|binary_sensor)\.[a-z0-9_]+$/.test(entity))
      throw new Error('Sensor entity is not permitted');
    await this.assertExposed([entity], signal);
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
    await this.assertExposed([entity], signal);
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
    await this.assertExposed([this.config.shoppingListEntity], signal, true);
    const before = await this.shopping(signal);
    if (operation === 'add') {
      await this.assertExposed([this.config.shoppingListEntity], signal, true);
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
    await this.assertExposed([this.config.shoppingListEntity], signal, true);
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
  async weatherSource(signal?: AbortSignal) {
    return this.config.weatherEntity || dailyWeatherEntity(await this.exposedStates(signal));
  }
  async forecast(signal?: AbortSignal, type: 'daily' | 'hourly' = 'daily') {
    const entity = await this.weatherSource(signal);
    await this.assertExposed([entity], signal);
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
