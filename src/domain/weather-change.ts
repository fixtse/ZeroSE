/** Bounded forecast evidence captured at the triggering update, never refetched later. */
export const forecastFields = [
  'condition',
  'temperature',
  'templow',
  'apparent_temperature',
  'dew_point',
  'precipitation',
  'precipitation_probability',
  'wind_speed',
  'wind_gust_speed',
  'wind_bearing',
  'humidity',
  'pressure',
  'cloud_coverage',
  'uv_index',
] as const;
export interface WeatherChange {
  forecast_type?: 'daily' | 'hourly';
  entity_id: string;
  units: { temperature?: string; precipitation?: string; wind_speed?: string; pressure?: string };
  changes: {
    datetime: string;
    before: Partial<Record<(typeof forecastFields)[number], string | number | null>> | null;
    after: Partial<Record<(typeof forecastFields)[number], string | number | null>> | null;
  }[];
  truncated: boolean;
}
