# ZeroSE add-on

Runs the Zero runtime as a Home Assistant add-on with Ingress access.

[![Add the ZeroSE add-on repository to your Home Assistant.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Ffixtse%2FZeroSE)

GitHub Actions publishes the prebuilt `ghcr.io/fixtse/zerose-addon` image (amd64 and
aarch64) from `main`, tagged with the `version` in `config.yaml`. Bump that version
to release an add-on update. To build locally instead, remove `image:` and override
`BUILD_FROM` to pin a Zero release.

The default `database_backend: postgres` requires `database_url` pointing to a
dedicated PostgreSQL database supporting pgvector. For an embedded database, select
`database_backend: pglite` and leave `database_url` empty. PGlite stores all database
state (including Mem0 vectors) in `/data/zero/pglite`, with no separate database server.
This is a backend choice for a new installation, not an automatic data migration.
Do not switch an existing installation without an explicit, verified migration.
Only one Zero process or administrative command may open a PGlite directory at a time.
Stop Zero before offline database commands or copying its PGlite directory for backup.
Zero keeps its bootstrap encryption key and Codex sessions privately in `/data/zero`;
back up that directory together with the database (the entire directory for PGlite). Do not replace the key on upgrade.
The Supervisor supplies `SUPERVISOR_TOKEN`; never put it in add-on options.

Open the panel from Home Assistant as an active administrator. Zero checks the
Supervisor peer address and queries Home Assistant for the current user's admin
membership on every authorized request. Missing identity, non-admin users, and
unavailable HA authentication fail closed. No local password is required or created
in this mode. Direct access to the port cannot use Ingress headers to sign in.

Google accounts, Telegram connections, AI providers and personal HA integration
pairings are configured in Zero after entry; Supervisor credentials are never copied
into personal chat profiles. This does not install or upgrade `assistant_zero`.
