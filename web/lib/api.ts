import { adminPath } from './admin-path';
export class SessionExpired extends Error {}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const changed = () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('zero-admin-changed'));
  };
  const mutation = method !== 'GET' && method !== 'HEAD';
  if (mutation) changed();
  let response: Response;
  try {
    response = await fetch(adminPath(path), {
      method,
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } finally {
    // An uncertain mutation may have reached the server. Evict without replaying it.
    if (mutation) changed();
  }
  const value = await response.json();
  if (response.status === 401) {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('zero-session-expired'));
    throw new SessionExpired('Inicia sesión para continuar.');
  }
  if (!response.ok)
    throw new Error(
      value.error?.message ||
        (typeof value.error === 'string' ? value.error : value.message) ||
        'No se pudo confirmar la operación. No se ha reintentado.',
    );
  return value;
}
export interface AssistantSummary {
  id: string;
  name: string;
  revision: number;
  memoryPolicy: 'automatic' | 'explicit';
  builtin: boolean;
}
export interface AssistantDefinition extends AssistantSummary {
  prompt: string;
}
export interface Profile {
  source?: 'telegram' | 'home_assistant';
  context?: string;
  contextRevision?: number;
  bot: string;
  chatId: string;
  kind: 'user' | 'group';
  label: string;
  enabled: boolean;
  owner: boolean;
  capabilities: string[];
  hasHomeAssistant: boolean;
  assistantId?: string;
  replyLanguage?: 'en' | 'es';
  voiceReplies?: boolean;
  respondToReplies?: boolean;
  timezone?: string;
  defaultModel?: string;
  alternateModels?: string[];
  memoryMode?: 'advanced' | 'simple' | 'none';
  speech?: SpeechSettings;
  notificationsMigrationPending?: boolean;
  notifications?: {
    eventReminders: boolean;
    reset: { enabled: boolean; time: string };
    morning: { mode: 'off' | 'time' | 'entity'; time: string; entity: string; state: string };
  };
  hasGoogle?: boolean;
  google?: GoogleSettings;

  homeAssistant?: {
    connections?: { id: string; name: string; url: string }[];
    activeConnectionId?: string;
    url: string;
    tokenHint?: string;
    taskProvider?: 'google' | 'home_assistant';
    taskListEntity?: string;
    shoppingListEntity: string;
    weatherEntity: string;
    locationEntity: string;
    geocodedLocationEntity: string;
  };
}
export interface Credential {
  id: string;
  name: string;
  expiresAt: string;
  revokedAt: string | null;
  token?: string;
}
export interface Settings {
  revision: number;
  prompt: string;
  homeAssistant: boolean;
  homeAssistantUsers?: Record<string, string>;
  homeAssistantUserProfiles?: {
    userId: string;
    userName: string;
    profileName: string;
    assistantId?: string;
    profileRoute?: string;
  }[];
}
export interface Pairing {
  id: string;
  homeAssistantUrl: string;
  userId: string;
  expiresAt: string;
  state: string;
}

export interface SpeechSettings {
  stt: string;
  sttLanguage: string;
  tts: string;
  ttsLanguage: string;
  voice: string;
}
export interface GoogleCredential {
  clientId: string;
  clientSecret?: string;
  clientSecretHint?: string;
  refreshTokenHint?: string;
  refreshToken?: string;
  configured?: boolean;
}
export interface GoogleSettings extends GoogleCredential {
  destinationNames?: Partial<Record<'calendarId' | 'taskListId' | 'documentFolderId', string>>;
  calendarId: string;
  taskListId: string;
  contextDocumentId: string;
  documentFolderId: string;
  credentials: Partial<Record<'calendar' | 'tasks' | 'docs' | 'drive', GoogleCredential>>;
}
export interface CatalogPage<T> {
  items: T[];
  total: number;
  next_offset?: number | null;
}
