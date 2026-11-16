# Contributing to Zero Assistant

Thanks for helping. Zero is licensed under the [AGPL-3.0](LICENSE); by contributing
you agree that your contribution is released under the same license.

## Project layout

- `src/domain` — framework-free domain logic.
- `src/application` — use cases that talk to the outside world only through ports.
- `src/adapters` — inbound (HTTP, Telegram, admin API) and outbound (databases, AI
  providers, Home Assistant, Google, speech) implementations.
- `src/main.ts` — wires everything together.
- `web/` — the Next.js admin interface (shadcn components, English and Spanish).
- `integrations/home_assistant/assistant_zero` — snapshot of the HACS integration
  published in [`ha-zero-assistant`](https://github.com/fixtse/ha-zero-assistant).

See the [technical guide](docs/technical-guide.md) for architecture details.

## Development

Requirements: Node.js 26, pnpm 11 (the version pinned in `packageManager`),
PostgreSQL with pgvector (or the bundled PGlite mode), FFmpeg and Python 3 for the
Home Assistant tests. `mise install` sets up the pinned tool versions, and the
[devcontainer](.devcontainer/README.md) provides a ready-made environment.

```sh
pnpm install
pnpm dev         # assistant API
pnpm dev:admin   # admin interface on http://127.0.0.1:3000
```

Tests need their own database: set `TEST_DATABASE_URL`. Never point tests at a
database that holds real data.

## Before opening a pull request

Run all of these and make sure they pass:

```sh
pnpm format:check
pnpm check
pnpm test
pnpm build
docker compose config --quiet
```

Guidelines:

- Keep the hexagonal boundaries described above.
- Admin UI strings are written in Spanish and used as translation keys; add the
  English text to `web/i18n/messages.ts`.
- Keep per-turn prompts small. New tools that expose catalogs must be on-demand,
  filtered and paginated.
- Do not commit `config.json`, `data/`, `.env` files, tokens or personal data.
- Do not add automatic retries for operations that change external state.

## Reporting bugs

Open an issue with the version or commit, how you run Zero (Docker, add-on,
development), what you expected and what happened. Remove tokens and personal
data from logs first. Security issues go through [SECURITY.md](SECURITY.md).
