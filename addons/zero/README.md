# Zero Assistant add-on

This is the Supervisor packaging for the Zero runtime. Build it against a published
Zero image containing `start-home-assistant-addon.js` (override `BUILD_FROM` to pin
a release). The GHCR image is private: the builder needs registry pull access.
This source directory is not a published add-on repository or release.

Configure `database_url` with a dedicated PostgreSQL database supporting pgvector.
Zero keeps its bootstrap encryption key and Codex sessions privately in `/data/zero`;
back up that directory together with the database. Do not replace the key on upgrade.
The Supervisor supplies `SUPERVISOR_TOKEN`; never put it in add-on options.

Open the panel from Home Assistant as an active administrator. Zero checks the
Supervisor peer address and queries Home Assistant for the current user's admin
membership on every authorized request. Missing identity, non-admin users, and
unavailable HA authentication fail closed. No local password is required or created
in this mode. Direct access to the port cannot use Ingress headers to sign in.

Google accounts, Telegram connections, AI providers and personal HA integration
pairings are configured in Zero after entry; Supervisor credentials are never copied
into personal chat profiles. This does not install or upgrade `assistant_zero`.
