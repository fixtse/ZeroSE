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
step. Automatic deployment is optional and uses the signed host webhook described below.

### Deploy successful GitHub Actions builds automatically

The optional host worker receives signed GitHub `workflow_run` webhooks at
`https://twk.kcta.cc/github/deploy`. It accepts only successful `main` builds from
`fixtse/node-assistant` using `.github/workflows/images.yaml`. Pull requests, other
repositories, other branches, failed runs, and older out-of-order runs are ignored.
The existing image workflow needs no deployment credentials or Docker access on the host.

Build the TypeScript host worker with `pnpm build`. Create a private `.env.deploy`
(mode `0600`) beside `.env`, using a fresh secret of at least 32 characters:

```dotenv
ASSISTANT_DEPLOY_SECRET=replace-with-a-fresh-random-secret
ASSISTANT_DEPLOY_REPOSITORY=fixtse/node-assistant
ASSISTANT_DEPLOY_PORT=8790
ASSISTANT_DEPLOY_NOTIFY_CHAT=6977841634
# Ensure this PATH contains node and docker when launched by systemd.
# PATH=/path/to/node/bin:/usr/local/bin:/usr/bin
# For unattended registry access, point at a private Docker config that works without a desktop login.
# DOCKER_CONFIG=/private/path/to/docker-config
```

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
A healthy rollout sends a Spanish notification through Salem to the configured chat;
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
{"session":"personal","text":"¿Qué tengo que hacer hoy?","name":"Sergio"}
```

It returns HTTP 202 with a `jobId`. Poll `GET /v1/jobs/<jobId>` with the same
authorization for status, output, or error. An optional `Idempotency-Key` header
deduplicates submissions within a session. Jobs from the same session run in order;
separate sessions can run concurrently.

Telegram supports `disabled`, `webhook`, or `polling` transport. Polling needs no
public ingress and refuses to start if a webhook already exists. Webhook mode uses
`POST /telegram/webhook` and validates `X-Telegram-Bot-Api-Secret-Token` plus the
independent user/group access policy. Neither transport registers or removes a webhook on startup.

## Wake-up briefing

Wake-up reminders such as “remind me in two days when I wake up” use
`wake_reminder_create` with a local calendar date. They are appended to that
owner chat’s briefing when the wake-up webhook runs (the `input_boolean.dormir`
on → off automation), without guessing a clock time or sending a separate alert.
They are completed only after successful delivery and are not replayed on later
dates. Fixed-time briefings do not consume them. Wake-ups are deduplicated per
local date independently of an earlier fixed-time briefing.

Set `schedules.morning` to `""` to disable the fixed morning time while keeping
reset and memory-consolidation schedules enabled. Home Assistant can call
`POST /v1/triggers/morning` with `Authorization: Bearer <config.apiKey>` when
`input_boolean.dormir` changes from `on` to `off`. No body is required. This
queues the usual morning briefing for `telegram.notificationChatId`, using the
same session ordering, with its own daily deduplication key. A wake-up also
suppresses a later timed briefing that day. Repeated calls return the existing job, including failed jobs, without replaying delivery.
The endpoint requires `schedules.enabled` and a configured notification recipient.
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

With the updated `assistant_rules` HA integration, the owner's built-in weather
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
- Google Docs personal context, appending context, and Markdown-to-document creation with PDF export URLs.
- Codex web search, public URL reading, and Brave image search when configured.
- Home Assistant shopping-list reads/additions/completion/removal, sensor discovery/current values,
  and up to seven days of recorded sensor history. Sensor access can be restricted to named entities.
- On-demand home/away and known-zone awareness, with GPS accuracy, geocoded address and source timestamps for location-aware suggestions.
- Dedicated Telegram reminders and countdown timers, with cancellation, snooze, pause/resume and optional fixed-interval reminders. Home Assistant owns their event-driven schedules; they do not create calendar events.
- Conditional sensor alerts and forecast-update rain alerts, scoped to each chat's permitted Home Assistant connection.
- OpenStreetMap place/address lookup and driving distance/time estimates, with clickable Google Maps links. All place suggestions must include Maps links, including suggestions obtained through web search.
- Saved-memory browsing/deletion and attributed, chat-scoped conversation search across daily resets.
- Gemini semantic memory retrieval with category/date filters, stored and searched using pgvector.
- Native memory consolidation, daily short-term reset, morning agenda, and optional event reminders.
  The original disabled 15-minute reminder routine remains disabled by default.
- Memory consolidation considers both user messages and assistant replies, retaining relevant advice and plans with explicit attribution. Prior suggestions remain distinct from user decisions or completed actions, and can be recalled through `memories_get`. Consolidation runs on the existing schedule; important context can also be saved immediately with `memory_save`.

### Reminders, timers and conditional alerts

Install the event-driven Home Assistant integration explicitly from the host checkout:

```sh
pnpm rules:install-home-assistant
```

The installer reads private `config.json`, backs up affected files **inside** the
`home-assistant` container, installs the small HA-native Python integration under
`/config/custom_components/assistant_rules`, validates Home Assistant configuration,
and restarts **Home Assistant only** to load it. The assistant remains running.
It removes the previous ten-second heartbeat automation, shell command and curl
credential file while preserving other automations. Overrides:
`ASSISTANT_HA_CONTAINER` and `ASSISTANT_RULES_CALLBACK_URL` (default
`http://127.0.0.1:8788/v1/triggers/rule-events`, using the configured assistant port).
The callback URL must be reachable from Home Assistant. A private included YAML
file holds a derived, purpose-specific bearer credential; it cannot access the
chat or administrator APIs. Reinstall after rotating `config.apiKey`. Install the
integration in each separate HA instance used for conditional alerts.

