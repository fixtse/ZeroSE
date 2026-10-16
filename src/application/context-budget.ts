import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/o200k_base';

// A stable local accounting convention, independent of the selected agent model.
let encoding: Tiktoken | undefined;
export function tokens(value: unknown): number {
  encoding ??= new Tiktoken(ranks);
  return encoding.encode(JSON.stringify(value) ?? 'null', [], []).length;
}

export const MEMORY_SEARCH_TOKENS = 900;
export const TOOL_RESULT_TOKENS = 1200;

/** Return valid JSON pages without silently cutting off qualifications or errors. */
export function jsonPage(value: unknown, offset = 0, budget = TOOL_RESULT_TOKENS): unknown {
  if (!offset && tokens(value) <= budget) return value;
  const serialized = JSON.stringify(value) ?? 'null';
  if (offset > serialized.length) throw new Error('Result offset exceeds result length');
  let low = 0,
    high = Math.min(serialized.length - offset, budget * 8);
  const page = (length: number) => ({
    format: 'json_fragment',
    text: serialized.slice(offset, offset + length),
    offset,
    next_offset: offset + length < serialized.length ? offset + length : null,
    total_characters: serialized.length,
    notice:
      'Partial JSON data. Read tools support result_offset=next_offset. Never repeat a mutation to fetch data; use its read tool. Do not assume omitted facts.',
  });
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (tokens(page(middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  // Do not split UTF-16 surrogate pairs between pages.
  if (low && /[\uD800-\uDBFF]/.test(serialized[offset + low - 1]!)) low--;
  while (low && tokens(page(low)) > budget) low--;
  return page(low);
}

export function listPage(items: unknown[], offset = 0, limit = 20) {
  if (offset > items.length) throw new Error('List offset exceeds result length');
  const selected: unknown[] = [];
  const page = () => ({
    items: selected,
    total: items.length,
    offset,
    next_offset: offset + selected.length < items.length ? offset + selected.length : null,
  });
  for (const item of items.slice(offset, offset + limit)) {
    selected.push(item);
    if (tokens(page()) > TOOL_RESULT_TOKENS) {
      selected.pop();
      // An unusually large record remains accessible through JSON-fragment pagination.
      if (!selected.length)
        return {
          ...page(),
          items: [item],
          next_offset: offset + 1 < items.length ? offset + 1 : null,
        };
      break;
    }
  }
  return page();
}
