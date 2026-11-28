"""Route Assist speech to the existing Zero worker, returning speech to Assist TTS."""
import logging
from datetime import timedelta
import uuid

import aiohttp
from homeassistant.components import conversation
from homeassistant.auth.permissions.const import POLICY_CONTROL
from homeassistant.components.homeassistant.exposed_entities import async_should_expose
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er, intent
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from . import DOMAIN
from .client import AccessDenied, BridgeError, converse
from .catalog import assistants
from .transport import request as bridge_request, CatalogUnsupported

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass, entry, async_add_entities):
    async def request(method, path, data=None):
        return await bridge_request(hass, entry.data, method, path, data)

    async def load():
        try:
            return await assistants(request)
        except CatalogUnsupported:
            return {"zero": {"id": "zero", "name": "Zero", "legacy": True}}
        except (BridgeError, TimeoutError, aiohttp.ClientError, ValueError, KeyError, TypeError) as error:
            raise UpdateFailed("Cannot discover Zero assistants") from error

    coordinator = DataUpdateCoordinator(hass, _LOGGER, name="Zero assistant catalog", config_entry=entry,
        update_method=load, update_interval=timedelta(minutes=1))
    await coordinator.async_config_entry_first_refresh()
    added = set()

    def discover():
        new = [ZeroConversation(entry, key, value["name"], coordinator)
            for key, value in coordinator.data.items() if key not in added]
        added.update(entity.assistant_id for entity in new)
        async_add_entities(new)

    entry.async_on_unload(coordinator.async_add_listener(discover))
    discover()


ORIGIN_ENTITIES = 30


def request_origin(hass, device_id, user):
    """The device that heard the request, its area, and the Assist-exposed
    entities Zero may act on there: the device's own, then the area's selects
    (such as a Room Companion panel's Page, Show entity and Preset)."""
    device = dr.async_get(hass).async_get(device_id) if device_id else None
    if device is None:
        return None
    entities_reg = er.async_get(hass)
    area = ar.async_get(hass).async_get_area(device.area_id) if device.area_id else None

    def usable(entity_id):
        return (hass.states.get(entity_id) is not None
                and async_should_expose(hass, "conversation", entity_id)
                and (user is None or user.permissions.check_entity(entity_id, POLICY_CONTROL)))

    own = [entry.entity_id for entry in er.async_entries_for_device(entities_reg, device.id)]
    nearby = []
    if area is not None:
        devices = dr.async_get(hass)
        for entry in entities_reg.entities.values():
            if entry.domain != "select" or entry.device_id == device.id:
                continue
            owner = devices.async_get(entry.device_id) if entry.device_id else None
            entry_area = entry.area_id or (owner.area_id if owner else None)
            if entry_area == area.id:
                nearby.append(entry.entity_id)
    entities = [entity_id for entity_id in dict.fromkeys(own + sorted(nearby)) if usable(entity_id)][:ORIGIN_ENTITIES]
    origin = {"device": (device.name_by_user or device.name or "")[:100], "entities": entities}
    if area is not None:
        origin["area"] = area.name[:100]
    return origin


class ZeroConversation(conversation.ConversationEntity):
    _attr_name = "Zero"
    _attr_supported_features = conversation.ConversationEntityFeature.CONTROL

    def __init__(self, entry, assistant_id="zero", name="Zero", coordinator=None):
        self._entry = entry
        self.assistant_id = assistant_id
        self._coordinator = coordinator
        self._attr_name = name
        self._attr_unique_id = "assistant_zero" if assistant_id == "zero" else "assistant_zero_" + assistant_id

    @property
    def available(self):
        return self._coordinator is None or (self._coordinator.last_update_success and self.assistant_id in self._coordinator.data)

    def _catalog_updated(self):
        item = self._coordinator.data.get(self.assistant_id)
        if item:
            self._attr_name = item["name"]
        self.async_write_ha_state()

    @property
    def device_info(self):
        return DeviceInfo(
            identifiers={(DOMAIN, DOMAIN)},
            name="Zero",
            entry_type=DeviceEntryType.SERVICE,
            configuration_url=self._entry.data["url"].rstrip("/") + "/admin",
        )

    @property
    def supported_languages(self):
        return "*"

    async def async_added_to_hass(self):
        await super().async_added_to_hass()
        if self._coordinator:
            self.async_on_remove(self._coordinator.async_add_listener(self._catalog_updated))
        if self.assistant_id == "zero":
            conversation.async_set_agent(self.hass, self._entry, self)

    async def async_will_remove_from_hass(self):
        if self.assistant_id == "zero":
            conversation.async_unset_agent(self.hass, self._entry)
        await super().async_will_remove_from_hass()

    async def async_process(self, user_input):
        response = intent.IntentResponse(language=user_input.language)
        conversation_id = user_input.conversation_id or str(uuid.uuid4())
        settings = self._entry.data
        # The owner's Assist satellites: satellite_id plus the YAML satellite_ids.
        registry = er.async_get(self.hass)
        satellite_ids = list(dict.fromkeys([settings.get("satellite_id"), *settings.get("satellite_ids", [])]))
        satellites = [entry for entry in (registry.async_get(entity) for entity in satellite_ids if entity) if entry]
        # The satellite that heard this request (sent to Zero), else the primary one.
        heard = next((entry for entry in satellites if user_input.satellite_id == entry.entity_id
                      or (user_input.device_id is not None and user_input.device_id == entry.device_id)), None)
        satellite_id = heard.entity_id if heard else settings.get("satellite_id")
        # HA authenticates the user; Zero resolves the binding and permissions.
        # A device-only satellite retains the legacy owner route.
        user_id = user_input.context.user_id
        user = await self.hass.auth.async_get_user(user_id) if user_id else None
        if user_id:
            allowed = bool(user and user.is_active and not user.system_generated)
        else:
            allowed = heard is not None
        if not allowed:
            response.async_set_error(intent.IntentResponseErrorCode.UNKNOWN, "Este dispositivo no tiene acceso a Zero.")
            return conversation.ConversationResult(response=response, conversation_id=conversation_id)

        async def request(method, path, data):
            return await bridge_request(self.hass, settings, method, path, data)

        try:
            origin = request_origin(self.hass, user_input.device_id, user)
            output = await converse(request, user_input.text, satellite_id, ha_user_id=user_id, origin=origin, assistant_id=None if self._coordinator and self._coordinator.data.get(self.assistant_id, {}).get("legacy") else self.assistant_id)
            response.async_set_speech(output)
        except AccessDenied:
            response.async_set_error(
                intent.IntentResponseErrorCode.UNKNOWN,
                "Tu usuario de Home Assistant no está vinculado a un usuario activo de Zero. Configura el vínculo en la integración ZeroSE.",
            )
        except (BridgeError, TimeoutError, aiohttp.ClientError, ValueError, KeyError, TypeError):
            response.async_set_error(
                intent.IntentResponseErrorCode.UNKNOWN,
                "No pude confirmar la respuesta de Zero. Si pediste una acción, comprueba su resultado antes de repetirla.",
            )
        return conversation.ConversationResult(response=response, conversation_id=conversation_id)
