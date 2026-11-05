> [Back to Zero Assistant](../README.md) · Installation, administration and developer reference.

<img src="../assets/icon.png" alt="Zero assistant icon" width="112" align="right">

# Zero Assistant

A personal TypeScript assistant with Home Assistant, Google services, Telegram,
and semantic memory. It uses Codex app-server and a shared Codex login.

The project icon is in `assets/icon.png`, served at `/icon.png` and the favicon paths.
Its generation prompt is recorded in `assets/icon.prompt.txt`.

## Architecture

```text
src/domain/                  Configuration contracts, models, date calculations
src/application/ports.ts     Contracts implemented by adapters
src/application/use-cases/   Messages, notifications, automatic memory extraction
src/application/             Durable job execution, memory retrieval, scheduling
src/adapters/inbound/        Authenticated HTTP, Telegram polling, agent tool bindings
src/adapters/outbound/       Codex, Home Assistant, Google, PostgreSQL, media, embeddings
src/main.ts                  Composition root
```

Application code depends on ports, and domain code has no framework dependencies.
An architecture test enforces these boundaries. Tests also cover concurrency,
delivery failures, duplicate updates, interrupted jobs, memory, DST, authentication,
Google OAuth permission selection, and the Codex protocol.

## Run

Requires Node 26.x and **pnpm 11+**, pinned to 11.28.6 through `packageManager`.
Install the pinned package manager with `npm install --global pnpm@11.28.6`. Node 26 does not bundle Corepack.

```sh
pnpm install --frozen-lockfile
pnpm check
TEST_DATABASE_URL=postgresql://.../assistant_test pnpm test
pnpm build
pnpm start
```

Service settings are managed in **Settings → Configuración de servicios** and stored
with authenticated encryption in PostgreSQL. Secret fields are never returned to the browser.
Saving shared infrastructure settings requires an explicit restart. AI models and reasoning
effort are managed only in **Proveedores IA**; Codex CLI execution parameters are available
inside its provider. Telegram connections and webhooks belong to each assistant; allowed
users, voice replies, Google Docs/Drive/Calendar/Tasks and Home Assistant connections belong
to each user. These settings are not exposed or editable through global service settings.
Fresh installations contain only the Zero assistant, with no user accounts or connected
services. Create your administrator in the web setup, then configure accounts and Home
Assistant URLs and entities for your installation. Existing installations retain their
configured accounts, assistants and bindings.

Setup opens the service settings after creating the administrator. All integrations are
optional: leave them empty and choose **Configurar más adelante** to continue. They can
be configured later in Settings. A fresh database is initialized automatically with
safe defaults; no configuration file or manual import is required.

Bootstrap requires `ASSISTANT_DATABASE_URL`. On first startup, Zero automatically
generates a private 256-bit API/encryption key in `data/bootstrap.key` before web setup
opens. The key is reused on every restart; back it up together with PostgreSQL and
keep the persistent data directory when replacing containers. No key entry is required.
An existing `ASSISTANT_API_KEY` (at least 24 characters) takes priority. Optional overrides include `ASSISTANT_HOST`, `ASSISTANT_PORT`, `ASSISTANT_DATA_DIR`,
`ASSISTANT_CODEX_HOME` and `ASSISTANT_SECRETS_KEY`. These infrastructure values must
be available before web setup can start. Keep encryption keys stable and private.
`config.ts` only loads bootstrap environment settings; service defaults and validation
live in `config-schema.ts`. `config.json` and `ASSISTANT_CONFIG` are no longer read.

Existing installations retain their saved PostgreSQL settings. Before upgrading an
installation that still uses only a legacy JSON file, save its service settings through
the current admin interface and set `ASSISTANT_API_KEY` to its existing API key.
Preserve any existing `ASSISTANT_SECRETS_KEY`. Keep a private backup of the legacy
file until the saved settings have been verified. Code-only work does not change live state.

Prompts remain in `data/prompts.json`, and attachments in `data/`. PostgreSQL stores jobs,
conversations, schedules, audit records, and long-term memory. These private files are
excluded from Git and Docker images. Use `.env.example` for bootstrap configuration.

```sh
docker compose pull
docker compose up -d --wait
docker compose ps
docker compose logs --tail 30
pnpm run doctor
```

### Optional embedded PGlite

PostgreSQL remains the default. For a new single-instance installation, PGlite can
persist the same PostgreSQL schema and pgvector/Mem0 data in `data/pglite`, without
a separate database container:

```sh
# This file is standalone; do not combine it with compose.yaml.
docker compose -f compose.pglite.yaml pull
docker compose -f compose.pglite.yaml up -d --wait
# To build with the existing development definition:
# docker compose -f compose.pglite.yaml -f compose.build.yaml build
```

Outside Docker, install `util-linux` (for `flock`), leave `ASSISTANT_DATABASE_URL`
unset, and run `ASSISTANT_DATABASE_BACKEND=pglite pnpm start` (or `pnpm dev`).
The Home Assistant add-on exposes the same choice as `database_backend: pglite`;
leave its `database_url` empty. Existing add-on options retain PostgreSQL by default.

PGlite uses a private Unix socket and serializes transactions on one embedded
engine. It is intended for one Linux Zero instance, not multiple replicas or an
external database service. An OS lock prevents concurrent processes from opening
its files and releases automatically on process exit. Stop Zero before running
administrative commands with `ASSISTANT_DATABASE_BACKEND=pglite` or taking a file
backup. Back up the complete data directory and bootstrap/encryption key together;
restore with the same pinned PGlite version before attempting an engine upgrade.
Capacity and throughput depend on the device's memory and disk; this option has no
separate server's concurrency or resource isolation.

Choosing a backend never imports existing PostgreSQL records. Switching an existing
installation to an empty PGlite directory would create a new installation. Retain
the original backend and backups until an explicit migration has been verified.
The example's Python `provider: "custom"` HTTP URL is not a complete Mem0 adapter;
Zero keeps its tested JavaScript Mem0 pgvector adapter through the local bridge.

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
In **Settings → Video and voice**, select **ClipSE Whisper** under audio transcription,
enter the full `/transcribe` URL, and select the Whisper engine and model.
**Service default** leaves that choice to ClipSE. Faster Whisper offers `small`,
`medium` and `large-v3-turbo`; Hailo offers `whisper-tiny`, `whisper-base` and
`whisper-small`. Changing the engine resets the model to the service default.
The model selector only lists models for the selected engine. Choose an engine
before choosing a model; service-default mode delegates both choices to ClipSE.
Recognition language uses a searchable dropdown with automatic detection.

For configuration files, set `media.asrProvider` to `"clipse-whisper"` and
`media.asrUrl` to its full `/transcribe` URL (for example,
`http://clipse-whisper:8000/transcribe`). Keep the profile STT engine set to
**Predeterminado**. Zero uploads the audio as multipart `file`, reads the returned
`text`, and sends nonempty `media.asrModel` and `media.asrWhisperProvider` as
`model` and `provider`. Blank values use ClipSE’s defaults. A configured STT
language such as `es-ES` is sent as `es`; blank or `auto` uses language detection.
The default `"legacy"` provider preserves the existing multipart `audio_file` API.
No live configuration or services are changed automatically.

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

The optional `ASSISTANT_IMAGE_VALIDATION_CALLBACK` secret sends build completion notifications.
Notification delivery failures appear as warnings and do not block automatic deployment;
verification, image build and publication failures still fail the workflow. Replace the secret
when its callback destination expires or is disabled.

On the deployment host:

```sh
cp .env.example .env
# Set ASSISTANT_POSTGRES_PASSWORD in .env to a fresh value from: openssl rand -hex 32
# For a fresh installation, set ASSISTANT_API_KEY in .env and configure services in Settings.
mkdir -p data
docker login ghcr.io -u fixtse
docker compose pull
docker compose up -d --wait
```

Use a GitHub classic personal access token with `read:packages` at the Docker login prompt.
Keep bootstrap secrets in `.env` and preserve the existing `.codex` mount; neither enters the image.
The configured bind paths must exist and be accessible by UID 1000. `.env` can override
the image, configuration file, data directory, and shared Codex directory.

For controlled upgrades or rollback, set `ASSISTANT_IMAGE` in `.env` to a previously
published `sha-<full-commit>` tag or an image digest, then run the pull/up commands again.
CI builds `linux/amd64` and `linux/arm64` concurrently on native GitHub runners
(`ubuntu-24.04` and `ubuntu-24.04-arm`), without QEMU emulation. Verification runs
alongside the image builds; only a successful verification and both image builds
allow the publish job to update the multi-platform tags. Pull requests build both
architectures without publishing. BuildKit caches all intermediate layers in separate
GitHub Actions cache scopes per architecture; backend and admin frontend stages are
independent, so changing one can reuse the other's compiled layers. The first run
with these cache scopes starts cold. The publish job reports the published digest. The production Compose file has no build
step. Automatic deployment is optional and uses the signed host webhook described below.

### Deploy successful GitHub Actions builds automatically

The optional host worker receives signed GitHub `workflow_run` webhooks at
`https://assistant.example.com/github/deploy`. It accepts only successful `main` builds from
`fixtse/node-assistant` using `.github/workflows/images.yaml`. Pull requests, other
repositories, other branches, failed runs, and older out-of-order runs are ignored.
The existing image workflow needs no deployment credentials or Docker access on the host.

