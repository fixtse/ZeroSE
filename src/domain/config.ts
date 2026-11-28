import type { ReplyLanguage } from './language.js';
import type { SpeechSettings } from './speech.js';
import type { MemoryMode } from './memory.js';
export interface GoogleCredential {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}
export type SetupMode = '' | 'telegram' | 'home_assistant' | 'both';
export interface Config {
  host: string;
  port: number;
  apiKey: string;
  dataDir: string;
  database: { url: string };
  connectionUrl?: string;
  timezone: string;
  replyLanguage?: ReplyLanguage;
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
    destinationNames?: Partial<Record<'calendarId' | 'taskListId' | 'documentFolderId', string>>;
    credentials: Partial<Record<'calendar' | 'tasks' | 'docs' | 'drive', GoogleCredential>>;
  };
  homeAssistant: {
    name?: string;
    connections?: { id: string; name: string; url: string }[];
    activeConnectionId?: string;
    voiceSatellite?: string;
    /** More Assist satellites routed to the owner's session (besides voiceSatellite). */
    voiceSatellites?: string[];
    taskProvider?: 'google' | 'home_assistant';
    taskListEntity?: string;
    url: string;
    token: string;
    shoppingListEntity: string;
    /** Retired scope, retained privately only to preserve existing scheduler identities. */
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
    sharedProfile: string;
  };
  media: {
    ffmpegCommand?: string;
    asrProvider?: 'none' | 'legacy' | 'clipse-whisper';
    asrWhisperProvider?: '' | 'faster-whisper' | 'hailo';
    asrModel?: string;
    asrUrl: string;
    /** Additional interchangeable sources, load balanced with `asrUrl`. */
    asrUrls?: string[];
    audioExtractionUrl: string;
    voice: string;
    maxBytes: number;
    speech?: SpeechSettings;
  };
  reader?: { url: string; apiKey: string };
  places?: { photonUrl: string; osrmUrl: string };
  /** First-run wizard state: which channels the owner chose and whether setup finished. */
  setup?: { mode: SetupMode; completed: boolean };
  braveApiKey: string;
  imageSearch?: import('./image-search.js').ImageSearchSettings;
}
