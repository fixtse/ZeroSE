export interface AlertCondition {
  source?: 'sensor';
  entity_id: string;
  operator: 'above' | 'below' | 'equals';
  value: string | number;
  hold_seconds: number;
}
export interface WeatherCondition {
  source: 'weather';
  mode?: 'any_change' | 'conditions' | 'rain';
  conditions?: string[];
  horizon_hours: number;
  minimum_probability: number;
}
export interface NotificationRule {
  id: string;
  session: string;
  kind: 'reminder' | 'timer' | 'alert';
  message: string;
  status: 'active' | 'paused' | 'cancelled' | 'completed' | 'expired';
  next_at: string | null;
  repeat_seconds: number | null;
  remaining_seconds: number | null;
  condition: AlertCondition | WeatherCondition | null;
  forecast_signature: string | null;
  scheduler_key?: string;
  scheduler_state?: 'installing' | 'installed' | 'uncertain';
  cooldown_seconds: number;
  recurring: boolean;
  matched_since: string | null;
  last_checked: string | null;
  last_fired: string | null;
  latched: boolean;
  version: number;
  generation: number;
}