Build the TypeScript host worker with `pnpm build`. Create a private `.env.deploy`
(mode `0600`) beside `.env`, using a fresh secret of at least 32 characters:

```dotenv
ASSISTANT_DEPLOY_SECRET=replace-with-a-fresh-random-secret
ASSISTANT_DEPLOY_REPOSITORY=fixtse/node-assistant
ASSISTANT_DEPLOY_PORT=8790
ASSISTANT_DEPLOY_NOTIFY_CHAT=replace-with-your-private-chat-id
ASSISTANT_DEPLOY_NOTIFY_ASSISTANT=zero
# Ensure this PATH contains node and docker when launched by systemd.
# PATH=/path/to/node/bin:/usr/local/bin:/usr/bin
# For unattended registry access, point at a private Docker config that works without a desktop login.
# DOCKER_CONFIG=/private/path/to/docker-config
```

Set the notification chat explicitly; use the ID of an assistant with an enabled
Telegram connection for `ASSISTANT_DEPLOY_NOTIFY_ASSISTANT` (defaults to Zero).
Set this value to the ID of an existing saved assistant to use another connection.

Add `ASSISTANT_DEPLOY_WEBHOOK_URL=http://127.0.0.1:8790/github/deploy` to `.env`.
Install `deploy/assistant-deploy.service` in `~/.config/systemd/user/`, adapting its
working directory if needed, then run `systemctl --user daemon-reload` and
`systemctl --user enable --now assistant-deploy.service`. Enable user lingering
(`loginctl enable-linger "$USER"`) so the service survives logout. The worker listens
only on loopback; the assistant forwards the public webhook path without altering the
signed body. Bootstrap the new assistant image once to expose that proxy route.

In the repository's GitHub webhook settings, add the HTTPS URL above, select JSON,
use the same private secret, leave TLS verification enabled, and select only
**Workflow runs**. Confirm the initial ping succeeds. No Telegram webhook changes
are needed.

The worker records deployments in PostgreSQL, serializes them, and deduplicates
run/attempt pairs. It pulls the `sha-<commit>` image, verifies its revision label,
pins the resolved digest in `.env`, and runs Compose with `--no-deps --wait` for
**assistant only**. PostgreSQL and its volume are never restarted or cleared.
Previous `.env` files are backed up privately under `data/deployment-backups/`.
A healthy rollout sends a Spanish notification through the selected assistant to the configured chat;
a failed rollout sends a failure notice. Uncertain Telegram deliveries are not retried.
Deployment notifications do not enter conversation history or memory.

Interrupted deployments become failed records on worker restart and are never replayed.
Failed or duplicate deliveries are not deployment retries; inspect the current container
and journal before explicitly rerunning a build. Inspect service logs with
`journalctl --user -u assistant-deploy.service` and recent results with
`SELECT run_id, attempt, sha, status, detail FROM deployment_runs ORDER BY id DESC`.
The controller and Compose definitions are host-managed; image deployment does not reset
or pull the host Git checkout. Stop automatic deployment with
`systemctl --user disable --now assistant-deploy.service` and deactivate the GitHub hook.

