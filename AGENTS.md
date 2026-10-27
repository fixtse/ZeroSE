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
- Fix code-style issues before committing or pushing. Run the pinned Prettier formatter in
  Codespaces on changed files, synchronize the formatted files back to the local checkout,
  and rerun `pnpm format:check` against the final source tree. A failed formatting check
  blocks commit and push; do not rely on GitHub Actions to discover or fix formatting.
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


## Admin interface design

- Never leave a saved API key or token field visually empty. Show the shared masked
  secret preview (or a masked configured indicator) so users know a credential is
  registered, including Gemini embeddings. Never return or render the full saved
  secret; keep previews out of mutation payloads and preserve blank-input semantics
  for retaining the saved credential.

- Preserve Zero's slate surfaces and orange accent. Use orange for primary actions,
  selection and focus; reserve red for destructive interactions.
- Design the layout around the task. Converting text buttons to icons also requires
  regrouping and repositioning actions; do not leave scattered icons or oversized empty rows.
- Keep dashboard navigation and all tabs visibly labeled. Use distinct, meaningful icons
  for different concepts (for example, CPU for AI providers, Activity for status and Webhook
  for webhook registration); do not reuse generic checkmarks for unrelated operations.
- Use compact icon-only action buttons with accessible names and shadcn tooltips.
  Keep names visible on entity selectors and choices where they identify the selected item.
- Place actions beside the object they affect. Group save/reload consistently, give the
  primary save action a clear position, and separate destructive actions from routine controls.
  Avoid stacking several sparse action rows when one organized toolbar will fit.
- Keep profile headers compact: title at the left, selected assistant icon and name at the
  far right. Do not add a separate “Asistente asignado” row or redundant label.
  Keep profile deletion at the bottom with a confirmation dialog.
- Use a drag-and-drop image selector only when no image is selected. With an image present,
  show its preview and a corner remove control revealed on hover or keyboard focus; keep it
  discoverable on touch devices. Confirm removal before changing the saved image.
- Confirm important destructive or externally visible changes with shadcn dialogs.
  Keep routine, reversible interactions lightweight; preserve separate Zero and Telegram actions.
- Persist pages, open editors and meaningful tabs in URL paths or parameters. Reload and
  browser back/forward must preserve the user's place; saving a new entity must update its URL.
- Use short, purposeful transitions for hover, focus, pressed states and contextual controls.
  Preserve visible keyboard focus, honor reduced motion, and avoid decorative animation.
- Reuse shared shadcn components and spacing patterns. Prefer concise headings, useful copy,
  aligned controls and responsive layouts over decorative labels and excess vertical space.
- Review substantive layout changes in the browser at desktop and mobile widths. Check action
  grouping, overflow, keyboard access, tooltips, dialogs and URL restoration, not just compilation.

## Home Assistant integration

- Ship one HACS integration: `assistant_zero` in `fixtse/ha-zero-assistant`.
  Conversation, shared settings, reminders and sensor/weather alerts belong there.
  The standalone `assistant_rules` component/repository is retired; do not recreate it.
- Keep the installable repository's `custom_components/assistant_zero/` and this
  repository's `integrations/home_assistant/assistant_zero/` snapshot identical.
  Update `repositories.json` with the published full commit and manifest version.
  For integration releases, bump the manifest version, publish a matching tag and
  publish a GitHub Release for that tag in `fixtse/ha-zero-assistant`. A tag and
  manifest version alone do not complete a release. Verify that the GitHub Release
  is published (not a draft or prerelease) before reporting the version as released.
  Keep one component per HACS repository and the README install/setup buttons.
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
