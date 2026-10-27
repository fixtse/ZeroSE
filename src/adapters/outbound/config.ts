import { resolve } from 'node:path';
import { bootstrapKey } from './bootstrap-key.js';
import { BootstrapConfigSchema } from './config-schema.js';

export function loadConfig() {
  const config = BootstrapConfigSchema.parse({});
  config.host = process.env.ASSISTANT_HOST || config.host;
  config.port = BootstrapConfigSchema.shape.port.parse(
    Number(process.env.ASSISTANT_PORT || config.port),
  );
  config.dataDir = resolve(process.env.ASSISTANT_DATA_DIR || config.dataDir);
  config.apiKey = process.env.ASSISTANT_API_KEY || bootstrapKey(config.dataDir);
  if (config.apiKey.length < 24)
    throw new Error('Set ASSISTANT_API_KEY to a random value of at least 24 characters.');
  config.database.url = process.env.ASSISTANT_DATABASE_URL || config.database.url;
  if (!/^postgres(?:ql)?:\/\//.test(config.database.url))
    throw new Error('Set ASSISTANT_DATABASE_URL to a PostgreSQL connection URL');
  return config;
}