The host controller can also forward one explicitly configured repository to a separate
loopback receiver through the same public endpoint. Set
`ASSISTANT_DEPLOY_FORWARD_REPOSITORY=fixtse/tradeeSE` and
`ASSISTANT_DEPLOY_FORWARD_URL=http://127.0.0.1:8791/github/deploy` in `.env.deploy`.
Rebuild and restart only `assistant-deploy.service` to apply host controller changes.
Forwarded bodies and signatures remain unchanged; the destination authenticates them
with its own secret and owns its deployment queue. This grants no Docker access to
the assistant application and does not change its own deployment behavior.

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
{ "session": "personal", "text": "¿Qué tengo que hacer hoy?", "name": "Example user" }
```

It returns HTTP 202 with a `jobId`. Poll `GET /v1/jobs/<jobId>` with the same
authorization for status, output, or error. An optional `Idempotency-Key` header
deduplicates submissions within a session. Jobs from the same session run in order;
separate sessions can run concurrently.

Telegram supports `disabled`, `webhook`, or `polling` transport. Polling needs no
public ingress and refuses to start if a webhook already exists. Webhook mode uses
`POST /telegram/assistants/<assistant-id>/webhook` and validates `X-Telegram-Bot-Api-Secret-Token` plus the
independent user/group access policy. Neither transport registers or removes a webhook on startup.

## Wake-up briefing

Each profile configures **Alertas y recordatorios → Agenda y resumen de la mañana**.
New profiles start with event reminders and the morning briefing disabled. These proactive notifications are available to Telegram profiles; Home Assistant-only profiles can configure their daily session reset. Event reminders
require that profile's connected Google Calendar and calendar permission; Zero checks every
15 minutes for events in the next 15 minutes and deduplicates delivery per profile.

For the morning briefing, choose a local clock time or a Home Assistant entity and target
state (`sensor`, `binary_sensor`, or `input_boolean`). Home Assistant evaluates a native
WebSocket state trigger; non-admin HA connections use an entity-scoped state subscription
instead. Zero queues the briefing in the same conversation. It does not poll
entity state or replay state changes missed while disconnected. Initial, unknown and unavailable
states do not count as waking up. Both trigger modes share one briefing per profile and local
date. Agenda and tasks use only that profile's enabled services; neither permission is required
for a weather-only briefing. Daily session resets are also enabled and timed per profile; they clear conversation context without deleting long-term memory. There is no global schedule switch.

The retired global settings are imported once into profile preferences and removed from stored service settings. Existing daily reset preferences are retained for each profile. For existing
wake-up installations, Zero reads the existing `assistant_morning_on_wakeup` automation's
entity and target state and keeps them active in the common entity selector. The original
HA automation is preserved. Its authenticated `POST /v1/triggers/morning` callback remains
compatible while the imported entity/state are selected and shares the native trigger's daily
key, so it cannot cause a second briefing. After changing the profile's trigger, that legacy
callback cannot override the new preferences. If discovery is unavailable, the original callback
continues working and the editor shows that import is pending; no settings are silently disabled.
Discovery is read-only and resumes when the configured HA connection is available.

Wake-up reminders such as “remind me in two days when I wake up” use
`wake_reminder_create` with a local calendar date. They are appended to the matching chat's
wake-up briefing, without guessing a clock time or sending a separate alert. They are completed
only after successful delivery and are not replayed on later dates. Fixed-time briefings do not
consume them. Repeated callbacks return the existing job, including failed jobs, without
replaying delivery.

The briefing reads Home Assistant's daily weather forecast. If `homeAssistant.weatherEntity`
is empty, it discovers the source when exactly one weather entity supports daily forecasts;
otherwise, set that field explicitly to select the location.
When available, the briefing also reads up to 24 hourly forecast entries, with source
units, to describe the rest of today's temperature, conditions, rain and wind in local
time and suggest practical adjustments. Providers without hourly forecasts retain the
daily summary without invented hourly detail.

The briefing also pairs hourly forecasts with up to 20 upcoming timed outings:
events with a physical location or an explicit outdoor activity. Home/virtual,
cancelled, declined, all-day and otherwise unlocated events are excluded from this
matching. It includes an indicative 30-minute departure margin and 15-minute return
margin, not calculated travel time. The forecast covers the configured home area;
it is **not a verified forecast at the event's destination**, especially another city.

With the unified `assistant_zero` HA integration, the owner's built-in weather
rule also subscribes to hourly forecast updates. Material hourly changes in the
next 24 hours send a notice even without a calendar event or calendar access.
When available, the current calendar adds context about affected outings and their
margins; missing, cancelled, unrelated events or a failed calendar read do not block
the weather notice. It can report worsening or improving rain,
storms, snow, fog, wind, temperature or UV. Small changes, rotated forecast periods,
past forecast hours and updates beyond that horizon do not send a notice. Examples
of numeric filters include a 20-point rain-probability change reaching at least 40%,
wind crossing 30 km/h, a 5 °C temperature change, or a 2-point UV change reaching 6.
Thresholds are relevance filters, not official warning levels.

Daily alerts retain their existing behavior. Daily/hourly baselines and cooldowns
are independent; sleep gating and the existing 30-minute cooldown still apply.
Hourly changes are captured in HA, never reconstructed by refetching an old forecast.
Calendar access is required only for optional event context. Notices containing
calendar details recheck that permission before delivery; the normal delivery gates
also recheck access and sleep state. Hourly updates use the existing
weather-alert text-only delivery policy.

For an existing installation, deploy the updated assistant before running
`pnpm rules:install-home-assistant` (which restarts HA), then
`pnpm rules:enable-owner-weather`. The hourly upgrade is capability-gated and claimed
once for an active, confirmed installation. Paused/cancelled rules and uncertain
installations are never automatically retried. The baseline is seeded silently;
installation does not replay old forecast changes or send a test message.
Keep the bearer value in a private Home Assistant secret or credentials file, and
use an authenticated HTTP action with no automatic retries. Reloading the automation does not send a briefing.

## Capabilities

- Telegram text/media/document input, replies to text, and transcription of replied-to voice/video notes.
- Both Telegram bots can use Codex's built-in image generation when asked, using the existing Codex login (no separate image API key). Successful image-generation completion events are attached to the requesting chat as original PNG/JPEG/WebP/GIF files, preserving quality and transparency. Generated bytes are validated and bounded by `media.maxBytes` (and Telegram's 50 MB file limit); model-supplied paths and URLs are never read for delivery. Image generation is disabled for background turns with tools disabled and for HTTP chat. Failed or uncertain generation/delivery is not automatically replayed. Codex account/model image-generation availability still applies.
- Spanish responses, Markdown formatting, message splitting, typing feedback, and optional voice replies.
- Google Calendar availability and event CRUD; Google Tasks CRUD; `/clean` clears the configured task list.
- `/nuevo` starts a new conversation while retaining long-term memory.
- Google Docs creation from HTML, formatted append/replace in existing documents, and PDF export URLs.
- Codex web search, public URL reading, and Brave web search and Brave, SearchAPI or SerpApi image search when configured.
- Home Assistant shopping-list reads/additions/completion/removal, sensor discovery/current values,
  and up to seven days of recorded sensor history. Sensor access can be restricted to named entities.
- On-demand home/away and known-zone awareness, with GPS accuracy, geocoded address and source timestamps for location-aware suggestions.
- Dedicated Telegram reminders and countdown timers, with cancellation, snooze, pause/resume and optional fixed-interval reminders. Home Assistant owns their event-driven schedules; they do not create calendar events.
- Conditional sensor alerts and forecast-update rain alerts, scoped to each chat's permitted Home Assistant connection.
- OpenStreetMap place/address lookup and driving distance/time estimates, with clickable Google Maps links. All place suggestions must include Maps links, including suggestions obtained through web search.
- Saved memories are managed in **Usuarios → perfil → Memoria**, with scoped search, categories, full details, creation, corrections and confirmed deletion. Conversation search remains attributed and chat-scoped across daily resets.
- Mem0 OSS long-term memory on the existing PostgreSQL/pgvector database, using Zero's configured embedding provider and category/date filters.
  Existing installations require the explicit [offline memory migration](./mem0-migration.md) before starting this version.
- Automatic Mem0 memory extraction after conversations, daily short-term reset, morning agenda, and optional event reminders.
  The original disabled 15-minute reminder routine remains disabled by default.
- Mem0 automatically extracts durable context from each completed conversation in a separate queued job. It retains relevant user facts, advice and plans with explicit attribution, preserving the distinction between assistant suggestions, user decisions and completed actions. Important context can also be saved immediately with `memory_save`. Extraction uses the profile's configured AI model and does not depend on scheduled events.

### Reminders, timers and conditional alerts

Clock-time reminders, countdowns and fixed-interval repetitions are stored in Zero's
existing PostgreSQL database and run without Home Assistant. One bounded worker
checks an indexed set of due rules approximately once per second. Accepting an
occurrence, recording its receipt, advancing the rule and queueing its notification
share a transaction. Competing ticks cannot enqueue the same occurrence twice.
No model runs while waiting for a deadline or delivering an ordinary reminder.
Reminders, timers and conditional alerts can instead save an optional
`assistant_request`: a user-authorized task to execute as a full assistant turn
when the trigger fires. `message` remains its short label. The turn uses the
chat's assigned assistant, conversation, current tools and permissions, and sends
its result directly to that chat. This supports arbitrary assistant requests,
including fresh searches and tool actions; it is not limited to canned reports.
Use `operation=set_request` on `reminder_change` or `alert_change` to update an
existing rule, or pass `assistant_request=null` to restore plain notifications.
This local update preserves the installed schedule, rule ID and generation.
Already queued occurrences whose saved request has changed are suppressed.
Triggered turns retain queue ordering and deduplication and are never automatically
replayed after an interruption or an uncertain action. Existing plain-message
rules are not silently converted into assistant tasks.

The tools remain `reminder_create`, `timer_start`, `reminders_list`, `reminder_get`
and `reminder_change`; agents never choose a scheduler. `reminder_create` takes an
ISO timestamp with offset and optional `repeat_seconds`, a fixed elapsed interval
rather than a DST-aware local calendar schedule. Pause/resume, snooze and cancellation
invalidate earlier generations, including already queued notifications. Existing
session ordering is retained; an active conversation can delay delivery. A completed
rule means its notification was queued, not that Telegram acknowledged delivery.

Future local deadlines survive restart. One-shot deadlines missed before startup
expire without replay; repeating reminders skip missed occurrences and retain their
original interval anchor. During normal operation a deadline more than 60 seconds
late is skipped in the same way. Interrupted/uncertain installations are not retried
automatically. Existing Home Assistant rules retain their backend identity and are
not silently copied to Zero's scheduler, even if HA becomes unavailable.

Install [Zero Assistant](https://github.com/fixtse/ha-zero-assistant) through its
README's HACS button for sensor, location and weather alerts, wake-up briefings and
other HA features. The single `assistant_zero` integration retains its conversation,
shared settings and existing reminders; do not install a separate `assistant_rules`
component. These conditions continue to be evaluated in HA, with no heartbeat or
periodic callback to the assistant. Callbacks carry rule identities, generations and
timestamps; permissions and generation checks apply before enqueue and delivery.
Normal enabled Telegram chats can create local reminders without an HA connection;
conditional alerts still require the chat's permitted HA connection. Scheduling
from HTTP chats remains unsupported.

For existing standalone HA installations, follow the explicit offline migration in
[integration notes](../integrations/home_assistant/README.md). It preserves rule storage
and voice identities and requires a private backup and authorized HA restart.

`alert_create` watches permitted sensor/binary-sensor equality and numeric
above/below conditions continuously, with an optional hold duration. Unknown,
unavailable or nonnumeric readings interrupt numeric holds. An incomplete hold
starts again after an HA restart rather than assuming uninterrupted continuity.
Recurring alerts rearm only after a valid nonmatching state and observe cooldowns;
HA schedules the cooldown deadline without polling the assistant.

The original owner's Zero chat has one built-in, recurring **all-weather forecast
change alert**, enabled automatically at startup without a chat request. It uses a
24-hour horizon and a **30-minute cooldown**. Home Assistant suppresses it unless
`input_boolean.dormir` is explicitly `off`; missing/unavailable sleep state also
keeps it quiet. Forecast baselines continue updating during sleep, so waking does
not replay missed changes. The assistant rechecks the gate before queueing and
before delivering an already-queued notification. This default is scoped to the
original owner, not every enabled user or group. Pausing/cancelling it explicitly
is preserved across restarts. Existing uncertain installations are not replayed.

For an existing deployment, install the updated HA integration and explicitly
activate the same idempotent built-in rule without restarting the assistant:

```sh
pnpm rules:install-home-assistant
pnpm rules:enable-owner-weather
```

The activation command requires the live `ASSISTANT_DATABASE_URL`; use the same private encryption key
as the running assistant. It sends no test message. If no weather entity was
configured, the scheduler selects it only when HA has exactly one daily forecast
source; multiple candidates require `homeAssistant.weatherEntity`.

`weather_alert_create` establishes a baseline from Home Assistant's daily forecast
and subscribes directly to forecast updates, independently of current weather-state
changes. New alerts default to `mode=any_change`: conditions, temperature, wind,
precipitation and other changes within the selected horizon can trigger, including
dry thunderstorms, snow, hail, fog, exceptional weather and clearing skies.
`mode=conditions` with a nonempty `conditions` list restricts notifications to
selected Home Assistant conditions (for storms, `lightning` and `lightning-rainy`).
`mode=rain` keeps rain/precipitation monitoring with `minimum_probability`
(default 30%). That probability threshold does not filter storms or other modes.
Persisted rules without a mode retain their original rain-only behavior.

Weather callbacks now capture the changed daily periods, before/after values and
HA's temperature, precipitation and wind units. The evidence is bounded to twelve
periods and known weather fields, persisted with the queued event, and never
replaced by a newer forecast at delivery time. Provider metadata alone does not
produce an alert. Zero explains the change and practical implications directly
in the notification, keeping simple updates brief and recommending adjustments
only when justified. It uses an isolated, tools-disabled model turn, without
changing the owner's conversation. If generation fails, a bounded factual
comparison is delivered instead. There are no idle model calls: interpretation
runs only for accepted weather events, behind the existing sleep/cooldown gates.
Deploy the assistant before running `pnpm rules:install-home-assistant` to install
native integration version 2.3.0. Old callbacks without evidence cannot reconstruct
the original change and say so rather than inventing details.

The selected horizon defaults to 24 hours; the current day's daily period is
included. General/condition filters compare both forecast snapshots within the
same window, so changes outside that window or mere dictionary/period reordering
do not trigger. The first observation is a baseline, identical updates do not
repeat, and subsequent qualifying changes observe the configured cooldown
(default thirty minutes). These are forecast-change notifications, not an official
severe-weather warning feed.
`alerts_list` and `alert_change` inspect/pause/resume/cancel both alert types;
`reminder_get` retrieves details. Arbitrary web monitoring is unsupported.

Home Assistant persists rule state before making **one** callback attempt. Failed,
uncertain or interrupted callbacks and Telegram deliveries are never automatically
retried. A remote setup failure leaves the local rule ID and an `uncertain` status
available for inspection; it is not blindly reinstalled. Existing heartbeat-era
rules are claimed and migrated once at assistant startup; interrupted migrations
are also left uncertain. PostgreSQL retains the old heartbeat table if present,
but the new application never reads or writes it.

### Places, routes and personal history

`places_search` uses Photon/OpenStreetMap for named places and addresses with an
optional coordinate bias. It is not a comprehensive nearby business catalog and
does not supply verified opening hours or ratings. `route_estimate` uses OSRM for
driving estimates **without live traffic**. Walking, cycling and transit requests
return a Maps directions link without an invented duration. Every place result
has a Google Maps search link and OSM source attribution; route results include
a Maps directions link. The reply instructions also require a Maps link next to
every suggested place, regardless of its source.

These tools use the existing `web` permission. Queries and coordinates explicitly
supplied to them are sent to the configured public providers. Public demo servers
have no availability guarantee and are intended for low-volume use; requests are
serialized and limited to less than one per second across chats. Set
`ASSISTANT_PHOTON_URL` / `ASSISTANT_OSRM_URL` to self-hosted compatible endpoints
when needed. No Google Maps API key is required.

Place recommendations consult current location, previous visits/preferences and
recent suggestions on demand, prioritizing new options rather than repeatedly
offering the same venue. When memory is enabled, outing history uses category
`Actividades` with `estado:recomendado`, `estado:planificado` or `estado:visitado`,
preserving place/locality, known date and Maps link. Only a user-confirmed visit is
recorded as attended; accepting a plan or a past calendar entry does not prove a visit.
Disabled memory and the selected memory policy remain in force. No growing
venue/history catalog is injected into each turn.

Suggestions also consider weather at the destination and intended hours, favoring
indoor/outdoor options appropriately. `weather_forecast` supports `type=hourly`
(up to 24 entries with units), with daily remaining the default; it is available
with HA credentials even when the sole source is discovered automatically.
Other destinations or dates require web lookup, not an assumed home forecast.
Once the user accepts a specific outing, the assistant checks availability and
duplicates, asks only for missing schedule details, and creates the calendar event
with agreed start/end, physical location and a Maps link. Suggestions and tentative
interest do not create events; uncertain writes are not automatically repeated.

`memory_list` browses saved facts; `memory_read` retrieves details and
`memory_delete` erases selected saved text, summaries, tags and vectors only on an
explicit user request. Tombstones retain IDs/source deduplication for integrity.
Deletion does **not** erase prior conversation messages, an active agent's context,
external context documents, or private backups. Use `memory_save.supersedes` for
corrections. Memory management honors the existing shared-profile and disabled
memory rules.

`conversation_search` searches keywords and optional date bounds across stored
messages in the current chat, including messages hidden by daily resets;
`conversation_read` retrieves a full message with author and date. These tools
never search another user/group/bot's conversation and remain available when
long-term memory is disabled. Lists/details use the standard pagination and
response budgets rather than injecting history into every turn.

Memory categories are inferred for new records; there is no predefined category list in settings.
Legacy `{{categories}}` and `{{tags}}` prompt placeholders receive empty strings. No growing
catalog is injected into turn instructions. The model can call `memory_catalog` on demand to
discover existing categories or tags within its current session/shared profile, with filtering,
pagination and response budgets. Existing categories and search filters remain available.

Long-term memory search returns at most three deduplicated summaries within a 900-token
response budget. New saves and automatic extraction can store summaries of up to 480 characters;
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
(empty until configured) and `homeAssistant.geocodedLocationEntity`
(empty until configured). Set either to an empty string to
disable that source, or both to disable the tool. These explicitly configured location
entities are separate from the sensor allowlist; general sensor access stays restricted.
Each source includes its own timestamps and age so the assistant can qualify old or
conflicting observations. Location is read on demand, without forcing phone updates.

`document_create` accepts a title and required `html` to create a new Google Doc.
Zero always supplies HTML; the tool does not accept Markdown. After success, Zero includes the
returned document URL and PDF download URL in its reply. These are links rather than an attached
PDF file, and the document's existing Google access permissions still apply.
To update an existing document, provide `document_id` and an explicit `mode` (`append` or `replace`);
replacement must be requested by the user. Existing document titles and IDs are retained.
Formatting includes headings, bold/italic/underline, colors, URL links, nested bullet/numbered lists,
tables and inline images scaled down to page or cell width (at most 624 px). HTML conversion uses
Drive and structured copying uses the Docs API through the profile's Google OAuth connection;
users do not deploy Apps Script. Horizontal rules use paragraph borders. Merged cells, positioned
images, equations and internal document links are rejected before editing an existing document.
Imports are limited to 1 MB and existing-document copies to 500 structural elements.
Existing-document edits use revision checks and stop on concurrent changes. Table insertion and
content copying require multiple writes, so an interruption can leave a partial update. Errors
identify the document and warn against automatic replay; review it before retrying. Temporary
imports are deleted after existing-document operations; a cleanup warning includes their ID if
cleanup fails. No live document is changed as part of development validation.

Google services share one OAuth connection per profile. The authorization flow requests scopes for saved permitted tools: Calendar for calendar tools, Tasks only for direct Google tasks, and Docs/Drive for document tools. Home Assistant tasks do not request Google Tasks access. Home Assistant list writes are followed by a read-back verification. Uncertain
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

| Capability         | Tool names                                                                                                        | Registration condition                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Calendar           | `calendar_list`, `calendar_availability`, `calendar_get`, `calendar_create`, `calendar_update`, `calendar_delete` | Google OAuth configured                                                     |
| Tasks              | `tasks_list`, `task_get`, `task_create`, `task_update`, `task_delete`                                             | Google OAuth configured                                                     |
| User/group context | `context_save`                                                                                                    | Memory enabled; no Google access required                                   |
| Documents          | `document_create`                                                                                                 | Google OAuth configured                                                     |
| Location           | `location_get`                                                                                                    | Home Assistant token and at least one location entity                       |
| Sensors            | `sensors_list`, `sensor_get`, `sensor_history`                                                                    | Home Assistant token                                                        |
| Shopping           | `shopping_list_get`, `shopping_list_change`                                                                       | Home Assistant token                                                        |
| Local forecast     | `weather_forecast`                                                                                                | Home Assistant token and weather entity                                     |
| Memory             | `memories_get`, `memory_catalog`, `memory_read`, `memory_save`                                                    | Always                                                                      |
| Web search         | `web_search`                                                                                                      | Brave API key; profile web permission; omitted for GPT-5+ model identifiers |
| Image search       | `image_search`, `image_search_providers`                                                                                                    | At least one configured Brave, SearchAPI or SerpApi key; profile web permission |
| Public page text   | `url_read`                                                                                                        | Profile web permission; omitted for GPT-5+ model identifiers                |

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

Persistence adapters use Drizzle ORM with the `node-postgres` driver. Routine CRUD,
conditional inserts, pagination, queue claims and row locks use typed query builders.
PostgreSQL expressions handle JSON updates, full-text matching and identity maintenance;
raw statements remain for advisory/table locks and vector search.
Existing tables, identities and encrypted settings are retained without data export/import.
Schema setup is managed by the versioned migrations in `drizzle/`, generated from the
declarative table definitions. Better Auth uses `@better-auth/drizzle-adapter`; its native
schema initializer is no longer used. PostgreSQL remains the only runtime backend; PGlite is a separate follow-up.

Generate a schema change with `pnpm db:generate --name=description`; use
`pnpm db:generate --custom --name=description` for custom SQL. Commit the migration SQL,
snapshots and journal together. Never edit an applied migration. The generation wrapper
keeps foreign-key references relative to the selected database schema.

Startup runs the Drizzle migrator before constructing repositories. `pnpm db:migrate`
applies the same runner to `ASSISTANT_DATABASE_URL`. A recognized existing schema is
baselined in place: required columns, types and constraints are checked, missing optional
module tables and indexes are created from the generated baseline, and its checksum is
recorded without exporting or rewriting records. Incompatible schemas and changed migration
history fail explicitly. Stop the assistant before applying pending migrations; the runner
refuses DDL while another assistant holds its execution lease.

The custom vector migration installs a configuration function. The first Store startup
sets the configured vector dimensions and HNSW index; subsequent starts reject dimension
changes rather than rewriting existing embeddings. PostgreSQL must provide pgvector.

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

For example, expose `https://assistant.example.com/telegram/assistants/zero/webhook`
through your reverse proxy. With Pangolin and Newt, configure the resource to target
`http://127.0.0.1:8788`.
Telegram must be able to reach the webhook path without an interactive login. The
assistant checks the configured Telegram secret header and the independently permitted chat.
`https://assistant.example.com/health` should return `{"status":"ok"}` once routing is ready.