**There is no heartbeat or periodic assistant callback.** The TypeScript assistant
creates/changes rules through the integration's authenticated API. Home Assistant
stores them durably, schedules deadlines precisely, and listens directly to sensor
state and weather forecast updates. Callback payloads contain only rule ID,
generation, unique event ID and timestamps—never a chat recipient, arbitrary
message or model-supplied URL. No model runs during evaluation or delivery.

The callback validates the rule's current generation and permissions, then
atomically records its unique event and queues a notification in the chat's
existing ordered queue. Duplicate/stale callbacks are ignored. Permission changes,
pausing, cancellation and snoozing suppress old queued notifications. An active
conversation can still delay delivery. Normal enabled Telegram chats can create
reminders/timers using the installation's HA scheduler; conditional alerts require
the chat's own permitted HA connection. Scheduling from HTTP chats is unsupported.

`reminder_create` takes an ISO timestamp with offset and optional `repeat_seconds`;
this repeats at a fixed elapsed interval, **not** a DST-aware local daily time.
`timer_start` takes seconds. `reminders_list`, `reminder_get` and `reminder_change`
inspect, cancel, snooze, pause or resume rules. `reminder_get` includes the remote
scheduler's status and latest callback outcome for inspecting uncertain effects.
Missed deadlines expire rather than replaying on HA restart; recurring reminders
skip missed occurrences and resume at the next future deadline. A completed local
rule has queued its notification; it is not a Telegram delivery receipt.

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

The activation command requires the live `ASSISTANT_DATABASE_URL` when it is not
already configured in private `config.json`; use the same private encryption key
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
Disabled memory and Salem's stricter saving policy remain in force. No growing
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

Turn instructions include at most 12 distinct configured `memory.categories`, with no
stored category/tag catalog. Legacy `{{categories}}` placeholders receive this stable list;
`{{tags}}` receives an empty string. Consolidation also uses only the configured category
list and an empty tag list. The model can call `memory_catalog` on demand to discover
existing categories or tags within its current session/shared profile. It accepts `kind`
(`categories` by default, or `tags`), a case-insensitive `search`, and the standard bounded
pagination arguments. Discovery is optional before searching or saving.

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
| Memory | `memories_get`, `memory_catalog`, `memory_read`, `memory_save` | Always |
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
assistant checks the configured Telegram secret header and the independently permitted chat.
`https://twk.kcta.cc/health` should return `{"status":"ok"}` once routing is ready.

Register the Telegram webhook with `secret_token` matching `telegram.webhookSecret`,
set `telegram.transport` to `webhook`, and enable the intended schedules. Preserve pending
updates when changing registration. Startup does not register or remove webhooks.

## User and group administration

Open `/admin` on the assistant's public HTTPS origin and sign in as **fixt** with the
administrator password. Better Auth stores password hashes and sessions in PostgreSQL.
Sessions last 30 days, renew while active, and survive application restarts and deployments.
Use **Cambiar contraseña** in the header to change the password: the current browser remains
signed in and other sessions are revoked. Login attempts are rate-limited, registration is
disabled, and browser sessions use HttpOnly cookies with Secure enabled for HTTPS.

Set `ASSISTANT_ADMIN_URL` to the exact public origin (production Compose defaults to
`https://twk.kcta.cc`); this controls trusted origins, CSRF checks and secure cookies.
For local development, set it to your local HTTP origin. Provision the first account with
a password in a private file (12–128 characters, outside the repository and container mounts):

```sh
pnpm run admin:password --password-file /private/initial-password.txt
```

