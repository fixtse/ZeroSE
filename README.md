<img src="assets/icon.png" alt="Zero assistant icon" width="112" align="right">

# Fixt Assistant

A personal TypeScript assistant with Home Assistant, Google services, Telegram,
and semantic memory. It uses Codex app-server and a shared Codex login.

The project icon is in `assets/icon.png`, served at `/icon.png` and the favicon paths.
Its generation prompt is recorded in `assets/icon.prompt.txt`.

## Architecture

```text
src/domain/                  Configuration contracts, models, date calculations
src/application/ports.ts     Contracts implemented by adapters
src/application/use-cases/   Messages, notifications, memory consolidation
src/application/             Durable job execution, memory retrieval, scheduling
src/adapters/inbound/        Authenticated HTTP, Telegram polling, agent tool bindings
src/adapters/outbound/       Codex, Home Assistant, Google, PostgreSQL, media, embeddings
src/main.ts                  Composition root
```

Application code depends on ports, and domain code has no framework dependencies.
An architecture test enforces these boundaries. Tests also cover concurrency,
delivery failures, duplicate updates, interrupted jobs, memory, DST, authentication,
Google OAuth scope separation, and the Codex protocol.

## Run

Requires Node 22.16+ and **pnpm 11+**, pinned to 11.28.6 through `packageManager`.
Corepack can supply pnpm: use `corepack pnpm` if `pnpm` is not on PATH.

```sh
pnpm install --frozen-lockfile
pnpm check
TEST_DATABASE_URL=postgresql://.../assistant_test pnpm test
pnpm build
pnpm start
```

Credentials and integration settings live in private `config.json`, prompts in
`data/prompts.json`, and attachments in `data/`. PostgreSQL stores jobs, conversations,
schedules, audit records, and long-term memory. These private files are excluded from Git
and Docker images. `config.example.json` contains placeholders for a fresh installation.
Set `database.url` or `ASSISTANT_DATABASE_URL` when running outside Compose.

```sh
docker compose pull
docker compose up -d --wait
docker compose ps
docker compose logs --tail 30
pnpm run doctor
```

The service binds to `127.0.0.1:8788`. `/health` is a process health check, not proof
that every external integration is available. `doctor` checks the real integrations
without sending Telegram messages or mutating calendar, task, or shopping data.
Configuration changes take effect after restarting this service.

For development outside Docker, install `ffmpeg`, `poppler-utils`, and `catdoc`.
The container includes them. PDF text, DOC/DOCX, XLS/XLSX, images, text, JSON/XML,
audio, video notes, and video attachments have native handling. Audio transcription
uses the existing ASR service; image interpretation uses Codex local-image input.
Scanned PDFs without a text layer currently require sending their pages as images.

## Private images and deployment

GitHub Actions runs formatting, type checks, tests, and compilation before building images.
Pushes to `main`, version tags (`v*`), and manual runs publish AMD64 and ARM64 images to
`ghcr.io/fixtse/node-assistant`. Pull requests validate and build without publishing.
Tags include `latest` for `main`, `sha-<full-commit>` for each build, and version/minor tags
for semantic version releases. Actions use the repository's `GITHUB_TOKEN`; no registry
password needs to be added to repository secrets.

