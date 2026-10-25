import type pg from 'pg';
import type { ZeroSettings, ZeroSettingsPort } from '../../application/zero-settings.js';

export class PostgresZeroSettings implements ZeroSettingsPort {
  constructor(private pool: pg.Pool) {}
  async initialize(prompt: string) {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS zero_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, value JSONB NOT NULL)`);
    await this.pool.query(
      'INSERT INTO zero_settings(id, revision, value) VALUES(1, 1, $1) ON CONFLICT DO NOTHING',
      [
        JSON.stringify({
          prompt,
          homeAssistant: true,
          assist: false,
          frigate: false,
          services: [],
        }),
      ],
    );
  }
  async read(): Promise<ZeroSettings> {
    const { rows } = await this.pool.query(
      'SELECT revision, value FROM zero_settings WHERE id = 1',
    );
    if (!rows[0]) throw new Error('Zero settings not initialized');
    return { ...rows[0].value, revision: rows[0].revision };
  }
  async update(value: ZeroSettings): Promise<ZeroSettings | undefined> {
    const { revision, ...settings } = value;
    const { rows } = await this.pool.query(
      'UPDATE zero_settings SET revision = revision + 1, value = value || $1::jsonb WHERE id = 1 AND revision = $2 RETURNING revision, value',
      [JSON.stringify(settings), revision],
    );
    return rows[0] ? { ...rows[0].value, revision: rows[0].revision } : undefined;
  }
}
