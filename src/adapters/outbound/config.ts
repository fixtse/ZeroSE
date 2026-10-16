import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { memoryModes } from '../../domain/memory.js';
import type { Config } from '../../domain/config.js';

const secret = z.string().default('');
export const ConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8788),
  apiKey: secret,
  dataDir: z.string().default('./data'),
  database: z.object({ url: z.string().default('') }).default({ url: '' }),
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
      url: z.string().default('http://127.0.0.1:8123'),
      token: secret,
      shoppingListEntity: z.string().default('todo.shopping_list'),
      sensorEntities: z.array(z.string()).default([]),
      weatherEntity: secret,
      locationEntity: z
        .string()
        .regex(/^(?:(?:person|device_tracker)\.[a-z0-9_]+)?$/)
        .default('device_tracker.galaxy_s26'),
      geocodedLocationEntity: z
        .string()
        .regex(/^(?:sensor\.[a-z0-9_]+)?$/)
        .default('sensor.galaxy_s26_geocoded_location'),
    })
    .default({
      url: 'http://127.0.0.1:8123',
      token: '',
      shoppingListEntity: 'todo.shopping_list',
      sensorEntities: [],
      weatherEntity: '',
      locationEntity: 'device_tracker.galaxy_s26',
      geocodedLocationEntity: 'sensor.galaxy_s26_geocoded_location',
    }),
  memory: z
    .object({
      mode: z.enum(memoryModes).default('advanced'),
      geminiApiKey: secret,
      sharedProfile: secret,
      embeddingModel: z.string().default('gemini-embedding-001'),
      embeddingDimensions: z.number().int().default(3072),
      categories: z
        .array(z.string())
        .default([
          'Salud física',
          'Salud mental',
          'Carrera profesional',
          'Ejercicio',
          'Estado de ánimo',
          'Social',
          'Intereses especiales',
          'Trading',
          'Ideas',
        ]),
    })
    .default({
      mode: 'advanced',
      geminiApiKey: '',
      sharedProfile: '',
      embeddingModel: 'gemini-embedding-001',
      embeddingDimensions: 3072,
      categories: [
        'Salud física',
        'Salud mental',
        'Carrera profesional',
        'Ejercicio',
        'Estado de ánimo',
        'Social',
        'Intereses especiales',
        'Trading',
        'Ideas',
      ],
    }),
  media: z
    .object({
      asrUrl: secret,
      audioExtractionUrl: secret,
      voice: z.string().default('es-ES-AlvaroNeural'),
      maxBytes: z.number().int().positive().default(20_000_000),
    })
    .default({
      asrUrl: '',
      audioExtractionUrl: '',
      voice: 'es-ES-AlvaroNeural',
      maxBytes: 20_000_000,
    }),
  braveApiKey: secret,
  schedules: z
    .object({
      enabled: z.boolean().default(false),
      morning: z
        .string()
        .regex(/^(?:\d{2}:\d{2})?$/)
        .default('08:30'),
      reset: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .default('04:00'),
      consolidate: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .default('23:59'),
      eventReminders: z.boolean().default(false),
    })
    .default({
      enabled: false,
      morning: '08:30',
      reset: '04:00',
      consolidate: '23:59',
      eventReminders: false,
    }),
});
export function loadConfig(file = process.env.ASSISTANT_CONFIG || './config.json'): Config {
  const config = ConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (config.apiKey.length < 24)
    throw new Error('Set apiKey to a random value of at least 24 characters.');
  config.database.url = process.env.ASSISTANT_DATABASE_URL || config.database.url;
  if (!/^postgres(?:ql)?:\/\//.test(config.database.url))
    throw new Error('Set database.url or ASSISTANT_DATABASE_URL to a PostgreSQL connection URL');
  new Intl.DateTimeFormat('en', { timeZone: config.timezone });
  config.dataDir = resolve(config.dataDir);
  config.codex.home = resolve(process.env.ASSISTANT_CODEX_HOME || config.codex.home);
  return config;
}
