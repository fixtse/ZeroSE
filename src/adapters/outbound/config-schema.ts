import { z } from 'zod';
import { memoryModes } from '../../domain/memory.js';

export const BootstrapConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8788),
  apiKey: z.string().default(''),
  dataDir: z.string().default('./data'),
  database: z.object({ url: z.string().default('') }).default({ url: '' }),
});

const secret = z.string().default('');
export const ServiceConfigSchema = z.object({
  connectionUrl: z
    .string()
    .trim()
    .max(2000)
    .default('')
    .refine((value) => {
      if (!value) return true;
      try {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          /^\/[a-zA-Z0-9/_-]*$/.test(url.pathname)
        );
      } catch {
        return false;
      }
    }, 'Usa una URL HTTP o HTTPS sin credenciales ni parámetros.')
    .transform((value) => value.replace(/\/+$/, '')),
  timezone: z.string().default('Europe/Madrid'),
  concurrency: z.number().int().min(1).max(16).default(4),
  codex: z
    .object({
      command: z.string().default('./node_modules/.bin/codex'),
      args: z.array(z.string()).default([]),
      model: z.string().default('gpt-6-luna'),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
      home: z.string().default('./data/codex'),
      timeoutMs: z.number().positive().default(300_000),
    })
    .default({
      command: './node_modules/.bin/codex',
      args: [],
      model: 'gpt-6-luna',
      effort: 'medium',
      home: './data/codex',
      timeoutMs: 300_000,
    }),
  telegram: z
    .object({
      transport: z.enum(['disabled', 'webhook', 'polling']).default('disabled'),
      token: secret,
      webhookSecret: secret,
      allowedUsers: z.array(z.string()).default([]),
      notificationChatId: secret,
      voiceReplies: z.boolean().default(true),
    })
    .default({
      transport: 'disabled',
      token: '',
      webhookSecret: '',
      allowedUsers: [],
      notificationChatId: '',
      voiceReplies: true,
    }),
  google: z
    .object({
      clientId: secret,
      clientSecret: secret,
      refreshToken: secret,
      calendarId: z.string().default('primary'),
      taskListId: z.string().default('@default'),
      contextDocumentId: secret,
      documentFolderId: secret,
      destinationNames: z
        .object({
          calendarId: z.string().max(300).optional(),
          taskListId: z.string().max(300).optional(),
          documentFolderId: z.string().max(300).optional(),
        })
        .optional(),
      credentials: z
        .object({
          calendar: z
            .object({ clientId: secret, clientSecret: secret, refreshToken: secret })
            .optional(),
          tasks: z
            .object({ clientId: secret, clientSecret: secret, refreshToken: secret })
            .optional(),
          docs: z
            .object({ clientId: secret, clientSecret: secret, refreshToken: secret })
            .optional(),
          drive: z
            .object({ clientId: secret, clientSecret: secret, refreshToken: secret })
            .optional(),
        })
        .default({}),
    })
    .default({
      clientId: '',
      clientSecret: '',
      refreshToken: '',
      calendarId: 'primary',
      taskListId: '@default',
      contextDocumentId: '',
      documentFolderId: '',
      credentials: {},
    }),
  homeAssistant: z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      connections: z
        .array(z.object({ id: z.string().max(250), name: z.string().max(100), url: z.url() }))
        .max(20)
        .optional(),
      activeConnectionId: z.string().max(250).optional(),
      voiceSatellite: z
        .string()
        .regex(/^assist_satellite\.[a-z0-9_]+$|^$/)
        .default(''),
      url: z.string().default(''),
      token: secret,
      taskProvider: z.enum(['google', 'home_assistant']).optional(),
      taskListEntity: z
        .string()
        .regex(/^(?:todo\.[a-z0-9_]+)?$/)
        .optional(),
      shoppingListEntity: z.string().default(''),
      sensorEntities: z.array(z.string()).default([]),
      weatherEntity: secret,
      locationEntity: z
        .string()
        .regex(/^(?:(?:person|device_tracker)\.[a-z0-9_]+)?$/)
        .default(''),
      geocodedLocationEntity: z
        .string()
        .regex(/^(?:sensor\.[a-z0-9_]+)?$/)
        .default(''),
    })
    .default({
      url: '',
      voiceSatellite: '',
      token: '',
      shoppingListEntity: '',
      sensorEntities: [],
      weatherEntity: '',
      locationEntity: '',
      geocodedLocationEntity: '',
    }),
  memory: z
    .object({
      mode: z.enum(memoryModes).default('advanced'),
      geminiApiKey: secret,
      sharedProfile: secret,
      embeddingModel: z.string().default('gemini-embedding-001'),
      embeddingDimensions: z.number().int().default(3072),
    })
    .default({
      mode: 'advanced',
      geminiApiKey: '',
      sharedProfile: '',
      embeddingModel: 'gemini-embedding-001',
      embeddingDimensions: 3072,
    }),
  media: z
    .object({
      ffmpegCommand: z.string().min(1).default('ffmpeg'),
      speech: z
        .object({
          stt: z.string(),
          sttLanguage: z.string(),
          tts: z.string(),
          ttsLanguage: z.string(),
          voice: z.string(),
        })
        .optional(),
      asrProvider: z.enum(['none', 'legacy', 'clipse-whisper']).default('legacy'),
      asrWhisperProvider: z.enum(['', 'faster-whisper', 'hailo']).default(''),
      asrModel: z.string().trim().max(180).default(''),
      asrUrl: secret,
      asrUrls: z
        .array(z.url({ protocol: /^https?$/ }).max(500))
        .max(16)
        .default([]),
      audioExtractionUrl: secret,
      voice: z.string().default('es-ES-AlvaroNeural'),
      maxBytes: z.number().int().positive().default(20_000_000),
    })
    .default({
      ffmpegCommand: 'ffmpeg',
      asrProvider: 'legacy',
      asrWhisperProvider: '',
      asrModel: '',
      asrUrl: '',
      asrUrls: [],
      audioExtractionUrl: '',
      voice: 'es-ES-AlvaroNeural',
      maxBytes: 20_000_000,
    }),
  reader: z
    .object({ url: z.url().default('https://r.jina.ai/'), apiKey: secret })
    .default({ url: 'https://r.jina.ai/', apiKey: '' }),
  places: z
    .object({ photonUrl: z.url(), osrmUrl: z.url() })
    .default({ photonUrl: 'https://photon.komoot.io', osrmUrl: 'https://router.project-osrm.org' }),
  setup: z
    .object({
      mode: z.enum(['', 'telegram', 'home_assistant', 'both']).default(''),
      completed: z.boolean().default(false),
    })
    .default({ mode: '', completed: false }),
  braveApiKey: secret,
  imageSearch: z
    .object({
      defaultProvider: z.enum(['brave', 'searchapi', 'serpapi']).default('brave'),
      searchApiKey: secret,
      serpApiKey: secret,
    })
    .default({ defaultProvider: 'brave', searchApiKey: '', serpApiKey: '' }),
});

export const ConfigSchema = BootstrapConfigSchema.extend(ServiceConfigSchema.shape);
