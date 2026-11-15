"""Today's nutrition totals and the MyFitnessPal sync status."""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_DAILY_GOAL, DOMAIN, SIGNAL_UPDATED

TOTALS = (
    ("calories_today", "Calories today", "calories", "kcal", "mdi:fire"),
    ("protein_today", "Protein today", "protein", "g", "mdi:food-steak"),
    ("carbohydrates_today", "Carbohydrates today", "carbohydrates", "g", "mdi:bread-slice"),
    ("fat_today", "Fat today", "fat", "g", "mdi:oil"),
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    tracker = entry.runtime_data
    entities: list[SensorEntity] = [TotalSensor(tracker, *spec) for spec in TOTALS]
    if entry.options.get(CONF_DAILY_GOAL):
        entities.append(RemainingSensor(tracker, entry.options[CONF_DAILY_GOAL]))
    entities.append(SyncSensor(tracker))
    add(entities)


class Base(SensorEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, tracker, key: str, name: str) -> None:
        self.tracker = tracker
        self._attr_unique_id = f"{DOMAIN}_{key}"
        self._attr_name = name
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, "tracker")}, name="Calorie Tracker", entry_type=DeviceEntryType.SERVICE)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_UPDATED, self._refresh))

    @callback
    def _refresh(self) -> None:
        self.async_write_ha_state()


class TotalSensor(Base):
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, tracker, key, name, nutrient, unit, icon) -> None:
        super().__init__(tracker, key, name)
        self.nutrient = nutrient
        self._attr_native_unit_of_measurement = unit
        self._attr_icon = icon
        self._attr_suggested_display_precision = 0

    @property
    def native_value(self):
        return self.tracker.catalog.day(self.tracker.today())["totals"][self.nutrient] or 0

    @property
    def extra_state_attributes(self):
        if self.nutrient != "calories":
            return None
        day = self.tracker.catalog.day(self.tracker.today())
        return {"meals": {m: v["calories"] for m, v in day["meals"].items()},
                "entries": [f"{e['meal']}: {e['name']} ({e['calories'] or 0:g} kcal)" for e in day["entries"]][:30]}


class RemainingSensor(Base):
    _attr_native_unit_of_measurement = "kcal"
    _attr_icon = "mdi:target"

    def __init__(self, tracker, goal: int) -> None:
        super().__init__(tracker, "calories_remaining", "Calories remaining")
        self.goal = goal

    @property
    def native_value(self):
        eaten = self.tracker.catalog.day(self.tracker.today())["totals"]["calories"] or 0
        return round(self.goal - eaten)

    @property
    def extra_state_attributes(self):
        return {"goal": self.goal}


class SyncSensor(Base):
    _attr_icon = "mdi:cloud-sync"

    def __init__(self, tracker) -> None:
        super().__init__(tracker, "myfitnesspal_sync", "MyFitnessPal sync")

    @property
    def native_value(self):
        return self.tracker.status.get("state", "idle")

    @property
    def extra_state_attributes(self):
        return {**{k: v for k, v in self.tracker.status.items() if k != "state"},
                "foods": len(self.tracker.catalog.foods),
                "diary_scanned_through": self.tracker.catalog.sync.get("diary_scanned_through")}
