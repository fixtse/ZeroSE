# Zero Assistant integration

`fixtse/ha-zero-assistant` now packages conversation, shared settings, reminders,
sensor alerts and weather alerts in one `assistant_zero` component. The old
`assistant_rules` API path and storage key remain stable for existing rules.

Use the offline `scripts/migrate-ha-zero.py` migration only while Home Assistant
is stopped. It backs up private settings/components, retains the Zero entry and
pipeline IDs, merges callback credentials, and removes the separate legacy entry
and component. It never rewrites rule storage or resubmits deadlines.

## Optional SchedulerSE backend

Timed reminders can use SchedulerSE independently of Home Assistant. Sensor and
weather alerts still require Home Assistant. Existing schedules keep their backend;
there is no automatic migration or outage failover that could duplicate delivery.

Configure Zero privately (not in the HA prompt):

```json
{
  "schedulerSE": {
    "enabled": true,
    "url": "https://scheduler.example.com",
    "token": "<private agent API token>",
    "callbackUrl": "https://zero.example.com/v1/triggers/schedulerse-events"
  }
}
```

In SchedulerSE, configure webhook delivery to that exact callback URL. Use the
complete Authorization header with a dedicated callback token derived as
HMAC-SHA256(Zero apiKey, `zero-schedulerse-callback-v1`). Provision it through a
private secret store. The adapter validates the destination and never changes
SchedulerSE's installation-wide connection automatically. Leave `enabled` false
until configured. No polling bridge is required, and no second assistant prompt
is stored. SchedulerSE callbacks use stable occurrence IDs, existing Zero rule
generations and durable duplicate suppression. Uncertain writes are not replayed.

New reminders use the chosen backend; already installed HA rules remain on HA.
SchedulerSE is optional and has not been enabled or deployed by this code change.
The Zero bridge uses the project's existing icon.
