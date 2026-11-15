# Calorie Tracker (Home Assistant)

A Home Assistant integration that keeps a food catalog and food diary, and imports your
MyFitnessPal custom foods, saved meals, recipes and every food in your diary history.
Zero reads and writes it through its services. The data lives in
`/config/.storage/calorie_tracker.data`.

## Install

Copy `custom_components/calorie_tracker` into Home Assistant's `/config/custom_components/`,
restart, then **Settings → Devices & services → Add integration → Calorie Tracker**.

## MyFitnessPal cookie (the "token")

The setup form asks for your MyFitnessPal session cookie. To get it:

1. Log in at <https://www.myfitnesspal.com> in your browser.
2. Open developer tools → **Storage** (Firefox/Zen) or **Application** (Chrome) → **Cookies** →
   `https://www.myfitnesspal.com`.
3. Copy the value of `__Secure-next-auth.session-token`.

Home Assistant stores the cookie in its config entry and saves the new value each time
MyFitnessPal rotates it. If it expires, Home Assistant shows a **Re-authenticate** prompt;
paste a fresh cookie there. You can also replace it at any time with
**⋮ → Reconfigure** on the integration.

## Syncing

- **Button:** `button.calorie_tracker_sync_myfitnesspal` starts a background sync.
- **Service:** `calorie_tracker.sync_myfitnesspal` with an optional `since: 2020-01-01` to rescan.
- **Automatic:** daily at the time set in the options (default 04:30).

The first sync scans the diary from the **history start** option (default 2020-01-01). That takes
about an hour; progress is saved every 30 days and resumes after a restart. Later syncs only scan
from the last scanned day. Imports only add or update foods, never delete them.
`sensor.calorie_tracker_myfitnesspal_sync` shows the state (`running`, `ok`, `error`,
`auth_failed`), progress and counts.

From the server shell:

```sh
curl -X POST -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
  -d '{"entity_id":"button.calorie_tracker_sync_myfitnesspal"}' \
  http://127.0.0.1:8123/api/services/button/press
```

## Entities

`sensor.calorie_tracker_calories_today` (with per-meal and entry attributes), `…_protein_today`,
`…_carbohydrates_today`, `…_fat_today`, `…_calories_remaining` (when a daily goal is set in the
options), `…_myfitnesspal_sync` and the sync button.

## Services

All of these return data (`return_response`). Correctable errors come back as
`{"error": "..."}` when a response is requested.

| Service | Purpose |
|---|---|
| `search_foods` | Search by name/brand, most used first |
| `get_food` | All nutrients, serving sizes and ingredients |
| `recommend_foods` | Foods and portions close to any of `calories`, `protein`, `carbohydrates`, `fat` |
| `log_food` | Log `food_id` with `servings` or `quantity` + `unit`, or `name` + nutrients. `meal` accepts breakfast/desayuno, lunch/almuerzo, dinner/cena, snack |
| `get_diary` | A day's entries and totals, or a range with daily averages |
| `save_food` | Add or update a custom food |
| `delete_entries` | Remove diary entries |
| `sync_myfitnesspal` | Import from MyFitnessPal |

MyFitnessPal has no public API. The integration uses the website's own endpoints, which can
change without notice. It only reads from MyFitnessPal; it never writes there.

Tests: `python3 -B -m unittest discover -s integrations/calorie_tracker/tests`.
