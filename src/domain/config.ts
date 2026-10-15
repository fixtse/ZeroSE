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
  homeAssistant: {
    url: string;
    token: string;
    shoppingListEntity: string;
    sensorEntities: string[];
    weatherEntity: string;
  };
  memory: {
    postgresUrl: string;
    geminiApiKey: string;
    embeddingModel: string;
    embeddingDimensions: number;
    categories: string[];
    sharedProfile: string;
  };
  media: { asrUrl: string; voice: string; maxBytes: number };
  braveApiKey: string;
  schedules: {
    enabled: boolean;
    morning: string;
    reset: string;
    consolidate: string;
    eventReminders: boolean;
  };
}
