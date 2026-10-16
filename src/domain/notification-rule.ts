export interface AlertCondition {
  source?: 'sensor';
  entity_id: string;
  operator: 'above' | 'below' | 'equals';
  value: string | number;
  hold_seconds: number;
}
export interface WeatherCondition {
  source: 'weather';
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
  cooldown_seconds: number;
  recurring: boolean;
  matched_since: string | null;
  last_checked: string | null;
  last_fired: string | null;
  latched: boolean;
  version: number;
  generation: number;
}

/** Only consecutive successful observations count towards an alert's hold time. */
export function evaluateRule(
  rule: NotificationRule,
  now: Date,
  state?: string,
  forecast?: { signature: string; rain: boolean },
) {
  const next = { ...rule, last_checked: now.toISOString() };
  let fire = false;
  if (rule.status !== 'active') return { rule: next, fire };
  if (rule.kind !== 'alert') {
    const due = Date.parse(rule.next_at!);
    if (due > now.getTime()) return { rule: next, fire };
    // A missed deadline is visible as expired; never replay old notifications on recovery.
    fire = now.getTime() - due <= 60_000;
    if (rule.repeat_seconds) {
      const interval = rule.repeat_seconds * 1000;
      next.next_at = new Date(
        due + (Math.floor((now.getTime() - due) / interval) + 1) * interval,
      ).toISOString();
    } else next.status = fire ? 'completed' : 'expired';
  } else if (rule.condition?.source === 'weather') {
    if (forecast) {
      const updated =
        rule.forecast_signature !== null && rule.forecast_signature !== forecast.signature;
      next.forecast_signature = forecast.signature;
      const cooled =
        !rule.last_fired ||
        now.getTime() - Date.parse(rule.last_fired) >= rule.cooldown_seconds * 1000;
      fire = updated && forecast.rain && cooled;
      if (fire && !rule.recurring) next.status = 'completed';
    }
  } else {
    const condition = rule.condition!;
    const available =
      state !== undefined && !['', 'unknown', 'unavailable'].includes(state.trim().toLowerCase());
    const numeric = available && state!.trim() !== '' && Number.isFinite(Number(state));
    const valid = condition.operator === 'equals' ? available : numeric;
    const matches =
      valid &&
      (condition.operator === 'equals'
        ? state === String(condition.value)
        : numeric &&
          (condition.operator === 'above'
            ? Number(state) > Number(condition.value)
            : Number(state) < Number(condition.value)));
    const continuous = rule.last_checked && now.getTime() - Date.parse(rule.last_checked) <= 30_000;
    if (!matches) {
      next.matched_since = null;
      // Unavailable readings break the hold but cannot rearm a latched alert.
      if (valid) next.latched = false;
    } else {
      next.matched_since =
        continuous && rule.matched_since ? rule.matched_since : now.toISOString();
      const held = now.getTime() - Date.parse(next.matched_since) >= condition.hold_seconds * 1000;
      const cooled =
        !rule.last_fired ||
        now.getTime() - Date.parse(rule.last_fired) >= rule.cooldown_seconds * 1000;
      fire = !!held && cooled && !rule.latched;
      if (fire) {
        next.latched = true;
        if (!rule.recurring) next.status = 'completed';
      }
    }
  }
  if (fire) next.last_fired = now.toISOString();
  return { rule: next, fire };
}
