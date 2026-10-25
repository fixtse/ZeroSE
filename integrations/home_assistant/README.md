# Private Home Assistant integrations

- `fixtse/ha-zero-assistant`: Zero Assistant Bridge (`assistant_zero`).
- `fixtse/ha-assistant-rules`: event-driven reminders and alerts (`assistant_rules`).

Each private repository contains an installable `custom_components/<domain>`
package, its own description, local brand icon, translations and release version.
This assistant repository retains a tested source snapshot for its existing
installers and protocol tests. Publish integration changes to the matching
repository at the same revision/version; do not edit deployed component files.

## Zero remains independent

Zero owns its model, prompt, memory, queue and integrations. Home Assistant's
conversation entity is a transport into the existing owner conversation. It does
not run another Zero model or store another identity prompt. Telegram and API use
continue without the HA bridge. HA sensors, services and event delivery naturally
require HA to be available. Existing HA-owned deadlines remain in HA.

On first startup of this version, Zero copies `data/prompts.json`'s `main` identity
template into PostgreSQL, without overwriting an existing settings row. Thereafter
`zero_settings` is authoritative for the owner's standard conversation identity.
The next turn reads it afresh. Notification/consolidation templates and Zero's
built-in tool instructions remain distinct; this editor does not replace them.
Normal non-owner/Salem profile prompts are unchanged.

## Home Assistant settings

Install `custom_components/<domain>`, restart HA, then open Settings → Devices &
services → Add integration. Existing YAML entries import once into config entries;
subsequent YAML imports do not overwrite UI settings. Remove the YAML after a
successful migration. Zero's Reconfigure changes its URL, private credentials and
satellite binding. Configure reads the current identity prompt and access policy
from Zero each time; Save writes directly back to Zero. Concurrent edits are
rejected and must be reopened. No policy or prompt is stored in HA options.

The bridge needs separate credentials for voice turns and settings management.
The settings token is HMAC-SHA256(apiKey,
`assistant-home-assistant-settings-v1`); the voice token uses
`assistant-home-assistant-voice-v1`. Provision them privately using the installer
or a secret store. Never paste Zero's administrator API key into HA. Old YAML
voice entries work without a settings token; reconfigure or use the updated
installer to provision settings access. This code change does not run installers,
restart services, register pipelines or change live credentials.

The access master switch governs new owner HA tool calls across transports.
Existing deadlines, callbacks, speech output and non-owner policies are unchanged.
The Assist and Frigate switches additionally gate their service domains. Add exact
`domain.service` names, one per line; new service access defaults to none. Enable
`conversation.process` plus Assist to delegate a user-requested action to HA's
built-in `homeassistant` agent. Other conversation agents are rejected to prevent
routing back to Zero. Frigate must already expose the selected services in HA.
Service definitions are discovered on demand with `ha_services`; catalogs are
never injected into the prompt. HA's service authorization still applies. These
permissions do not imply camera-stream or video-analysis capabilities.

The reminder integration's Configure form changes future callback delivery. Use
Zero's existing reminder/alert tools to inspect or manage individual rules.
Changing a callback never retries an uncertain delivery. The integration does
not have its own assistant prompt.

## HTTP protocol

`GET/PUT /v1/integrations/home-assistant/settings` uses only the dedicated settings
token. PUT accepts `revision`, `prompt`, `homeAssistant`, `assist`, `frigate`, and
`services`; stale revisions return 409. The endpoint is usable without an HA
installation, so Zero's settings do not depend on the HA lifecycle. Tokens are
not returned. Responses are not cached.

Custom integration icons use the local `brand/` format supported by HA 2026.3+.
Private repositories cannot use the public HA brand repository; icons ship in
the integration itself. HACS packaging and README install/configuration buttons live in each integration
repository. HACS cannot download private repositories, even with GitHub login.
Keep using authenticated manual downloads while private; enabling the HACS
buttons requires making the integration repositories public. See
https://www.hacs.dev/docs/faq/private_repositories/.