The workflow checks package privacy before and after publishing and refuses an existing
public package. New GHCR packages are private by default, as documented by
[GitHub](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
If a package already exists, grant this repository Actions access to it in package settings.

On the deployment host:

```sh
cp .env.example .env
# Set ASSISTANT_POSTGRES_PASSWORD in .env to a fresh value from: openssl rand -hex 32
# For a fresh installation, also create config.json from config.example.json and fill its credentials.
mkdir -p data
docker login ghcr.io -u fixtse
docker compose pull
docker compose up -d --wait
```

Use a GitHub classic personal access token with `read:packages` at the Docker login prompt.
Keep credentials in `config.json` and the existing `.codex` mount; neither enters the image.
The configured bind paths must exist and be accessible by UID 1000. `.env` can override
the image, configuration file, data directory, and shared Codex directory.

For controlled upgrades or rollback, set `ASSISTANT_IMAGE` in `.env` to a previously
published `sha-<full-commit>` tag or an image digest, then run the pull/up commands again.
The CI image job reports the published digest. The production Compose file has no build
step and does not automatically deploy when an image is published.

For a local source build:

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build --wait
```

The multi-stage Dockerfile includes production dependencies and media utilities in its
runtime image. Its build context permits only source, the icon, and dependency manifests.

## Shared Codex credentials and moving hosts

Compose mounts `ASSISTANT_CODEX_HOME` (default `$HOME/.codex`) at `/codex` and sets
`ASSISTANT_CODEX_HOME=/codex` inside the container. The mount is writable so Codex
can maintain its authentication and threads. The current ChatGPT login is reused;
credentials are never baked into the image.

To move the assistant, stop it and restore a PostgreSQL dump on the destination. Transfer
`config.json`, `.env`, the entire `data/` directory, and
the shared `.codex` directory, preserving private permissions and UID 1000 access.
Set the host-side `ASSISTANT_CODEX_HOME` to the new location before starting Compose.
Update Home Assistant and ASR URLs if their addresses change. Use a consistent
container data path when continuing threads with image attachments.

For a new account login, run `pnpm run login` with the intended Codex home configured.
The explicit `run` is required because `pnpm login` is the package-registry command.

## Interfaces

`POST /v1/chat`, authenticated with `Authorization: Bearer <config.apiKey>`, accepts:

```json
{"session":"personal","text":"¿Qué tengo que hacer hoy?","name":"Sergio"}
```

It returns HTTP 202 with a `jobId`. Poll `GET /v1/jobs/<jobId>` with the same
authorization for status, output, or error. An optional `Idempotency-Key` header
deduplicates submissions within a session. Jobs from the same session run in order;
separate sessions can run concurrently.

Telegram supports `disabled`, `webhook`, or `polling` transport. Polling needs no
public ingress and refuses to start if a webhook already exists. Webhook mode uses
`POST /telegram/webhook` and validates `X-Telegram-Bot-Api-Secret-Token` plus the
configured user allowlist. Neither transport registers or removes a webhook on startup.

## Capabilities

- Telegram text/media/document input, replies to text, and transcription of replied-to voice/video notes.
- Spanish responses, Markdown formatting, message splitting, typing feedback, and optional voice replies.
- Google Calendar availability and event CRUD; Google Tasks CRUD; `/clean` clears the configured task list.
- `/nuevo` starts a new conversation while retaining long-term memory.
- Google Docs personal context, appending context, and Markdown-to-document creation with PDF export URLs.
- Codex web search, public URL reading, and Brave image search when configured.
- Home Assistant shopping-list reads/additions/completion/removal, sensor discovery/current values,
  and up to seven days of recorded sensor history. Sensor access can be restricted to named entities.
- Gemini semantic memory retrieval with category/date filters, stored and searched using pgvector.
- Native memory consolidation, daily short-term reset, morning agenda, and optional event reminders.
  The original disabled 15-minute reminder routine remains disabled by default.

Google services use separate OAuth grants for their required scopes. Home Assistant list writes are followed by a read-back verification. Uncertain
mutating operations are not retried automatically. Interrupted jobs become failed jobs
requiring inspection rather than silently replaying their actions.

## Storage and backups

Compose runs PostgreSQL 17 with pgvector 0.8.7 and a persistent `postgres-data` volume.
The database port binds only to loopback (default 55432). Keep `.env` private; its database
password must be set before the first start. Changing this variable later does not rotate
the existing database role password. Never use `docker compose down -v` on production.

All storage ports are asynchronous. The queue uses transactional claims and preserves
session ordering. One active assistant process per database schema is enforced with a
PostgreSQL advisory lock. Do not run multiple Telegram pollers for one bot. Horizontal
worker replication would require a distributed execution lease and scheduler design.

Embeddings retain full float32 precision in `vector(3072)`. A half-precision HNSW expression
index retrieves up to 100 candidates; full-precision cosine scores rerank the best 10 above
0.4. This is approximate retrieval; category, date, and profile filters apply in SQL.
Records without embeddings retain keyword matching. Changing embedding dimensions requires
a deliberate data migration; startup rejects a mismatch.

Back up the database together with the private files and shared Codex directory:

```sh
mkdir -p data/backups
chmod 700 data/backups
docker compose exec -T postgres pg_dump -U assistant -d assistant -Fc > data/backups/assistant.dump
chmod 600 data/backups/assistant.dump
# Restore into an empty database while the assistant is stopped:
# docker compose exec -T postgres pg_restore -U assistant -d assistant --exit-on-error < data/backups/assistant.dump
```

An offline SQLite importer is available for existing installations. Stop the old assistant,
make an SQLite backup, configure an empty PostgreSQL target, then run:

```sh
pnpm migrate:sqlite /private/backup/assistant.sqlite
```

The importer opens the source read-only and imports all seven state tables in one transaction,
compares every row (embeddings at float32 precision), and advances identity sequences. It
refuses a populated target or running source jobs. Keep the original SQLite backup for
rollback; once PostgreSQL accepts new work, reverting requires reconciling those new records.
SQLite is only used by this import utility and its regression test.

Run tests against a dedicated PostgreSQL database with pgvector enabled; each test creates
and removes an isolated schema. CI provisions that database automatically.

### Pangolin webhook deployment

The selected public endpoint is `https://twk.kcta.cc/telegram/webhook`. This host has
an active Newt service; configure its Pangolin resource to target `http://127.0.0.1:8788`.
Telegram must be able to reach the webhook path without an interactive login. The
assistant checks the configured Telegram secret header and permitted Telegram user IDs.
`https://twk.kcta.cc/health` should return `{"status":"ok"}` once routing is ready.

Register the Telegram webhook with `secret_token` matching `telegram.webhookSecret`,
set `telegram.transport` to `webhook`, and enable the intended schedules. Preserve pending
updates when changing registration. Startup does not register or remove webhooks.

## Protocol references

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)
- [Home Assistant to-do actions](https://www.home-assistant.io/integrations/todo/)
- [Google Docs API](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get)