Register the Telegram webhook with `secret_token` matching `telegram.webhookSecret`,
set `telegram.transport` to `webhook`, and enable the intended schedules. Preserve pending
updates when changing registration. Startup does not register or remove webhooks.

## User and group administration

Open `/admin` on the assistant's public HTTPS origin. On a new installation, the web
interface asks you to choose an administrator username and a password (12–128 characters).
It creates the account once and opens service settings so you can configure providers and
connections. No terminal provisioning command or fixed username is needed. Existing accounts
and sessions remain valid; setup never overwrites them. Better Auth stores password hashes and sessions in PostgreSQL.
Sessions last 30 days, renew while active, and survive application restarts and deployments.
Use **Seguridad → Cuenta y recuperación → Cambiar contraseña** to change the password: the current browser remains
signed in and other sessions are revoked. Login attempts are rate-limited, registration is
disabled, and browser sessions use HttpOnly cookies with Secure enabled for HTTPS.

The panel opens on **Asistentes**. Webhooks belong to each assistant; profile settings
remain under **Usuarios**. Home Assistant discovers Zero on the local network and starts
the pairing approval flow itself. **Seguridad** contains only account and recovery settings.
Existing integration tokens and pairing endpoints remain available for compatibility.

Under **Seguridad**, optionally enable **Autenticación en dos pasos** with your current
password. Add the manual setup key to a TOTP app and confirm a code before 2FA becomes
active. Save the single-use backup codes privately. Password sign-in then requires a TOTP
or backup code. **Passkeys** lets you register, list and delete device credentials and sign
in directly from the login page. Passkeys are an alternative to password plus 2FA and need
HTTPS (or localhost); they are bound to the configured administrator origin. Password
recovery changes the password without disabling 2FA or removing passkeys.

