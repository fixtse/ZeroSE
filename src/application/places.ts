export interface Coordinates {
  latitude: number;
  longitude: number;
}
export interface Place {
  name: string;
  address: string;
  coordinates: Coordinates;
  maps_url: string;
  source_url: string;
}
export interface PlacesPort {
  search(
    query: string,
    near: Coordinates | undefined,
    limit: number,
    signal: AbortSignal,
  ): Promise<Place[]>;
  route(
    origin: Coordinates,
    destination: Coordinates,
    mode: 'driving' | 'walking' | 'bicycling' | 'transit',
    signal: AbortSignal,
  ): Promise<unknown>;
}
export function mapsPlace(query: string) {
  return 'https://www.google.com/maps/search/?' + new URLSearchParams({ api: '1', query });
}
export function mapsDirections(origin: Coordinates, destination: Coordinates, mode: string) {
  const point = (p: Coordinates) => `${p.latitude},${p.longitude}`;
  return (
    'https://www.google.com/maps/dir/?' +
    new URLSearchParams({
      api: '1',
      origin: point(origin),
      destination: point(destination),
      travelmode: mode,
    })
  );
}
