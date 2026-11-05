import type { Config } from '../domain/config.js';
import type { AccessProfile, ProfileNotifications } from '../domain/access.js';

export function profileNotifications(profile?: AccessProfile): ProfileNotifications {
  const minutes = profile?.notifications?.eventReminderMinutes;
  return {
    eventReminders: false,
    morning: { mode: 'off', time: '08:30', entity: '', state: 'off' },
    ...profile?.notifications,
    eventReminderMinutes:
      typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440
        ? minutes
        : 15,
    reset: profile?.notifications?.reset || { enabled: false, time: '04:00' },
  };
}
export const morningKey = (session: string, day: string) => `morning:${day}:${session}`;

export function notificationServices(config: Config, profile?: AccessProfile) {
  const allowed = (capability: 'calendar' | 'tasks') =>
    !profile || profile.capabilities.includes(capability);
  return {
    calendar:
      allowed('calendar') &&
      !!(config.google.credentials.calendar?.refreshToken || config.google.refreshToken),
    tasks:
      allowed('tasks') &&
      (config.homeAssistant.taskProvider === 'home_assistant'
        ? !!(config.homeAssistant.token && config.homeAssistant.taskListEntity)
        : !!(config.google.credentials.tasks?.refreshToken || config.google.refreshToken)),
  };
}