Password recovery is always available when a private delivery destination is configured. Telegram uses
the existing Zero bot and the first configured Telegram allowed user, which must still
be an enabled owner with a private user profile. On the login page, choose
**He olvidado mi contraseña** and request a code for your administrator username. Enter the eight-digit code
and a new password (12–128 characters). Codes expire after ten minutes, allow five
attempts, and can only be used once; requests are limited to one per minute. A successful
reset signs out every admin session. Recovery needs no opt-in, and delivery failures
are never retried automatically. No separate bot token or chat ID is entered in the panel.

Set `ASSISTANT_ADMIN_URL` to the exact public origin (production Compose defaults to
`http://localhost:8788`); this controls trusted origins, CSRF checks and secure cookies.
For local development, set it to your local HTTP origin. The web setup is available only
while no administrator exists; concurrent attempts cannot create multiple initial accounts.
Normal password changes belong in the web interface. The legacy `admin:password` command
remains an optional operator recovery tool for existing installations with an explicit `--username USERNAME`, not a first-run
requirement. A first-run installation should remain on a trusted network until you create
its administrator account.

### Home Assistant Ingress

[Add-on packaging](../addons/zero/README.md) is provided in `addons/zero/`. This is source
packaging, not a published add-on release. Set `homeassistant_api: true`, `ingress: true`,
`ingress_port: 8788`, `ingress_entry: /admin/`, and `panel_admin: true`; the launcher enables
`ASSISTANT_HA_INGRESS=1`. Supervisor supplies `SUPERVISOR_TOKEN`. PostgreSQL with pgvector
is still required. The private GHCR image requires registry access when building the add-on.

In this mode an active Home Assistant administrator can manage Zero directly, without a
separate Zero password. Zero accepts identity headers only from the Supervisor TCP peer
`172.30.32.2` (including its IPv4-mapped form), validates the Ingress path, and checks current
HA administrator membership via the Core API. Unknown, inactive, non-admin or unavailable
identities are denied; forwarded IP headers are never trusted. Direct requests cannot
create a local administrator or reuse local login cookies in Ingress mode. Ingress-aware
asset/API URLs and frame policy keep the UI inside the HA panel.

“Administrator” describes management access whether the person uses Home Assistant or
Telegram; it is not assigned to the first accepted Telegram contact. A local management
account does not need a Telegram profile. Personal Google and HA connections remain in
**Usuarios**, global defaults in **Ajustes**, and AI providers in **Proveedores IA**. HA login
does not copy Supervisor credentials into a profile or change existing voice pairings.
Legacy internal `owner` flags continue to identify the original credential/memory import;
they do not restrict Ingress administration to that Telegram user. Existing profiles,
permissions, prompts, conversations and rules retain their identities.

The page no longer asks for the
administrator API key. Headless clients retain bearer authentication with `config.apiKey`;
browser sessions authorize only `/v1/admin/` settings, not other privileged API endpoints.

Select a user or group and use **Eliminar chat** to revoke its access and remove the entry.
History and memories remain intact. A returning contact appears pending and disabled,
including a deleted original owner; application restarts never restore that permission.
The deletion also clears its Telegram command menu when possible and reports an uncertain
menu update without retrying it.

Each chat has independent STT and TTS selections under **Voz · transcripción y síntesis**.
**Predeterminado** preserves the existing ASR endpoint and Edge TTS voice. To use Home
Assistant (including `stt.microsoft` and `tts.microsoft`), enable the chat's Home Assistant
capability, save its connection, then load the available engines. Select an engine and
language for each direction, and a TTS voice from the searchable, paginated dropdown.
**Probar voz seleccionada** previews the current selection in the browser with editable
Spanish sample text, without saving preferences or playing on Home Assistant speakers.
Save permissions to apply the selections to subsequent Telegram messages and voice replies.
Only the original owner can inherit the original Home Assistant connection; other chats
use their own saved credentials. Failed speech requests are reported without automatic retries.

Each assistant has an optional **Telegram** section in its own editor. Without a bot connection it remains available through Home Assistant. Zero’s original server connection is migrated into encrypted PostgreSQL settings once; its token, enabled state, transport and public webhook URL can then be changed in the same UI. Empty token fields retain the saved secret. The public bot account ID is displayed, while token secrets remain hidden.

All bots use `POST /telegram/assistants/<assistant-id>/webhook`, for every configured assistant. The old webhook endpoints and global bot-settings API are removed. Stored webhook URLs are migrated to the canonical path while conversations and account-scoped deduplication remain intact. Existing Telegram registrations are never changed at startup: inspect **Consultar estado en Telegram**, then explicitly confirm **Registrar webhook** after migration. Registration preserves pending updates and is never retried automatically.

Saving connection settings does not register a webhook. Polling is also available per assistant and refuses an existing Telegram webhook. To switch, save Polling and explicitly confirm **Eliminar webhook de Telegram**; pending updates are retained. Each bot account can belong to only one assistant. Disabling a connection keeps its credentials and ignores incoming updates; clear its token before deleting an assistant. New contacts remain pending until their permissions are approved.

Every user or group that contacts a configured bot appears in the searchable, paginated chat list.
New contacts are **pending and disabled**. Select “Solo pendientes”
to review them, then enable each chat manually. No model invocation, transcription, ordinary
reply, error reply or typing indicator is sent for an unapproved chat. The exception is the
Spanish welcome with chat ID when a bot is added to a group. Joining does not grant access.
A permitted user's presence never authorizes a group; group access must be enabled separately.
When you enable a user or group from the web interface, the bot publishes a Telegram `/`
command menu scoped to that chat: `/nuevo`, plus `/clean` when tasks are enabled. Saving
an enabled chat refreshes its menu; disabling it clears that chat's command list. If
Telegram registration fails, access settings remain saved and the web interface reports
the menu failure without automatically retrying. Save the chat again to update its menu.

In enabled groups, each assistant processes messages that explicitly mention its Telegram username
in the message text or media caption, including `/command@username`, or directly reply to a message
from that assistant. The group setting **Responder cuando contesten a un mensaje del asistente**
controls direct replies and is enabled by default; disable it to require a mention. Replies to other users or bots, ordinary conversation, and forwarded media
without a mention are ignored before queueing or media downloads. Reply to a video with `@your_bot_username` to request its transcript.
Private chats and Zero retain their existing behavior; group welcome and migration events
are handled separately. Each assistant resolves its username through `getMe` on demand and caches it
for the configured token.

Each chat has a **Respuestas de voz** toggle. Turn it off to keep text replies without
synthesized audio; transcription remains available. The global `telegram.voiceReplies`
setting still controls whether voice output is available at all.
Choose an assistant in **Asistentes** and configure its prompt;
Zero retains its existing prompt by default. Each chat uses its own current time and timezone.
Prompt selection does not grant tools or change the chat’s memory mode.

New profiles start with public web search, public page reads, media input/transcription and
chat-scoped memory. Google Calendar, Tasks, Docs/Drive and Home Assistant are disabled.
Enable the permitted tools, choose the task provider, and save the profile before connecting.
In the profile's Google tab, enter one OAuth client ID and secret and select **Conectar Google**.
Use a Google Cloud **Web application** OAuth client, register the exact redirect URI shown in
Zero (`ASSISTANT_ADMIN_URL` origin plus `/v1/admin/google/oauth/callback`), and enable the
APIs needed by the selected tools. Use the panel on that configured origin when authorizing;
Google must be able to return to it in the same browser. When using a Home Assistant iframe, open Zero at the configured admin origin first;
Google does not allow embedded consent screens. The client ID and secret are saved only after successful authorization.
A blank client secret reuses the saved secret when the client ID matches; existing per-service
credentials can supply that client during migration without revealing its secret.

Zero requests Calendar access only for permitted calendar tools; Google Tasks access only
when tasks are permitted and the task provider is Google; and Docs plus Drive access only
for permitted document tools. Home Assistant tasks do not request Google Tasks permission.
Changing these permissions requires saving the profile and reconnecting Google. Google may
retain previously granted permissions; Zero still enforces the current tool permissions.

Start authorization at the exact public origin configured in `ASSISTANT_ADMIN_URL`, in the
same browser that will return from Google. Zero links to that origin from aliases or embedded
panels and checks that the authorization cookie was accepted before leaving for Google.
If the callback reports a missing cookie, allow cookies and use that same browser. A server
restart or an already-used attempt requires starting a new authorization; do not replay the
old callback URL. Callback diagnostics never include authorization codes or tokens.

Google destinations use searchable dropdowns with a reload control. Selections are verified
and saved immediately, including their display names; no profile-save action is needed.
The Google panel includes collapsed setup links for only the required APIs.

