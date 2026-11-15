"""Button that starts a MyFitnessPal sync in the background."""

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    add([SyncButton(entry.runtime_data)])


class SyncButton(ButtonEntity):
    _attr_has_entity_name = True
    _attr_name = "Sync MyFitnessPal"
    _attr_unique_id = f"{DOMAIN}_sync_myfitnesspal"
    _attr_icon = "mdi:cloud-download"

    def __init__(self, tracker) -> None:
        self.tracker = tracker
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, "tracker")}, name="Calorie Tracker", entry_type=DeviceEntryType.SERVICE)

    async def async_press(self) -> None:
        self.tracker.start_sync()
