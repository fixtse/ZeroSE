# Calorie tracking

The owner profile can track food through the Home Assistant
[Calorie Tracker integration](https://github.com/fixtse/ha-calorie-tracker). That integration
holds the food catalog (synced from MyFitnessPal) and the diary. Zero calls its services
using the owner's Home Assistant connection.

> "Recomiéndame algo con unas 500 calorías y 35 g de proteína para la cena."
> "Registra la segunda opción." · "Log 250 g of egg whites for breakfast."
> "How many calories have I eaten today?" · "What was my daily average this month?"

Tools: `food_search`, `food_get`, `food_recommend`, `food_log`, `food_diary`, `food_save`,
`food_log_delete`. They require the `homeAssistant` capability and the integration installed
in that Home Assistant instance.