Zero exchanges the authorization code on the server and stores the generated refresh token
inside the profile's encrypted credentials. The browser never receives access or refresh
tokens. Before replacing old per-service entries, Zero refreshes the new token, checks its
scopes and reads the selected services (including Docs API availability when the account has
no documents). Cancellation, partial consent, failed checks, expiry, replay or concurrent
connection/tool changes preserve the previous connection. Authorization attempts expire after
ten minutes and do not survive server restarts; start a new attempt rather than replaying a
callback. Old per-service entries remain readable until a verified connection replaces them;
Zero removes their saved entries without revoking Google's grants, which could also revoke
the replacement connection. Google passwords and manually entered refresh tokens are not
needed in the profile UI. Profiles never inherit the owner's accounts.

Tool catalogs are filtered per turn, application tool calls recheck permissions before running,
and built-in web search follows that chat's web permission. Changing the tool catalog
starts a fresh agent thread with retained application conversation history; stored messages
and long-term memory are not deleted. Revoking access also suppresses
queued messages and delivery of an in-flight answer.

A user chat and a group chat have independent conversation threads, history and memory;
group memory is shared by that group's participants. Different assistants are also isolated, even
for the same chat ID. Only the first existing `telegram.allowedUsers` entry is seeded as the
original owner with the previous Zero credentials and legacy memory profile. Other existing
allowed users receive public capabilities only. Configuration entries are initial seeds;
changing or disabling an existing profile in the web UI survives restarts. Existing memory
and conversation records are preserved. Custom owner prompts and scheduled private agenda
notifications stay with the owner.

Each profile also has a **long-term memory mode** and an IANA **timezone** (for example,
`Europe/Madrid`, `America/New_York`, or `Asia/Tokyo`):

- **Advanced:** save memories with embeddings and use hybrid semantic/keyword retrieval.
- **Simple:** save memories without embeddings and search by keywords. No embedding-provider
  requests are made for that profile's saves, searches or automatic extraction.
- **None:** keep the conversation context, but disable long-term memory tools, external context
  document reads/writes, and automatic memory extraction. Messages written in this mode stay
  in the conversation history but are excluded from automatic extraction.

Changing modes does not delete saved facts or existing vectors. Previously saved memories become
available again after enabling memory. Simple facts remain keyword-searchable after switching to
advanced; existing facts are not automatically re-embedded. Existing profiles default to advanced
memory and inherit the installation timezone until an administrator saves their own timezone.
The scheduler interprets the configured reset time in each profile's local
calendar and timezone, including daylight-saving changes, and deduplicates daily runs per chat
and local date. The profile editor controls whether the reset runs and at what time. A daily reset clears the
conversation context only; it never deletes long-term memories. Disabled memory still permits
the scheduled conversation reset. Profile timezone also applies to prompts and calendar handling.

Tokens and integration secrets entered in the web UI are encrypted with AES-256-GCM in
PostgreSQL and never returned by the administration API. Set `ASSISTANT_SECRETS_KEY` to a
stable private value of at least 16 characters before first saving credentials if you want
to rotate `config.apiKey` independently. Otherwise the encryption key is derived from
`config.apiKey`, which must remain unchanged to decrypt those credentials. Back up the database
and encryption key privately together. Use the existing trusted HTTPS ingress for remote
administration. No runtime secrets belong in source control or Docker images.

