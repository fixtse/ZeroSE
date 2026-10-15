# Assistant development

- Use TypeScript and pnpm 11+; honor the pinned `packageManager` and commit lockfile updates.
- Keep hexagonal boundaries: domain has no framework dependencies; application uses ports;
  adapters implement integrations; `src/main.ts` wires dependencies.
- Preserve tool names, conversation state, prompts, and integration behavior unless requested.
- Storage uses PostgreSQL with pgvector; keep ports asynchronous and preserve queue/session ordering.
  Use a dedicated `TEST_DATABASE_URL` for tests. Never clear production state or volumes.
- Run `pnpm format:check`, `pnpm check`, `pnpm test`, and `pnpm build` before pushing.
  Validate deployment changes with `docker compose config --quiet` and a local image build.
- Never commit or bake `config.json`, `data/`, `.codex`, tokens, or local `.env` files into images.
  Keep the Docker build context restricted to source, required static assets, and manifests.
- Production Compose pulls private GHCR images. Use `compose.build.yaml` for local builds.
- This host runs the live assistant. Code-only changes must not restart it or mutate live
  Telegram, Google, or Home Assistant integrations. Keep runtime backups private.
- Do not automatically replay interrupted jobs or retry uncertain mutating tool calls.
