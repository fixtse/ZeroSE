# Assistant development

- Use TypeScript and pnpm 11+; honor the pinned `packageManager` and commit lockfile updates.
- Keep hexagonal boundaries: domain has no framework dependencies; application uses ports;
  adapters implement integrations; `src/main.ts` wires dependencies.
- Preserve tool names, conversation state, prompts, and integration behavior unless requested.
- Keep per-turn instructions small and stable. New tools must expose catalogs and large datasets
  through scoped, on-demand read/discovery tools with filtering, pagination, and response budgets;
  never inject growing catalogs or tool results into every turn's instructions. Use brief tool
  descriptions for discovery, and never require replaying a mutation to fetch omitted output.
- Storage uses PostgreSQL with pgvector; keep ports asynchronous and preserve queue/session ordering.
  Use a dedicated `TEST_DATABASE_URL` for tests. Never clear production state or volumes.
- Run `pnpm format:check`, `pnpm check`, `pnpm test`, and `pnpm build` before pushing.
  Validate deployment definitions locally with `docker compose config --quiet`.
  Let GitHub Actions build and validate Docker images; do not build images locally unless
  explicitly requested.
- After completing a requested change and passing the required checks, automatically commit
  the task's changes and push the current branch to its configured remote. Do not include
  unrelated local changes or private runtime files.
- Never commit or bake `config.json`, `data/`, `.codex`, tokens, or local `.env` files into images.
  Keep the Docker build context restricted to source, required static assets, and manifests.
- Production Compose pulls private GHCR images. Use `compose.build.yaml` for local builds.
- This host runs the live assistant. Code-only changes must not restart it or mutate live
  Telegram, Google, or Home Assistant integrations. Keep runtime backups private.
- Do not automatically replay interrupted jobs or retry uncertain mutating tool calls.


## Home Assistant integration

- Ship one HACS integration: `assistant_zero` in `fixtse/ha-zero-assistant`.
  Conversation, shared settings, reminders and sensor/weather alerts belong there.
  The standalone `assistant_rules` component/repository is retired; do not recreate it.
- Keep the installable repository's `custom_components/assistant_zero/` and this
  repository's `integrations/home_assistant/assistant_zero/` snapshot identical.
  Update `repositories.json` with the published full commit and manifest version.
  For integration releases, bump the manifest version and publish a matching tag;
  keep one component per HACS repository and the README install/setup buttons.
- Use this project's `assets/icon.png` for Zero's branding. Zero owns the prompt,
  memory, queue and permissions; HA is an optional client, never a second prompt store.
- Preserve `assistant_zero` entry IDs, `conversation.zero`, Assist pipelines and
  existing rule IDs/generations. Retain `/api/assistant_rules`, its storage key and
  internal manager key for compatibility; these names do not imply a separate integration.
- SchedulerSE is an optional backend for timed reminders; HA still owns sensor and
  weather conditions. Preserve existing scheduler identities. Never silently move
  schedules, fail over, overwrite SchedulerSE's shared delivery connection or replay
  uncertain mutations. Keep all connection credentials private.
- Validate in Codespaces with the required pnpm/Compose checks and the pinned real
  HA smoke check (`test/ha_runtime/requirements.txt`, `test/ha_runtime/verify.py`).
  Check the unified package in its own repository too when its files change.
- Installing/upgrading live HA requires explicit authorization. Back up privately,
  stop HA before changing stored entries, use `scripts/migrate-ha-zero.py` for legacy
  migrations, validate configuration before restart, and verify scheduler readiness
  plus retained voice/rule identities. Never clear `.storage/assistant_rules` or
  register replacement schedules as part of an upgrade. Code-only work must not
  restart services. Follow the shared webhook-first execution policy.
