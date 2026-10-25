import type { SpeechSettings } from './speech.js';
import type { MemoryMode } from './memory.js';
export interface GoogleCredential {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}
export interface Config {
  host: string;
  port: number;
  apiKey: string;
  dataDir: string;
  database: { url: string };
  timezone: string;
  concurrency: number;
  codex: {
    command: string;
    args: string[];
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    home: string;
    timeoutMs: number;
  };
  telegram: {
    transport: 'disabled' | 'webhook' | 'polling';
    token: string;
    webhookSecret: string;
    allowedUsers: string[];
    notificationChatId: string;
    voiceReplies: boolean;
  };
  google: GoogleCredential & {
    calendarId: string;
    taskListId: string;
    contextDocumentId: string;
    documentFolderId: string;
    credentials: Partial<Record<'calendar' | 'tasks' | 'docs' | 'drive', GoogleCredential>>;
  };
  schedulerSE?: { url: string; token: string; callbackUrl?: string; enabled: boolean };
  homeAssistant: {
    voiceSatellite?: string;
    url: string;
    token: string;
    shoppingListEntity: string;
    sensorEntities: string[];
    weatherEntity: string;
    locationEntity: string;
    geocodedLocationEntity: string;
  };
  memory: {
    mode?: MemoryMode;
    geminiApiKey: string;
    embeddingModel: string;
    embeddingDimensions: number;
    categories: string[];
    sharedProfile: string;
  };
  media: {
    asrUrl: string;
    audioExtractionUrl: string;
    voice: string;
    maxBytes: number;
    speech?: SpeechSettings;
  };
  braveApiKey: string;
  schedules: {
    enabled: boolean;
    morning: string;
    reset: string;
    consolidate: string;
    eventReminders: boolean;
  };
}
