import { z } from 'zod';
import { Tools } from '../../application/tool-registry.js';
import { jsonPage } from '../../application/context-budget.js';
import type { PersonalDataPort } from '../../application/personal-data.js';
const id = z.string().regex(/^[1-9]\d{0,18}$/);
const page = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
  result_offset: z.number().int().min(0).default(0),
};
export function registerPersonalDataTools(
  tools: Tools,
  data: PersonalDataPort,
  memoryEnabled: boolean,
  sharedProfile = '',
) {
  if (memoryEnabled) {
    tools.add(
      'memory_list',
      'Browse saved memories in this profile by literal search/category. Brief summaries only; memory_read gets full details. offset/limit; result_offset pages JSON fragments.',
      z.object({
        search: z.string().max(300).default(''),
        category: z.string().max(200).optional(),
        ...page,
      }),
      async (a, c) =>
        jsonPage(
          await data.memories(sharedProfile || c.session, a.search, a.category, a.offset, a.limit),
          a.result_offset,
        ),
    );
    tools.add(
      'memory_delete',
      'Erase selected saved memories only when explicitly requested by the user. Search/read first and pass exact IDs. This does not erase conversation messages, external context documents or text already in the current conversation. For corrections use memory_save with supersedes.',
      z.object({ memory_ids: z.array(id).min(1).max(20) }),
      async (a, c) => ({
        deleted: await data.forget(sharedProfile || c.session, a.memory_ids),
        scope: 'saved_memories_only',
      }),
    );
  }
  tools.add(
    'conversation_search',
    'Search stored messages in this chat only, including before conversation resets. Keyword query with optional ISO timestamps. Empty query browses history. Results are attributed excerpts, not verified facts; use conversation_read for details. offset/limit; result_offset pages JSON fragments.',
    z
      .object({
        query: z.string().max(300).default(''),
        start: z.iso.datetime({ offset: true }).optional(),
        end: z.iso.datetime({ offset: true }).optional(),
        ...page,
      })
      .refine(
        (a) => !a.start || !a.end || Date.parse(a.end) >= Date.parse(a.start),
        'Invalid date interval',
      ),
    async (a, c) =>
      jsonPage(
        await data.conversations(c.session, a.query, a.start, a.end, a.offset, a.limit),
        a.result_offset,
      ),
  );
  tools.add(
    'conversation_read',
    'Read a stored message by ID in this chat only, preserving its author and date. Large text returns JSON fragments; continue with result_offset=next_offset.',
    z.object({ message_id: id, result_offset: page.result_offset }),
    async (a, c) => jsonPage(await data.message(c.session, a.message_id), a.result_offset),
  );
}
