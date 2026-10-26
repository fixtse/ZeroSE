export class SessionExpired extends Error {}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (response.status === 401) throw new SessionExpired('Inicia sesión para continuar.');
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
  preset: 'standard' | 'salem';
  builtin: boolean;
}
export interface AssistantDefinition extends AssistantSummary {
  prompt: string;
}
export interface Profile {
  bot: string;
  chatId: string;
  kind: 'user' | 'group';
  label: string;
  enabled: boolean;
  owner: boolean;
  capabilities: string[];
  hasHomeAssistant: boolean;
  assistantId?: string;
  voiceReplies?: boolean;
  timezone?: string;
  memoryMode?: 'advanced' | 'simple' | 'none';
  speech?: SpeechSettings;
  hasGoogle?: boolean;
  google?: GoogleSettings;

  homeAssistant?: {
    url: string;
    taskProvider?: 'google' | 'home_assistant';
    taskListEntity?: string;
    shoppingListEntity: string;
    weatherEntity: string;
    locationEntity: string;
    geocodedLocationEntity: string;
    sensorEntities: string[];
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
  assist: boolean;
  frigate: boolean;
  services: string[];
  homeAssistantUsers?: Record<string, string>;
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
  refreshToken?: string;
  configured?: boolean;
}
export interface GoogleSettings extends GoogleCredential {
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
