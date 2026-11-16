# Calorie tracking

The owner profile can track food through the Home Assistant
[Calorie Tracker integration](https://github.com/fixtse/ha-calorie-tracker). That integration
holds the food catalog (synced from MyFitnessPal) and the diary. Zero calls its services
using the owner's Home Assistant connection.

> "Recomiéndame algo con unas 500 calorías y 35 g de proteína para la cena."
> "Registra la segunda opción." · "Log 250 g of egg whites for breakfast."
> "Copia la cena de ayer a hoy." · "Corrige el arroz del almuerzo: eran 150 g."
> "How many calories have I eaten today?" · "What was my daily average this month?"

Tools: `food_search`, `food_get`, `food_recommend`, `food_log`, `food_diary`, `food_save`,
`food_log_delete`, `food_log_update` (correct an entry's portion, meal, time or values) and
`food_copy_day` (repeat a past day or some of its meals). They require the `homeAssistant` capability and the integration installed
in that Home Assistant instance.

Zero can discover new packaged foods directly from Open Food Facts using
`food_catalog_search` (name/brand, paginated) and `food_barcode_lookup` (EAN/UPC).
Supply the barcode digits or a readable label photo. Coverage and label completeness
vary; a missing result is not evidence that the food does not exist. Check the
product and nutrient units before saving with `food_save`. Catalog barcodes are
not local food IDs. These lookups do not import an export or change the diary.