The command refuses to replace an existing account. For an explicit recovery reset, add
`--reset`; this also revokes all existing sessions. Normal password changes belong in the
web interface. Never commit the initial password file. The page no longer asks for the
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

Zero retains its existing token and transport. Configure the separate **Salem** token and
activation switch in the web interface. Salem receives updates exclusively through
`POST /telegram/salem/webhook`; it never starts a poller or a settings polling timer. Enter
that route's public HTTPS URL, then use **Guardar y registrar webhook**. The application
stores a separate encrypted webhook secret and registers the webhook once for that explicit
save, preserving pending Telegram updates. It never registers or retries mutations at startup.
Use **Comprobar webhook** for a read-only status check, including URL, pending update count
and Telegram's last delivery error. If registration is uncertain, inspect its state before
saving again. Disabling Salem ignores authenticated incoming updates without deleting its
Telegram webhook. Zero retains its own route, secret and configured transport. Salem's
account-scoped update deduplication keys are preserved across migration from polling.

Every user or group that contacts either bot appears in the searchable, paginated chat list.
New contacts are **pending and disabled**, including contacts of Salem. Select “Solo pendientes”
to review them, then enable each chat manually. No model invocation, transcription, ordinary
reply, error reply or typing indicator is sent for an unapproved chat. The exception is the
Spanish welcome with chat ID when a bot is added to a group. Joining does not grant access.
A permitted user's presence never authorizes a group; group access must be enabled separately.
When you enable a user or group from the web interface, the bot publishes a Telegram `/`
command menu scoped to that chat: `/nuevo`, plus `/clean` when tasks are enabled. Saving
an enabled chat refreshes its menu; disabling it clears that chat's command list. If
Telegram registration fails, access settings remain saved and the web interface reports
the menu failure without automatically retrying. Save the chat again to update its menu.

In enabled groups, Salem processes only messages that explicitly mention its Telegram username
in the message text or media caption, including `/command@username`. Replies without a mention,
ordinary conversation, and forwarded media without a mention are ignored before queueing or
media downloads. Reply to a video with `@your_salem_username` to request its transcript.
Private chats and Zero retain their existing behavior; group welcome and migration events
are handled separately. Salem resolves its username through `getMe` on demand and caches it
for the configured token.

Each chat has a **Respuestas de voz** toggle. Turn it off to keep text replies without
synthesized audio; transcription remains available. The global `telegram.voiceReplies`
setting still controls whether voice output is available at all.
Choose **Personalidad → Salem** for the Spanish sarcastic cat persona with a brief closing
remark, or **Estándar** for the standard assistant. Salem chats default to the Salem preset;
Zero retains its existing prompt by default. Each chat uses its own current time and timezone.
Prompt selection does not grant tools or change the chat’s memory mode.

New profiles start with public web search, public page reads, media input/transcription and
chat-scoped memory. Google Calendar, Tasks, Docs/Drive and Home Assistant are disabled.
Enable these categories and supply that profile's own OAuth credentials or Home Assistant
API token in its connection settings. Google requires an OAuth client ID, client secret and
refresh token with the scopes of the enabled services, plus calendar/task-list IDs as needed;
Google account passwords are not used. Empty secret fields preserve saved secrets; explicit
connection-removal checkboxes clear them. Profiles never inherit the owner's accounts.
Tool catalogs are filtered per turn, application tool calls recheck permissions before running,
and built-in web search follows that chat's web permission. Changing the tool catalog
starts a fresh agent thread with retained application conversation history; stored messages
and long-term memory are not deleted. Revoking access also suppresses
queued messages and delivery of an in-flight answer.

A user chat and a group chat have independent conversation threads, history and memory;
group memory is shared by that group's participants. Salem and Zero are also isolated, even
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
  requests are made for that profile's saves, searches or consolidation.
- **None:** keep the conversation context, but disable long-term memory tools, external context
  document reads/writes, and automatic memory consolidation. Messages written in this mode stay
  in the conversation history but are excluded from later automatic consolidation.

Changing modes does not delete saved facts or existing vectors. Previously saved memories become
available again after enabling memory. Simple facts remain keyword-searchable after switching to
advanced; existing facts are not automatically re-embedded. Existing profiles default to advanced
memory and inherit the installation timezone until an administrator saves their own timezone.
The scheduler interprets the configured reset and consolidation times in each profile's local
calendar and timezone, including daylight-saving changes, and deduplicates daily runs per chat
and local date. The editor shows those configured wall-clock times. A daily reset clears the
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

Preparation privately backs up `config.json` and sets `homeAssistant.voiceSatellite`.
The default satellite is `assist_satellite.home_assistant_voice_09ee50_assist_satellite`;
set `ASSISTANT_VOICE_SATELLITE` for another device. The callback defaults to the
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
