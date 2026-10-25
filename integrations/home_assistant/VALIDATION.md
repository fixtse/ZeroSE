# Validation record — 2026-10-25

Execution was remote in the dedicated Codespace
`assistant-ha-integrations-x59w6g566gghp7qj`.

Assistant checkout: `/workspaces/assistant-ha-validation`, repository
`fixtse/node-assistant`, branch `feat/ha-integration-settings`, based on
`53b692887d165fee385a88bf77a6257f67341e89` with the synchronized task changes.
The exact executable source files tested match assistant commit `a6fcf71`.
Local and remote SHA-256 fingerprints of `src/`, `scripts/`, `test/` and both
component directories matched:
`c88de3578c4dc5bacc8328ed3e78cf3604ba04ea49ac77be506616f0b0bff1d7`.

Passed:

- Locked installation with pnpm 11.28.6.
- `pnpm format:check`.
- `pnpm check`.
- `pnpm test`: 118 TypeScript tests and 31 Python tests.
- `pnpm build`.
- `docker compose config --quiet`.
- `docker compose -f compose.yaml -f compose.build.yaml config --quiet`.
- `python test/ha_runtime/verify.py` in an isolated Python 3.14 venv with
  Home Assistant 2026.10.4: both integrations loaded; real config/options
  flows; prompt PUT with revision; no cached prompt; YAML import preservation;
  callback update without changing rule state; local PNG icons.

Tests used a dedicated PostgreSQL/pgvector container and `TEST_DATABASE_URL`.
No production credentials, state or volumes were used. Only the test database
image was pulled; no assistant Docker image was built locally or in Codespaces.
Optional FFmpeg/turbojpeg warnings in the HA test environment did not prevent
integration loading; media/camera processing was not tested.

Independent package checkouts were `/workspaces/assistant-ha-packages/ha-zero-assistant`
and `/workspaces/assistant-ha-packages/ha-assistant-rules`, each on its own
initialized `main` branch before its first commit, with its own correct GitHub
origin. Component bytes were compared with the validated assistant snapshot.
`python3 -B -m unittest discover -s tests` and Python `compileall` passed:
5 tests for Zero and 25 tests for rules, including HACS layout, manifests,
icons, and README install/setup link parameters. Published source revisions are
recorded in `repositories.json`.

Logs in the Codespace: `/tmp/assistant-ha-validation.log` and
`/tmp/assistant-ha-packages.log`. Completion wrappers preserved actual exit
codes and posted result metadata to this thread's private webhook. The relay
returned HTTP 202. The queued callbacks subsequently arrived in this thread,
confirming end-to-end delivery. Earlier failed attempts were superseded by the
verified final successful runs. During execution the agent also checked logs and
command sessions; that redundant polling did not follow the webhook-first policy.

HACS's GitHub validator and an actual HACS download remain unverified because
HACS does not support private repositories. Both repositories remain private.
No live installer, pipeline registration, deployment, or service restart was run.

## Public repositories and project icon update

Run `zero-brand-public-20261025-r2` completed successfully in the same dedicated
Codespace. Its immutable result is
`/workspaces/zero-brand-public-20261025-r2/result.json`; its log is
`/tmp/zero-brand-public-20261025-r2.log`. The callback arrived in this thread and
was checked against those files. No progress polling was used for this run.

The assistant checkout remained `/workspaces/assistant-ha-validation` on
`feat/ha-integration-settings`, based on `53b6928` with synchronized task sources.
Independent repositories were cloned under the run directory from `9596b76`
(Zero) and `2dbbdea` (rules), then overlaid with the exact README/icon changes.
Both package test suites and compilation checks passed. The run also passed
`pnpm format:check`, `pnpm check`, `pnpm test` (118 TypeScript and 31 Python tests),
`pnpm build`, both Compose config checks, and the real Home Assistant lifecycle
smoke check. Zero's icon was compared byte-for-byte with `assets/icon.png`.

Both integration repositories are now public, as explicitly authorized. The
assistant backend remains private. The READMEs contain concise HACS install/setup
steps. Zero version 1.1.1 uses the project icon. Updated source revisions are in
`repositories.json`. No live integration was deployed or restarted. Actual
installation through a live HACS instance was not performed.

## Unified integration and optional SchedulerSE backend

Run `zero-unified-scheduler-20261025-r2` passed remotely in the dedicated Codespace.
Immutable result: `/workspaces/zero-unified-scheduler-20261025-r2/result.json`.
Log: `/tmp/zero-unified-scheduler-20261025-r2.log`. The callback was received and
verified. The parent checkout was `/workspaces/assistant-ha-validation`, branch
`feat/ha-integration-settings`, base `53b6928` plus synchronized task sources.
The public Zero checkout started at `a8e0a94` plus the merged component changes.

Passed all required pnpm checks/build (120 TypeScript and 32 Python tests), both
Compose configuration checks, 29 standalone package tests, component compilation,
and real Home Assistant config/options flows under one Zero entry. Offline
migration tests preserve the original entry ID, rule storage and pipeline file.
The first run failed because a weather test referenced the old source location;
the second run corrected the path and passed without replaying any live action.

The unified package is version 1.2.0, recorded in `repositories.json`. SchedulerSE
is an optional, explicitly configured reminder backend. Existing backend identities
are retained, and sensor/weather conditions remain on HA. No SchedulerSE credentials
or installation-wide webhook destination were changed. Its adapter was checked
against the published API and a simulated HTTP service; a live SchedulerSE schedule
has not been created. Backend source changes are on this feature branch and have
not been deployed as a new assistant image.

The earlier repository-rename deployment repair was verified separately: build
`5f513b3f6216081c9ed97e68eb616e50a423a3c4` is healthy and the worker is active with
the corrected repository setting. Local HA migration has its own completion record.

## Local unified installation verified

Run `zero-unified-ha-install-20261025-r1` completed successfully. Private result:
`data/ha-migrations/zero-unified-ha-install-20261025-r1/result.json`; private log:
`data/ha-migrations/zero-unified-ha-install-20261025-r1/install.log`.
The callback was received and checked against the saved result and live service.
Home Assistant now has one `assistant_zero` entry, version 1.2.0; the old separate
component is absent. The original entry ID, all three rule IDs, `conversation.zero`
and the Assist pipeline data were preserved. The offline configuration check
passed before startup. Both `/api/assistant_rules` (protocol 2, ready) and the
existing conversation entity returned HTTP 200 after migration.

The private rollback backup is `/config/backups/zero-unified-ha-install-20261025-r1`.
No reminder deadline was resubmitted and no test utterance/action was sent to Zero.
The standalone rules repository is now deprecated and archived; its releases remain
available. SchedulerSE remains optional and unconfigured, with its backend code on
the feature branch. No live SchedulerSE schedules or connection settings changed.
