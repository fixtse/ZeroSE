import type { WeatherChange } from './weather-change.js';

export interface AlertCondition {
  source?: 'sensor';
  entity_id: string;
  operator: 'above' | 'below' | 'equals';
  value: string | number;
  hold_seconds: number;
}
export interface LocationCondition {
  source: 'zone' | 'distance';
  entity_id: string;
  target_entity_id: string;
  operator: 'enter' | 'leave' | 'above' | 'below';
  distance_m?: number;
  reset_margin_m: number;
  hold_seconds: number;
  max_age_seconds: number;
  max_accuracy_m: number;
}
export function isLocationCondition(
  condition: NotificationRule['condition'],
): condition is LocationCondition {
  return condition?.source === 'zone' || condition?.source === 'distance';
}
export interface WeatherCondition {
  hourly_updates?: boolean;
  source: 'weather';
  mode?: 'any_change' | 'conditions' | 'rain';
  conditions?: string[];
  sleep_entity?: string;
  horizon_hours: number;
  minimum_probability: number;
}
export interface NotificationRule {
  weather_pending?: Partial<Record<'daily' | 'hourly', WeatherChange>>;
  managed?: 'owner_weather';
  wake_date?: string;
  id: string;
  session: string;
  kind: 'reminder' | 'timer' | 'alert';
  message: string;
  assistant_request?: string;
  status: 'active' | 'paused' | 'cancelled' | 'completed' | 'expired';
  next_at: string | null;
  repeat_seconds: number | null;
  remaining_seconds: number | null;
  condition: AlertCondition | WeatherCondition | LocationCondition | null;
  forecast_signature: string | null;
  scheduler_key?: string;
  scheduler_state?: 'installing' | 'installed' | 'uncertain';
  cooldown_seconds: number;
  recurring: boolean;
  matched_since: string | null;
  last_checked: string | null;
  last_fired: string | null;
  retired_at?: string | null;
  last_hourly_fired?: string | null;
  latched: boolean;
  version: number;
  generation: number;
}
