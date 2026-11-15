# Calorie tracking

Zero's owner profile can keep a food diary from Telegram or Home Assistant Assist:

> "Log two eggs and a coffee with milk for breakfast."
> "How many calories have I eaten today?" · "What was my daily average this week?"

Tools (owner only): `food_search`, `food_get`, `food_save`, `food_log`, `food_diary`,
`food_log_delete`. Foods and entries are stored in PostgreSQL (`nutrition_foods`,
`nutrition_entries`). Days follow the owner profile's timezone.

## Importing foods from MyFitnessPal

`scripts/mfp_export.py` exports your MyFitnessPal recipes, saved meals and every food in
your diary into `data/nutrition/mfp-export.json`. Zero imports that file automatically
the next time a food tool runs. Imports only add or update foods. They never delete foods
or diary entries.

```sh
python3 -m venv ~/.venvs/mfp
~/.venvs/mfp/bin/pip install -r scripts/mfp-requirements.txt
# Log in at https://www.myfitnesspal.com in Firefox or Chrome on this machine, then:
~/.venvs/mfp/bin/python scripts/mfp_export.py --since 2020-01-01   # first run: full history
~/.venvs/mfp/bin/python scripts/mfp_export.py                      # later runs: incremental
```

Later runs re-read recipes and meals and scan the diary from the last scanned day. To pick
up a new MyFitnessPal food, log it in MyFitnessPal once and run the exporter again.

- Run it from the directory that contains Zero's `data/` folder, or pass `--output` or set
  `ASSISTANT_DATA_DIR`.
- A diary food's serving is the logged quantity and unit (for example `150 g`). Only the
  nutrient columns enabled in your MyFitnessPal diary are exported.
- The exporter uses the unofficial `python-myfitnesspal` scraper with your browser's
  cookies. It can break when MyFitnessPal changes its site, and it never stores your password.
- Custom foods that you created but never logged are not exported. Log them once, or
  add them in chat ("save a food: arepa, 1 unit, 180 kcal, 30 g carbs").
