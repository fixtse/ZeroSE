# Zero Assistant integration

`fixtse/ha-zero-assistant` now packages conversation, shared settings, reminders,
sensor alerts and weather alerts in one `assistant_zero` component. The old
`assistant_rules` API path and storage key remain stable for existing rules.

Use the offline `scripts/migrate-ha-zero.py` migration only while Home Assistant
is stopped. It backs up private settings/components, retains the Zero entry and
pipeline IDs, merges callback credentials, and removes the separate legacy entry
and component. It never rewrites rule storage or resubmits deadlines.

## Discovery and admin page

Zero advertises `_zero-assistant._tcp.local.` on the local network. With Zeroconf
enabled in Home Assistant, Zero appears under **Settings → Devices & services →
Discovered**. Select it to prefill the URL, then enter the dedicated voice/settings
tokens and choose the satellite. Discovery never changes an existing connection.
The Zero service device has a **Visit** link to the configured server's `/admin` page.
The browser must be able to reach that URL; Home Assistant does not proxy it.

Discovery starts with Zero's HTTP server and stops on shutdown. When configured,
`ASSISTANT_ADMIN_URL` supplies the advertised origin (including reverse proxies).
Otherwise a LAN listener advertises its address/port; a localhost-only listener
is not advertised. Set `ASSISTANT_DISCOVERY=false` to disable advertisements.
Multicast DNS requires UDP 5353 connectivity on the same LAN; use host networking
for containers. Manual setup remains available when multicast is blocked.

## Reminder backend

Zero now stores and schedules new clock reminders and timers locally in PostgreSQL,
without an HA connection. Existing HA reminder identities and installations stay on
HA. Sensor, location and weather conditions, plus wake-up events, remain on HA.
Agents keep the same tools; backend selection is internal. The former SchedulerSE
client, pairing and callback routes have been removed from Zero.
Stored rules keep their original backend identities; removal does not migrate,
replay or cancel external schedules. Private legacy settings remain stored but are
not loaded as active configuration or exposed in the admin panel.

## Android and Home Assistant user identity

In **Settings → Devices & services → Zero Assistant → Configure → Home Assistant
user bindings**, select your Home Assistant account and enter its enabled private
Zero user chat ID from Zero's `/admin` page. This includes administrator accounts:
a phone's device ID does not identify a Zero user. Save once per user; current
bindings appear beside the Home Assistant user names. Leave the chat ID empty to
unlink that user. Zero stores and validates bindings centrally, with revision
checks to prevent overwriting concurrent edits.

Authenticated Assist requests use the bound Zero profile's permissions,
credentials, memory and ordered conversation history, shared with that profile's
Telegram chat. Unbound/inactive users and disabled or removed Zero profiles cannot
submit turns or retrieve results. Binding one HA account to another Zero account
shares that Zero account's conversation; select the intended personal profile.
The configured physical satellite retains its existing owner route when no HA
user identity is supplied. Other devices without an authenticated user are denied.
Existing satellite, entry, pipeline and reminder identities remain unchanged.
Update both the Zero backend and the HACS integration before configuring bindings.
