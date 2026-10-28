import type { Coordinates, Place, PlacesPort } from '../../application/places.js';
import { mapsPlace, mapsDirections } from '../../application/places.js';
import { jsonRequest } from './http.js';

/** Public OSM services for low-volume personal use; endpoints can be self-hosted. */
export class OpenStreetMapPlaces implements PlacesPort {
  private lastRequest = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private photonUrl = 'https://photon.komoot.io',
    private osrmUrl = 'https://router.project-osrm.org',
  ) {}
  configure(photonUrl: string, osrmUrl: string) {
    this.photonUrl = photonUrl;
    this.osrmUrl = osrmUrl;
  }
  private request(url: string, signal: AbortSignal) {
    // Serialize and rate-limit across all chats, not just one tool instance.
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted();
        const delay = Math.max(0, this.lastRequest + 1100 - Date.now());
        if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
        this.lastRequest = Date.now();
        return jsonRequest(
          url,
          {
            signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
            headers: {
              'User-Agent': 'FixtAssistant/0.1 (personal assistant; OpenStreetMap lookup)',
            },
          },
          'OpenStreetMap provider',
        );
      });
    this.queue = work;
    return work;
  }
  async search(
    query: string,
    near: Coordinates | undefined,
    limit: number,
    signal: AbortSignal,
  ): Promise<Place[]> {
    // Photon demo supports only default/de/en/fr; omit lang to preserve local place names.
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (near) {
      params.set('lat', String(near.latitude));
      params.set('lon', String(near.longitude));
    }
    const data = await this.request(this.photonUrl.replace(/\/$/, '') + '/api/?' + params, signal);
    return (data.features || [])
      .flatMap((feature: any) => {
        const p = feature.properties || {},
          [longitude, latitude] = feature.geometry?.coordinates || [];
        if (
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude) ||
          Math.abs(latitude) > 90 ||
          Math.abs(longitude) > 180
        )
          return [];
        const address = [
          p.street,
          p.housenumber,
          p.postcode,
          p.city || p.town || p.village,
          p.state,
          p.country,
        ]
          .filter(Boolean)
          .join(', ');
        const osmType = ({ N: 'node', W: 'way', R: 'relation' } as Record<string, string>)[
          p.osm_type
        ];
        return [
          {
            name: p.name || address || query,
            address,
            coordinates: { latitude, longitude },
            maps_url: mapsPlace(`${latitude},${longitude}`),
            source_url:
              osmType && /^\d+$/.test(String(p.osm_id))
                ? `https://www.openstreetmap.org/${osmType}/${p.osm_id}`
                : 'https://www.openstreetmap.org/',
          },
        ];
      })
      .slice(0, limit);
  }
  async route(
    origin: Coordinates,
    destination: Coordinates,
    mode: 'driving' | 'walking' | 'bicycling' | 'transit',
    signal: AbortSignal,
  ) {
    const maps_url = mapsDirections(origin, destination, mode);
    if (mode !== 'driving')
      return {
        maps_url,
        mode,
        duration_seconds: null,
        distance_meters: null,
        limitation:
          'This provider only estimates driving routes. Open Maps for walking, cycling or public transport.',
      };
    const point = (p: Coordinates) => `${p.longitude},${p.latitude}`;
    const data = await this.request(
      `${this.osrmUrl.replace(/\/$/, '')}/route/v1/driving/${point(origin)};${point(destination)}?overview=false&steps=false&alternatives=false`,
      signal,
    );
    const route = data.routes?.[0];
    if (
      data.code !== 'Ok' ||
      !route ||
      !Number.isFinite(route.duration) ||
      !Number.isFinite(route.distance)
    )
      throw new Error('No driving route was found');
    return {
      maps_url,
      mode,
      duration_seconds: Math.round(route.duration),
      distance_meters: Math.round(route.distance),
      traffic_aware: false,
      observed_at: new Date().toISOString(),
      attribution: '© OpenStreetMap contributors; routing by OSRM',
      limitation:
        'Estimate without live traffic, incidents or departure-time prediction. Confirm the route in Maps.',
    };
  }
}
