import type { NotificationRule } from './notification-rule.js';

export const localSchedulerIdentity = 'zero-local-v1';

/** Fixed elapsed intervals retain their anchor; missed occurrences never catch up. */
export function localDeadline(rule: NotificationRule, now: Date, startedAt: Date) {
  const anchor = Date.parse(rule.next_at!);
  const interval = (rule.repeat_seconds || 0) * 1000;
  const due =
    interval && now.getTime() >= anchor
      ? anchor + Math.floor((now.getTime() - anchor) / interval) * interval
      : anchor;
  return {
    due: new Date(due).toISOString(),
    next: interval ? new Date(due + interval).toISOString() : null,
    missed: due < startedAt.getTime() || now.getTime() - due > 60_000,
  };
}
