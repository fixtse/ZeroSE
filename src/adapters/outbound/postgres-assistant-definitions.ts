import type pg from 'pg';
import type { AssistantDefinitionRepository } from '../../application/assistant-definitions.js';
import type { AssistantDefinition, AssistantSummary } from '../../domain/assistant-definition.js';
import type { BotId } from '../../domain/access.js';
import { salemPrompt } from '../../application/prompts.js';
export class PostgresAssistantDefinitions implements AssistantDefinitionRepository {
  constructor(private pool: pg.Pool) {}
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS assistant_definitions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT,
      revision INTEGER NOT NULL DEFAULT 1, preset TEXT NOT NULL CHECK(preset IN ('standard','salem')),
      builtin BOOLEAN NOT NULL DEFAULT false
    )`);
    // ON CONFLICT preserves all administrator edits, including the imported Salem prompt.
    for (const [id, name, prompt, preset] of [
      ['zero', 'Zero', null, 'standard'],
      ['salem', 'Salem', salemPrompt, 'salem'],
      [
        'standard',
        'Estándar',
        'Eres {{identity}}, un asistente personal. Responde en español.',
        'standard',
      ],
    ])
      await this.pool.query(
        'INSERT INTO assistant_definitions(id,name,prompt,preset,builtin) VALUES($1,$2,$3,$4,true) ON CONFLICT DO NOTHING',
        [id, name, prompt, preset],
      );
  }
  private definition(row: any): AssistantDefinition {
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      revision: row.revision,
      preset: row.preset,
      builtin: row.builtin,
    };
  }
  async list(search: string, offset: number, limit: number) {
    const { rows } = await this.pool.query(
      `SELECT a.id,a.name,a.preset,a.builtin,
      CASE WHEN a.id='zero' THEN z.revision ELSE a.revision END AS revision
      FROM assistant_definitions a LEFT JOIN zero_settings z ON a.id='zero' AND z.id=1
      WHERE position(lower($1) in lower(a.name))>0 ORDER BY a.builtin DESC,lower(a.name),a.id LIMIT $2 OFFSET $3`,
      [search, limit, offset],
    );
    const total = Number(
      (
        await this.pool.query(
          'SELECT count(*) FROM assistant_definitions WHERE position(lower($1) in lower(name))>0',
          [search],
        )
      ).rows[0].count,
    );
    return { items: rows as AssistantSummary[], total };
  }
  async get(id: string) {
    const { rows } = await this.pool.query(
      `SELECT a.id,a.name,a.preset,a.builtin,
      CASE WHEN a.id='zero' THEN z.value->>'prompt' ELSE a.prompt END AS prompt,
      CASE WHEN a.id='zero' THEN z.revision ELSE a.revision END AS revision
      FROM assistant_definitions a LEFT JOIN zero_settings z ON a.id='zero' AND z.id=1 WHERE a.id=$1`,
      [id],
    );
    return rows[0] ? this.definition(rows[0]) : undefined;
  }
  async create(value: AssistantDefinition) {
    await this.pool.query(
      "INSERT INTO assistant_definitions(id,name,prompt,revision,preset,builtin) VALUES($1,$2,$3,1,'standard',false)",
      [value.id, value.name, value.prompt],
    );
  }
  async update(id: string, input: { name: string; prompt: string; revision: number }) {
    if (id === 'zero') {
      if (input.name !== 'Zero') return undefined;
      const { rows } = await this.pool.query(
        `UPDATE zero_settings SET revision=revision+1,value=jsonb_set(value,'{prompt}',to_jsonb($1::text)) WHERE id=1 AND revision=$2 RETURNING revision`,
        [input.prompt, input.revision],
      );
      return rows[0]
        ? {
            id,
            name: 'Zero',
            prompt: input.prompt,
            revision: rows[0].revision,
            preset: 'standard' as const,
            builtin: true,
          }
        : undefined;
    }
    const { rows } = await this.pool.query(
      'UPDATE assistant_definitions SET name=$1,prompt=$2,revision=revision+1 WHERE id=$3 AND revision=$4 RETURNING *',
      [input.name, input.prompt, id, input.revision],
    );
    return rows[0] ? this.definition(rows[0]) : undefined;
  }
  async remove(id: string, revision: number): Promise<'deleted' | 'conflict'> {
    try {
      const result = await this.pool.query(
        'DELETE FROM assistant_definitions WHERE id=$1 AND revision=$2 AND NOT builtin AND NOT EXISTS (SELECT 1 FROM managed_bots WHERE managed_bots.id=assistant_definitions.id AND account_id IS NOT NULL) RETURNING id',
        [id, revision],
      );
      return result.rowCount ? 'deleted' : 'conflict';
    } catch (error) {
      if ((error as { code?: string }).code === '23503') return 'conflict';
      throw error;
    }
  }
  async assign(bot: BotId, chatId: string, id: string) {
    try {
      const result = await this.pool.query(
        'UPDATE access_profiles SET assistant_id=$1 WHERE bot=$2 AND chat_id=$3 RETURNING chat_id',
        [id, bot, chatId],
      );
      return !!result.rowCount;
    } catch (error) {
      if ((error as { code?: string }).code === '23503') return false;
      throw error;
    }
  }
}
