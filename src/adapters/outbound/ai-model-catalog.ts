import type { AIModelCatalog, AIProvider } from '../../domain/ai.js';

const endpoints: Partial<Record<AIProvider['kind'], string>> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
  ollama: 'http://localhost:11434/v1',
};

/** Read-only discovery, independent from conversation execution and mutation tools. */
export function aiModelCatalog(
  codex: (
    cursor: string | null,
    limit: number,
  ) => Promise<{
    data: { id: string; model: string; displayName: string }[];
    nextCursor: string | null;
  }>,
  homeAssistant: Exclude<AIModelCatalog, undefined>,
  request: typeof fetch = fetch,
): AIModelCatalog {
  return async (provider, query, signal) => {
    if (provider.kind === 'home_assistant') return homeAssistant(provider, query, signal);
    const items: { id: string; name: string }[] = [];
    if (provider.kind === 'codex') {
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        signal.throwIfAborted();
        const page = await codex(cursor, 100);
        items.push(...page.data.map((m) => ({ id: m.model, name: m.displayName || m.model })));
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor))
          throw new Error('El catálogo devolvió una página repetida.');
        if (cursor) seen.add(cursor);
      } while (cursor && items.length < 10000);
    } else {
      const base = provider.baseUrl || endpoints[provider.kind];
      if (!base) throw new Error('Configura la URL base del proveedor.');
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (provider.kind === 'anthropic') {
        headers['x-api-key'] = provider.apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
      let after: string | undefined;
      const seen = new Set<string>();
      do {
        const url = new URL(base.replace(/\/$/, '') + '/models');
        if (provider.kind === 'anthropic') {
          url.searchParams.set('limit', '1000');
          if (after) url.searchParams.set('after_id', after);
        }
        const response = await request(url, { headers, signal, redirect: 'error' });
        if (!response.ok)
          throw new Error(
            `No se pudieron consultar los modelos (HTTP ${response.status}). Revisa la conexión y sus credenciales.`,
          );
        const page = (await response.json()) as {
          data?: { id: string; name?: string; display_name?: string }[];
          has_more?: boolean;
          last_id?: string;
        };
        if (!Array.isArray(page.data))
          throw new Error('El proveedor no devolvió un catálogo de modelos válido.');
        items.push(
          ...page.data
            .filter((m) => typeof m.id === 'string' && m.id.length <= 200)
            .map((m) => ({ id: m.id, name: m.display_name || m.name || m.id })),
        );
        after = provider.kind === 'anthropic' && page.has_more ? page.last_id : undefined;
        if (page.has_more && provider.kind === 'anthropic' && (!after || seen.has(after)))
          throw new Error('El catálogo devolvió una página no válida.');
        if (after) seen.add(after);
      } while (after && items.length < 10000);
    }
    const search = query.search.toLocaleLowerCase();
    const filtered = [...new Map(items.map((item) => [item.id, item])).values()]
      .filter((item) => `${item.id} ${item.name}`.toLocaleLowerCase().includes(search))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      items: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
    };
  };
}
