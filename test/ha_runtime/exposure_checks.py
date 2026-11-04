"""Assist exposure checks against the pinned real HA policy and service registry."""
import importlib
from types import SimpleNamespace
from unittest.mock import patch

from homeassistant.auth.const import GROUP_ID_ADMIN
from homeassistant.components.homeassistant.const import DATA_EXPOSED_ENTITIES
from homeassistant.components.homeassistant.exposed_entities import async_set_assistant_option
from homeassistant.helpers.service import async_set_service_schema


async def verify_exposure(hass):
    exposure = importlib.import_module("custom_components.assistant_zero.exposure")
    user = await hass.auth.async_create_user("Exposure check", group_ids=[GROUP_ID_ADMIN])
    policy = hass.data[DATA_EXPOSED_ENTITIES]
    prior_default = policy.async_get_expose_new_entities("conversation")
    results, errors, received = [], [], []
    connection = SimpleNamespace(user=user, send_result=lambda *args: results.append(args),
                                 send_error=lambda *args: errors.append(args))

    async def turn_on(call):
        received.append((call.data, call.context.user_id))

    async def command(handler, **data):
        results.clear()
        errors.clear()
        await handler.__wrapped__(hass, connection, {"id": 1, **data})
        return results[-1][1] if results else None

    def expose(entity, value):
        async_set_assistant_option(hass, "conversation", entity, "should_expose", value)

    def rejected(service, data, description=None):
        try:
            exposure.service_targets(hass, user, service, description if description is not None else {"target": {}}, data)
        except ValueError:
            return
        raise AssertionError((service, data))

    try:
        hass.states.async_set("light.zero_exposed", "off", {"friendly_name": "Zero exposed"})
        hass.states.async_set("light.zero_hidden", "off")
        hass.states.async_set("sensor.zero_custom", "12", {"device_class": "temperature"})
        hass.states.async_set("script.zero_test", "off")
        # The native default decision is used, including device classes and expose-new.
        policy.async_set_expose_new_entities("conversation", True)
        assert exposure.permitted(hass, user, "light.zero_exposed")
        assert exposure.permitted(hass, user, "sensor.zero_custom")
        policy.async_set_expose_new_entities("conversation", False)
        hass.states.async_set("light.zero_default_off", "off")
        assert not exposure.permitted(hass, user, "light.zero_default_off")
        expose("sensor.zero_custom", False)
        expose("light.zero_exposed", True)
        expose("light.zero_hidden", False)
        expose("script.zero_test", True)
        items = await command(exposure._entities, search="zero_", offset=0, limit=1)
        assert items["total"] == 2 and items["next_offset"] == 1, items
        assert items["items"][0]["entity_id"] == "light.zero_exposed", items
        state = await command(exposure._entity, entity_id="light.zero_exposed")
        assert state["state"] == "off", state
        assert await command(exposure._entity, entity_id="light.zero_hidden") is None and errors
        # Temporary services use the real HA descriptions registry and actual dispatch.
        hass.services.async_register("light", "zero_check", turn_on)
        async_set_service_schema(hass, "light", "zero_check", {"target": {"entity": [{"domain": "light"}]}})
        hass.services.async_register("script", "zero_test", turn_on)
        async_set_service_schema(hass, "script", "zero_test", {})
        catalog = await command(exposure._services, search="zero_", offset=0, limit=20)
        assert {item["service"] for item in catalog["items"]} == {"light.zero_check", "script.zero_test"}, catalog
        result = await command(exposure._call, service="light.zero_check", data={"entity_id": "light.zero_exposed"})
        assert result["accepted"] and received == [({"entity_id": ["light.zero_exposed"]}, user.id)], received
        result = await command(exposure._call, service="script.zero_test", data={"variables": {"message": "hello"}})
        assert result["accepted"] and len(received) == 2
        for data in [
            {}, {"entity_id": "all"}, {"entity_id": []}, {"entity_id": "light.zero_hidden"},
            {"entity_id": ["light.zero_exposed", "light.zero_hidden"]},
            {"entity_id": "light.zero_exposed", "area_id": "kitchen"},
            {"entity_id": "light.zero_exposed", "device_id": "anything"},
            {"entity_id": "light.zero_exposed", "floor_id": "upstairs"},
            {"entity_id": "light.zero_exposed", "label_id": "anything"},
            {"entity_id": "light.zero_exposed", "target": {"entity_id": "light.zero_hidden"}},
            {"entity_id": "light.zero_exposed", "group_members": ["light.zero_hidden"]},
        ]:
            rejected("light.zero_check", data)
        rejected("switch.turn_on", {"entity_id": "light.zero_exposed"})
        rejected("homeassistant.restart", {"entity_id": "light.zero_exposed"})
        rejected("frigate.restart", {"entity_id": "light.zero_exposed"}, {})
        rejected("conversation.process", {"agent_id": "conversation.zero"}, {})
        # Exposure removal after discovery blocks the very next read and action.
        expose("light.zero_exposed", False)
        assert await command(exposure._entity, entity_id="light.zero_exposed") is None and errors
        assert await command(exposure._call, service="light.zero_check", data={"entity_id": "light.zero_exposed"}) is None and errors
        assert len(received) == 2
        expose("script.zero_test", False)
        rejected("script.zero_test", {})
        # Exposure grants no permissions that the HA user lacks.
        expose("light.zero_exposed", True)
        with patch.object(type(user.permissions), "check_entity", return_value=False):
            assert not exposure.permitted(hass, user, "light.zero_exposed")
            rejected("light.zero_check", {"entity_id": "light.zero_exposed"})
        # An uncertain dispatch is attempted once and never reported as successful.
        async def fail(call):
            received.append((call.data, call.context.user_id))
            raise exposure.HomeAssistantError("Synthetic failure")
        hass.services.async_register("light", "zero_check", fail)
        assert await command(exposure._call, service="light.zero_check", data={"entity_id": "light.zero_exposed"}) is None and errors
        assert len(received) == 3
        print("Real HA Assist exposure: defaults, overrides, pagination, reads, services, scripts, revocation, user permissions, target bypasses and one-shot failures passed")
    finally:
        policy.async_set_expose_new_entities("conversation", prior_default)
        hass.services.async_remove("light", "zero_check")
        hass.services.async_remove("script", "zero_test")
        for entity in ("light.zero_exposed", "light.zero_hidden", "sensor.zero_custom", "script.zero_test", "light.zero_default_off"):
            hass.states.async_remove(entity)
        if not user.is_owner:
            await hass.auth.async_remove_user(user)
