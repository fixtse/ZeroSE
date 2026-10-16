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

For development outside Docker, install `ffmpeg`, `poppler-utils`, `catdoc`, and
`edge-tts==7.3.0` (for example, `pipx install edge-tts==7.3.0`). The container includes
them. Voice synthesis uses this pinned client because Microsoft now requires the
Sec-MS-GEC v2 handshake; the former Node client still generated v1 tokens.
PDF text, DOC/DOCX, XLS/XLSX, images, text, JSON/XML,
audio, video notes, and video attachments have native handling. Audio transcription
uses the existing ASR service; image interpretation uses Codex local-image input.
Scanned PDFs without a text layer currently require sending their pages as images.

Telegram videos (including video notes) and forwarded audio/voice messages return the
transcript from the configured `media.asrUrl` speech-to-text service as a text reply.
Direct audio/voice messages remain spoken requests to Zero. Replying to an audio or
video message also returns its transcript. Transcripts are never executed as commands.
Set `media.audioExtractionUrl` to the FFmpeg service's `/video/extract/audio` endpoint
to extract video audio remotely before sending the returned WAV to `media.asrUrl`.
The extraction service receives a multipart `file` upload. If no extraction URL is
configured, video extraction uses local `ffmpeg`. Direct audio goes straight to STT.
Tests use local HTTP fixtures and do not require the FFmpeg binary or live services.

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

## Wake-up briefing

Set `schedules.morning` to `""` to disable the fixed morning time while keeping
reset and memory-consolidation schedules enabled. Home Assistant can call
`POST /v1/triggers/morning` with `Authorization: Bearer <config.apiKey>` when
`input_boolean.dormir` changes from `on` to `off`. No body is required. This
queues the usual morning briefing for `telegram.notificationChatId`, using the
same session ordering and daily deduplication key as the timed schedule. Repeated
calls return the existing job, including failed jobs, without replaying delivery.
The endpoint requires `schedules.enabled` and a configured notification recipient.
Keep the bearer value in a private Home Assistant secret or credentials file, and
use an authenticated HTTP action with no automatic retries. Reloading the automation does not send a briefing.

## Capabilities

- Telegram text/media/document input, replies to text, and transcription of replied-to voice/video notes.
- Spanish responses, Markdown formatting, message splitting, typing feedback, and optional voice replies.
- Google Calendar availability and event CRUD; Google Tasks CRUD; `/clean` clears the configured task list.
- `/nuevo` starts a new conversation while retaining long-term memory.
- Google Docs personal context, appending context, and Markdown-to-document creation with PDF export URLs.
- Codex web search, public URL reading, and Brave image search when configured.
- Home Assistant shopping-list reads/additions/completion/removal, sensor discovery/current values,
  and up to seven days of recorded sensor history. Sensor access can be restricted to named entities.
- On-demand home/away and known-zone awareness, with GPS accuracy, geocoded address and source timestamps for location-aware suggestions.
- Gemini semantic memory retrieval with category/date filters, stored and searched using pgvector.
- Native memory consolidation, daily short-term reset, morning agenda, and optional event reminders.
  The original disabled 15-minute reminder routine remains disabled by default.
- Memory consolidation considers both user messages and assistant replies, retaining relevant advice and plans with explicit attribution. Prior suggestions remain distinct from user decisions or completed actions, and can be recalled through `memories_get`. Consolidation runs on the existing schedule; important context can also be saved immediately with `memory_save`.

Long-term memory search returns at most three deduplicated summaries within a 900-token
response budget. New saves and consolidation can store summaries of up to 480 characters;
legacy long records return explicitly labeled excerpts. `memory_read` fetches full text by
ID within the current session or configured shared profile. `memory_save.supersedes` accepts
IDs of facts explicitly corrected by the user: replacing them is transactional, excludes
old facts from search, and retains their text and replacement ID for provenance. Existing
records are upgraded additively on startup, without rewriting embeddings or generating
summaries for the existing corpus.

Ranking combines up to 100 vector candidates and 100 PostgreSQL full-text candidates over
memory text and tags using reciprocal rank fusion. Vector candidates retain full-precision
cosine scoring and the existing similarity threshold; keyword matches can surface even
without an embedding. Query embeddings use `RETRIEVAL_QUERY`, paired with
`RETRIEVAL_DOCUMENT` for saved memories. Deduplication conservatively ignores case,
punctuation and articles while retaining attribution, negations, quantities and word order.
It does not automatically merge semantic paraphrases or infer that facts are superseded.