## Protocol references

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)
- [Home Assistant to-do actions](https://www.home-assistant.io/integrations/todo/)
- [Google Docs API](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get)

### Home Assistant Voice → Zero

The `assistant_zero` custom integration adds a separate `conversation.zero` agent.
Assist handles the microphone, wake word, speech recognition and TTS; the bridge
sends the recognized text to Zero's existing durable worker. Voice uses the original
owner's profile, permissions, tools, memories and conversation, sharing session
ordering with Telegram. Its response goes back to Assist and is not sent to Telegram.
The separate Codex conversation agent and preferred pipeline remain available.

To install on this host:

```sh
pnpm voice:install-home-assistant --prepare
# Deploy the assistant image containing the voice API through GitHub Actions.
pnpm voice:install-home-assistant
```

Preparation privately backs up the persisted service settings and sets the voice satellite binding in PostgreSQL.
Set `ASSISTANT_VOICE_SATELLITE` to the intended satellite entity, or select it in settings.
No satellite or Home Assistant instance is assumed. The callback defaults to the
assistant's localhost port; `ASSISTANT_VOICE_CALLBACK_URL` can override its HTTP
origin when HA has a different network namespace. Both sides must use the same
satellite binding. An empty binding disables voice access.

Installation backs up HA configuration and pipelines inside its container, installs
the integration with a dedicated voice-only credential, validates configuration,
and restarts HA to load the new Python code. It clones the preferred pipeline's
STT/TTS settings into a `Zero` pipeline and assigns only the selected device to it.
Wake words, volume, other devices and the global preferred pipeline are preserved.
Existing conflicting Zero pipelines cause installation to stop for inspection.

The agent accepts its configured satellite/device or an authenticated HA
administrator using Assist directly. Physical access to the enabled microphone
therefore grants access to the owner's Zero tools; mute it when needed. The
voice credential only permits bounded turn submission and reading that device's
voice results, not the admin API, Telegram jobs or arbitrary session selection.
Requests are deduplicated by utterance ID. After one submission, the integration
only reads status for up to 290 seconds; failed or uncertain actions are never
automatically repeated. Idle operation uses no model tokens or heartbeat; each
spoken request is a normal Zero model turn. Status polling uses no model tokens.

Home Assistant and Android Assist users can be bound to enabled private Zero user
profiles under **Zero Assistant → Configure → Home Assistant user bindings**.
See [user binding setup](../integrations/home_assistant/README.md#android-and-home-assistant-user-identity).

### Guided Home Assistant setup

Zero's `/admin` interface is a Next.js App Router static export using shadcn/ui, icon actions with tooltips, and a compact slate/orange theme. The existing Node HTTP adapter serves its assets and authenticated APIs from one origin. Domain models and application ports remain independent of Next.js and PostgreSQL. Profiles, per-service connections, voice discovery/preview, read-only catalogs, Telegram bot settings and account recovery are managed directly in `/admin`.

In Home Assistant, select the mDNS-discovered Zero instance, confirm both server URLs, choose the Home Assistant user and satellite, then approve the request in Zero and select an enabled private Zero profile. Home Assistant creates its own ten-year long-lived access token; Zero encrypts it with the existing profile credential store. A separate revocable Zero token configures voice, shared settings and rule callbacks automatically. Both tokens are exchanged server to server, never in callback URLs or browser storage. The selected HA user inherits the linked Zero profile's permissions and conversation state. Setup does not grant new tool permissions or replace existing schedules.

Requests expire after ten minutes, require administrator approval in Zero and a separate one-use exchange secret, and do not survive a Zero restart. Failed or uncertain exchanges are never retried. Inspect both servers' token lists before beginning another attempt. Zero tokens are shown only at manual creation, stored as digests and revocable in Security; revoke HA tokens from the HA user's profile. Older dedicated credentials and manual/reconfigure flows remain compatible.

Run `pnpm dev:admin` in Codespaces for the UI; authenticated setup uses `pnpm build` and the normal assistant listener on port 8788. Never use production configuration or credentials for development. `pnpm build` builds both TypeScript and the static UI. No separate Next.js runtime or production port is needed.

### Multiple assistants

Open `/admin` → **Asistentes** to create and edit named assistants with individual prompts. Fresh installations include only Zero. Create additional assistants with your own names and prompts; saved assistants and edited prompts are never overwritten. All other identities come from saved assistant definitions. Zero's prompt uses the same settings record and revision as the Home Assistant settings client, so it has no second prompt store.

In **Personas**, choose an assistant for a profile. One assistant can serve multiple profiles; each profile retains its own permissions, credentials, memory and conversation/session identity. Home Assistant uses the assistant assigned to its linked Zero profile. Prompt changes and new assignments apply on the next permitted conversational turn, without resetting history. The catalog is searched and paginated; only the selected assistant's prompt enters a turn. Integrated assistants cannot be deleted, and custom assistants must be unassigned before deletion. Saved transport settings, webhooks, session IDs and memory behavior remain intact.

The Next.js panel supports adding and removing user/group profiles, filtering pending contacts, selecting an assistant, permissions, timezones and memory modes. Blank secret fields preserve saved credentials; passwords/tokens are never returned to the browser. Google supports separate Calendar, Tasks, Docs and Drive credentials. Speech engines, languages and voices are discovered from the saved scoped Home Assistant connection on demand, with paginated voices and in-browser audio previews. Rule/entity/service catalogs are read-only and paginated. Saving an enabled assistant connection registers its webhook once; status checks do not register or replay it. Account settings support password changes and recovery through Telegram or the Home Assistant mobile app without leaving `/admin`.

Group profiles have an **Integrantes** tab for known Telegram members. Zero records non-bot message senders and join/leave service messages it receives; Telegram does not provide a complete member roster. Administrators can add a person by numeric Telegram user ID and assign that person's `person.*`/`device_tracker.*` location and `sensor.*` address using the group's Home Assistant connection. Assignments are specific to the group and do not authorize private profiles. With Home Assistant permission, `group_members_list` discovers members on demand and `location_get` defaults to the current identified sender, or accepts a selected member's `user_id`. Missing assignments and members known to have left do not fall back to the group's location. The member editor and selected tab survive reload via URL parameters.

Connection and security settings use provider tabs. Profile settings are grouped into Perfil, Google and Home Assistant, with separate Google service tabs. Switching providers retains unsaved fields. Saving validates all tabs and opens the relevant provider when a field needs attention.

Home Assistant is optional. Shared Home Assistant permissions are managed only in the Home Assistant integration; direct Google and Telegram connections remain available in the admin. Each profile may explicitly select Home Assistant to-do as its task provider and choose one `todo.*` entity (local lists, Google Tasks exposed by HA, or another to-do integration). The setup discovers lists on demand and requires confirmation before switching providers. Existing task tools keep their names, credentials are retained, and selecting a provider does not migrate tasks or silently fail over. HA voice requests do not require a Telegram bot token.

Configure the shared Home Assistant access switch in **Zero Assistant → Configure**. Manage entity access in **Settings → Voice assistants → Expose**, selecting **Assist**. Zero uses Assist’s effective exposure settings directly, including default exposure and individual overrides; there is no separate service allowlist or Assist/Frigate service switch. Owner tools `ha_entities` and `ha_entity` discover and read exposed entities on demand. `ha_services` discovers entity actions, and `ha_service_call` checks current exposure and the connected HA user’s permissions immediately before dispatch. Use explicit entity IDs or an exposed named script; area/device/all targets and untargeted administrative services are rejected. Sensor, history, location, distance, shopping, weather and HA to-do tools use this same Assist exposure policy. Profiles no longer have separate sensor/location permission lists; saved entity assignments identify a preferred source. When assigning a location or address not yet exposed, Zero asks for confirmation to add it to Assist for the whole HA instance; this requires an HA administrator. Existing exposed locations need no exposure change. Clearing an assignment never unexposes it globally. Retired list values remain private only to preserve scheduler identities. Alerts check exposure at installation and before delivery, and morning state triggers check before enqueueing a briefing. Upgrade the `assistant_zero` integration alongside the server; generic control fails closed if the exposure commands are unavailable.

Telegram connection settings now live under **Asistentes**. Each assistant can have its own saved avatar; uploading/importing and saving an avatar does not modify Telegram. For assistants with a Telegram connection, the editor can explicitly fetch the configured bot’s current photo and separately publish the saved avatar after confirmation. Custom assistants without a bot connection keep a local avatar.

The unified Home Assistant integration exposes the assistant catalog as separate conversation agents and refreshes metadata every minute. Stable agent IDs retain existing `conversation.zero`, pipelines and rules; agent selection preserves the bound user’s existing permissions, conversation and memory. Prompts and image data are not included in discovery responses.

### User and group context

The current user's or group's editable context is loaded from Zero's PostgreSQL
profile for each turn and automatically added to the instructions when nonempty
even when mem0 is disabled. The user's name, timezone and current date/time are also
added automatically; no prompt placeholders are required. Prompt placeholders
are no longer expanded.
Context is limited to 16,000 characters and requires no Google account or Documents
permission. The former Google context document setting is no longer used for prompts
or context writes; existing Google documents are not modified or imported automatically.

In Users, open a profile's **Contexto** tab to edit it. `context_get` reads the current text and revision on demand. `context_save` keeps its existing
name and `memory` argument; `mode` is `append` (default) or `replace`. Replacement can
correct, remove, or clear context. Writes return a revision; concurrent edits fail
instead of overwriting newer text. Reload the profile after a conflict.

Home Assistant users have profiles even without Telegram. The admin user list discovers
active, non-system users through the configured Home Assistant connection (requires
permission to list users); voice requests also discover their own user profile. Their
Home Assistant connection settings are read-only in Zero's profile UI. Linking a Home
Assistant user to an enabled private Zero Telegram user merges profile settings and
context, preferring existing Home Assistant values and retaining Telegram-only Google
credentials. Subsequent voice and Telegram turns share the linked Telegram profile.
Unlinking restores the separate Home Assistant profile and preserves both histories.

### AI providers and model permissions

In the admin panel, open **Proveedores IA** to configure Codex CLI, OpenAI,
OpenRouter, an OpenAI-compatible endpoint, Ollama, or Anthropic. Existing installs
start with their current Codex CLI model and authentication. API credentials are
stored encrypted in PostgreSQL and never returned by the admin API. A blank key
preserves the saved key only while the provider type and base URL stay unchanged.
Use a base URL including `/v1` (OpenRouter uses `/api/v1`). Ollama defaults to
`http://localhost:11434/v1`; in containers, configure a reachable Ollama address.

Add each model's exact upstream ID and a stable local identifier, then choose the
global default. In each user's profile, choose a default override and explicitly
check the alternate models that user may select. `/model` lists permitted models;
tap a Telegram choice or type `/model <name>` (case-insensitive model label) or
`/model <local-id>` to save the selected model as the profile default. It remains
active across questions, background turns and restarts until another model is
selected or the profile is edited. `/model default` clears the profile override
and uses the global default. Duplicate or reserved labels use local IDs in the
choices; existing `/model #N` commands remain supported. Selection rechecks the
profile's enabled status and permitted alternatives when saving. A deleted model
fails explicitly rather than silently switching providers; update affected profile
defaults as well as permitted alternatives when revoking a model. Requests and
tools are never automatically retried.

OpenAI uses Responses, Anthropic uses Messages, and OpenRouter, compatible servers,
and Ollama use Chat Completions. Models must support tool calling; attachments
require vision and automatic memory extraction requires structured JSON output. Application
conversation history and tool authorization remain shared across model changes.
Codex's built-in web search and image generation remain specific to Codex CLI.
Provider/model catalogs are bounded admin configuration, never added to every
turn's instructions. No live integrations are changed by saving provider settings.

**Home Assistant AI:** Choose the Home Assistant provider to reuse an AI integration
already configured there, without copying its model credentials into Zero. Select
its `ai_task.*` entity from the on-demand, searchable catalog, or use `preferred`
to follow Home Assistant's preferred AI Task entity. Integrations such as OpenAI,
Anthropic, and Ollama can expose an AI Task subentry; a conversation-only agent
needs that subentry enabled first. Home Assistant's model settings stay in HA.
Zero still sends its own instructions, retains conversation history, and executes
all application tools through the profile's normal authorization. Each execution
uses that profile's enabled HA connection, with no fallback to another user's
credentials. The same default and alternate-model permissions apply. This path
uses `ai_task.generate_data`, never `conversation.process` or `conversation.zero`,
so it does not create a second assistant prompt store or recurse into Zero.
Local image attachments are explicitly rejected on this path because HA's AI Task
API only accepts HA-local media sources. Select another approved model for images.

### AI settings and memory embeddings

Service settings no longer include a global Memory section. Configure the AI model and
memory embeddings in **Proveedores IA**, and choose the memory mode separately for each
user/group profile. Existing storage aliases and vector dimensions remain compatible.

The AI settings tabs separate conversation providers, memory embeddings, and reranking
status. Connection names are optional; the provider name is used unless a custom label
is needed for multiple accounts. Profile settings show model names; `/model` lists
numbered selections, while existing commands using saved model IDs remain compatible.

Memory embeddings can retain the server configuration, use a separately configured
Gemini model and API key, reuse an OpenAI, OpenRouter, Ollama or OpenAI-compatible
connection, or be disabled for keyword-only search. Keys are encrypted
with AI settings and never returned to the browser. Model discovery lists only Gemini
models advertising `embedContent` support. OpenRouter uses its embedding model
catalog; OpenAI lists embedding models and Ollama checks installed model capabilities.
Compatible servers may omit capabilities, so the explicit test checks the selected model.
Provider embeddings reuse connection credentials, use `/embeddings`, and support optional
output dimensions when the model accepts them. Smaller vectors are padded with zeros
without changing cosine similarity; oversized or malformed vectors fail before storage.
Provider, endpoint, model and dimension choices isolate semantic spaces. The test sends
only a short sample and returns compatibility status, without storing a memory. Simple and disabled memory modes never
request embeddings, regardless of the global embedding selection.

Stored vectors are tagged with their embedding model and dimensions. Changing models
does not delete or re-embed existing memories: they remain available to lexical search,
and semantic search only compares vectors from the selected model. Legacy vectors are
tagged with the Gemini model from the server configuration during the additive startup
migration. Changing database dimensions still requires a deliberate migration. PostgreSQL combines semantic, lexical and scoped entity-relation signals. In
**Proveedores IA → Reranking**, optionally choose a connection and its model independently of conversation models to reorder up to
20 scoped candidates before the existing three-result/token budget. The model runs
without tools or conversation history and does not consume `/model` selections. A
failed or malformed reranking response preserves the hybrid order without retrying.
Connections can be reused from conversation or created exclusively in the embeddings/reranking
tabs. Exclusive connections stay out of the conversation connection/model selectors but can
be reused by compatible memory functions. Credentials are encrypted once in the shared
connection registry. Reranking supports structured-output AI models and Cohere/Jina-compatible
`/rerank` APIs with a separate model identifier. Home Assistant models are not available
for this internal operation.
No browser embedding runtime or bundled local model service is installed.

### Recover a local Zero password through Companion App

Recovery prefers the private Telegram destination when available. If there is no Telegram
destination, only local accounts with an existing verified Home Assistant user/profile link
can use Companion App recovery. Accounts without either destination require the console
password reset command (`pnpm admin:password --username USERNAME --password-file /private/password.txt --reset`).

There is no mobile recovery setup screen or device enrollment code. For a linked account,
Zero resolves the Home Assistant person's current `device_trackers` whenever recovery is
requested and sends the same recovery code to **all** assigned, active Companion App
notification destinations. Replacing or removing a device in Home Assistant changes the
next request automatically; saved legacy device selections are ignored. Existing verified
account links remain in PostgreSQL, and account names are never used to guess a HA identity.
This requires Zero Assistant integration **1.5.2** or later. Its private commands use the
linked user's own token, validate the authenticated HA identity, and resolve destinations
from registry identities and the current mobile notification map, rather than device names.

No notification is sent on startup or upgrade. A failed/uncertain delivery is never retried
or redirected to another channel. Missing HA credentials, person assignments or devices do
not make another account eligible. Codes expire after ten minutes, allow five guesses and
are single-use. A changed destination invalidates an outstanding reset code. Successful
password recovery revokes Zero sessions while preserving 2FA and passkeys.

This recovers **local Zero accounts** only. Ingress users continue to manage and recover
their HA credentials in Home Assistant. The notification action follows the official
[Companion App notification interface](https://companion.home-assistant.io/docs/notifications/notifications-basic/).

### Memory relationships and expiration

Automatic extraction records explicitly named entities and attributed subject/relation/object
links in each Mem0 payload. Retrieval matches entities named in the query and follows one
bounded relation hop within the same user/group/shared profile, excluding expired and
superseded records before ranking. This local association index uses the existing PostgreSQL
store; it does not enable Mem0 Platform Graph Memory or add a graph database. Existing
memories acquire associations when explicitly corrected or newly extracted; startup does
not reprocess private history or send the old corpus to an AI provider.

Memories are permanent by default. `memory_save.expiresAt` accepts an explicit future ISO
timestamp, and **Usuarios → Memoria** supports setting, clearing and reviewing expiration.
Automatic extraction sets expiration only when explicitly requested by the user, never
merely because a past event is mentioned. Exact UTC expiration is enforced in PostgreSQL;
the SDK also receives its supported date-only expiration. Expired memories disappear from
assistant search, catalog, list and detail tools but remain visible to administrators for
review, correction or deletion. Expiration does not delete conversation history or backups.
Entity names and relations are available on demand in memory details, not injected into
normal turn instructions.

### Location alerts

`alert_create` also accepts location conditions. Discover IDs using
`ha_location_entities` (search/pagination), then inspect `ha_location_entity`.
The profile's entity allowlist must permit both people, or the person and zone;
reading a group member's location does not grant persistent monitoring permission.
An empty entity allowlist follows the existing unrestricted HA scope.

- Zone: `source: "zone"`, `entity_id: "person.ana"`,
  `target_entity_id: "zone.office"`, `operator: "enter"` or `"leave"`.
- Distance: `source: "distance"`, `entity_id: "person.ana"`,
  `target_entity_id: "person.luis"`, `operator: "below"` or `"above"`,
  `distance_m: 3200`. This is straight-line distance, not road distance.

Only active requested alerts subscribe to their named entities. Location changes
are evaluated inside HA without polling, geocoding, routing APIs or AI calls.
Creation, resume and restart establish a baseline; an alert requires a subsequent
crossing. Pausing/cancelling/completing removes the listeners. Existing alert
listing, holds, cooldowns and one-shot delivery rules apply. Recurring distance
alerts default to a 100 m reset margin; zone alerts default to zero. Unknown or
invalid locations break holds without rearming. Distance alerts use last known
coordinates regardless of report age, since stationary trackers may not update.
Zone alerts default to rejecting reports older than one hour (`max_age_seconds`);
this age setting is retained for compatibility but ignored for distance alerts.
Both default to rejecting reported GPS accuracy worse than 200 m; callers can set
`max_accuracy_m`, `hold_seconds` and `reset_margin_m`.
HA report age cannot guarantee the underlying phone GPS fix is fresh. Phone
background location updates determine detection latency and battery use.

Requires a Zero HA integration advertising `location_alerts`; older integrations
reject creation before saving a rule. Publishing code does not upgrade live HA.

For direct questions such as “¿A qué distancia está Ken de Francisco?”, Zero uses
`ha_location_entities` to resolve permitted people and `ha_distance` to fetch both
observations and calculate the approximate straight-line distance in metres.
The read-only tool includes each source's report time, age and GPS accuracy;
old or imprecise observations still produce a distance with `current: false`,
so the reply names the affected person, gives the observation age and warns that
the actual distance may differ. Only missing or unusable coordinates prevent the
calculation. HA report time does not guarantee the phone GPS fix is fresh.
It creates no subscription, alert or recurring work and requires only the Zero
update, not an additional HA integration release.

In groups, resolve names with `group_members_list` and call `ha_distance` with
`user_a`/`user_b` (Telegram member IDs). This uses the same active assignments and
group HA connection as `location_get`, including device trackers or assigned
geocoded-location sensors, without duplicating the person IDs in the sensor
allowlist. Missing/inactive member assignments are rejected. This read permission
does not grant persistent monitoring permission. A different HA account may read
the data without the Zero integration; persistent alerts require that integration
on the HA server used by the group. Member assignments do not choose another
HA server or another member's credentials.

The HA integration does not ask for a voice satellite in setup or reconfiguration.
Data, reminders and alerts need no physical voice device. Existing stored satellite
identities remain supported for established voice installations; authenticated HA
users can use Assist/Android through their existing bindings. An unconfigured
satellite never grants anonymous-device access. Setup reports missing local fields,
connection failures, HTTP rejection and a mismatched Zero public approval URL
separately, without retrying pairing submissions or uncertain exchanges.

The pairing approval has its own searchable, paginated catalog of enabled private
users and groups across assistant accounts, independent of the Users page's search
and pagination. Approving a group changes only that group's HA connection and does
not create or replace a private voice-user binding. Approving a private profile on
another assistant preserves its bot, assigned assistant, permissions and history;
its HA voice binding routes to the existing private assistant session. Legacy Zero
chat-ID bindings remain supported. Pairing does not enable additional capabilities.

Public pairing endpoints enforce separate socket-peer quotas: five initiation
attempts per ten minutes and thirty exchange attempts per minute, including invalid
requests. Rejections return HTTP 429 with `Retry-After`; they never retry a pairing
mutation. Initiation bodies are capped at 8 KiB and exchanges at 12 KiB. Quotas are
held in bounded process memory and reset on restart. Forwarded IP headers are not
trusted: clients behind a reverse proxy share that proxy's quota. Apply additional
per-client and distributed-abuse limits at the trusted proxy when exposing Zero to
the internet. The existing 100-pending-handshake cap and ten-minute expiry remain.

Zero automatically removes completed, expired, and cancelled alerts, reminders, and
timers after 48 hours. Cleanup runs at startup and hourly in bounded batches; active
and paused rules, including recurring alerts, remain. Queued or running notification
jobs prevent deletion. Legacy finished records without a retirement timestamp get
a 48-hour grace period on their first cleanup. Event receipts are removed with the
rule; conversation history and job records are retained. This cleanup affects Zero's
catalog, without modifying Home Assistant's stored rules or replaying notifications.

For a named group member's whereabouts or nearby food/places, `location_get`
accepts `member_name` and resolves a unique active member within that group;
`user_id` remains available for explicit selection. It never substitutes the
sender for a named person or silently chooses between ambiguous names. A missing
zone does not hide valid GPS/address observations. Results expose the best
available coordinates, their source and age; older coordinates remain usable
with a warning. Nearby searches use that member's coordinates and every suggested
place includes its Google Maps link.

### Removed reminder backend

The SchedulerSE integration is no longer available in Zero. Its settings, pairing,
client and dedicated event callback have been removed. Existing external schedules
are not migrated or cancelled automatically. Stored backend identities and private
legacy settings are retained; reminders from an unavailable backend are not routed
to Home Assistant or the local scheduler. New clock reminders and timers use Zero's
local scheduler; existing HA rules and additional HA conditions remain supported.

### Admin interface languages

The admin interface supports English and Spanish, following ScribeSE's shared
message dictionary and React provider approach. It detects the browser language
on first use (English fallback). The header EN/ES selector saves a browser
preference and updates `?lang=en` or `?lang=es`, preserving the current page,
editor, tabs and Home Assistant ingress path. Shared URLs and browser back/forward
restore the language. Selection also works when browser storage is unavailable.
Dates, numbers and speech-language names follow the interface language. Speech
configuration, user content and integration identifiers remain independent of the
interface preference. Each profile has a separate English/Spanish reply language
setting for generated replies, briefings, weather alerts and built-in commands.
Existing profiles default to Spanish. This preference applies after the saved
personality prompt without rewriting it, and also applies to its linked Home
Assistant client. Reminder text and quoted user content are retained as written.

UI messages live in `web/i18n/messages.ts`: Spanish source messages are lookup
keys, with English translations and named `{placeholder}` interpolation. Use
`useTranslations()` inside components, and keep stored names, prompts, secrets
and API payload values out of translation lookups. Unknown server errors retain
their original text. Add further locales in `web/i18n/config.ts`, their message
catalog and the header selector.

On first launch, account setup sends the selected interface language to initialize
Zero's default personality prompt in English or Spanish. Account creation and
this initialization share a transaction. Imported or edited prompts are retained;
subsequent language switches never rewrite the saved prompt. The default voice
test sentence follows the interface language until the user edits that sentence.
