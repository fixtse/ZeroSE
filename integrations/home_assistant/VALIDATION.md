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