Application tool responses are capped at 1,200 tokens, counted over serialized JSON with
the local `o200k_base` tokenizer (an accounting convention, not total agent context usage).
Calendar, task, sensor and shopping lists accept `offset` and `limit` (default 20, maximum
50); responses include `total` and `next_offset`, and the token budget may reduce page size.
List projections omit verbose descriptions and notes; use the corresponding get tool for
details. Oversized records, URL reads, forecasts and other large reads return JSON-fragment
pages: repeat the read with `result_offset=next_offset` and otherwise identical arguments.
Reassemble pages before interpreting a partial record. Each read is a fresh observation;
source changes can shift pages. Mutations return small receipts and must never be repeated
to page through a result. Sensor history defaults to sample counts, first/last observations,
and numeric min/max/sample mean; `mode=raw` returns paginated original readings. Unknown
and unavailable readings are excluded from numeric statistics. These limits do not rotate
conversation threads or control Codex's built-in web-search output.

Location-aware answers use the read-only `location_get` tool when relevant. Configure
`homeAssistant.locationEntity` with your `person.*` or `device_tracker.*` entity
(default `device_tracker.galaxy_s26`) and `homeAssistant.geocodedLocationEntity`
(default `sensor.galaxy_s26_geocoded_location`). Set either to an empty string to
disable that source, or both to disable the tool. These explicitly configured location
entities are separate from the sensor allowlist; general sensor access stays restricted.
Each source includes its own timestamps and age so the assistant can qualify old or
conflicting observations. Location is read on demand, without forcing phone updates.

Google services use separate OAuth grants for their required scopes. Home Assistant list writes are followed by a read-back verification. Uncertain
mutating operations are not retried automatically. Interrupted jobs become failed jobs
requiring inspection rather than silently replaying their actions.

## Agent tools and discovery

Codex's OpenAI built-in web search is enabled in `live` mode at app-server startup
and explicitly on every thread start/resume. It uses the shared Codex login and does
not require a Brave key. The agent is instructed to search for current public information,
including weather for the requested location and date, and include source links.
If no location is given, it can consult `location_get` or ask the user. The optional
Home Assistant forecast only covers its configured location.

The application tool catalog is assembled in `src/main.ts`:

| Capability | Tool names | Registration condition |
| --- | --- | --- |
| Calendar | `calendar_list`, `calendar_availability`, `calendar_get`, `calendar_create`, `calendar_update`, `calendar_delete` | Google OAuth configured |
| Tasks | `tasks_list`, `task_get`, `task_create`, `task_update`, `task_delete` | Google OAuth configured |
| Documents/context | `context_save`, `document_create` | Google OAuth configured |
| Location | `location_get` | Home Assistant token and at least one location entity |
| Sensors | `sensors_list`, `sensor_get`, `sensor_history` | Home Assistant token |
| Shopping | `shopping_list_get`, `shopping_list_change` | Home Assistant token |
| Local forecast | `weather_forecast` | Home Assistant token and weather entity |
| Memory | `memories_get`, `memory_read`, `memory_save` | Always |
| Image search | `image_search` | Brave API key |
| Public page text | `url_read` | Always |

Discovery is eager: registration builds a `Tools` registry; `definitions()` converts
each tool's Zod input schema to JSON Schema. The adapter sends names, descriptions
and schemas as `dynamicTools` in `thread/start` and `thread/resume`, so the model sees
the enabled catalog before selecting a tool. There is no application-side deferred
tool search, MCP discovery, or keyword router. Calls arrive as `item/tool/call`;
the registry validates arguments, invokes the adapter, audits success/failure and
returns the result to Codex. Internal extraction turns can omit application tools.

Built-in web search is provided separately by Codex, not by this registry, and does
not appear in the startup log's application `tools` list or PostgreSQL tool audit.
That list shows only tools registered for the current configuration. Disabled
integrations are omitted; registered Google tools still need the appropriate OAuth
grant when called. Shell execution, browser automation, apps and multi-agent features
are disabled by the adapter; threads use a read-only sandbox.

See the official [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [app-server dynamic tools documentation](https://learn.chatgpt.com/docs/app-server).

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
