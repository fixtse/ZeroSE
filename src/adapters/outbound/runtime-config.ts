import { migrateDatabase } from './database-migrations.js';
import { createDatabase } from './database.js';
import pg from 'pg';
import { resolve } from 'node:path';
import { ServiceConfigSchema } from './config-schema.js';
import { loadConfig } from './config.js';
import { PostgresServiceSettings } from './postgres-service-settings.js';

/** Bootstrap an empty installation; saved service settings are authoritative. */
export async function loadRuntimeConfig() {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.database.url });
  try {
    await migrateDatabase(pool);
    const settings = new PostgresServiceSettings(
      createDatabase(pool),
      process.env.ASSISTANT_SECRETS_KEY || config.apiKey,
    );
    await settings.initialize(ServiceConfigSchema.parse({}));
    const services = ServiceConfigSchema.parse((await settings.read()).value);
    return {
      ...config,
      ...services,
      codex: {
        ...services.codex,
        home: resolve(process.env.ASSISTANT_CODEX_HOME || services.codex.home),
      },
      places: {
        photonUrl: process.env.ASSISTANT_PHOTON_URL || services.places.photonUrl,
        osrmUrl: process.env.ASSISTANT_OSRM_URL || services.places.osrmUrl,
      },
    };
  } finally {
    await pool.end();
  }
}
