"""Recovery ownership/delivery checks with the pinned real HA service registry."""
import importlib
from types import SimpleNamespace
from unittest.mock import patch

from homeassistant.exceptions import HomeAssistantError


async def verify_recovery(hass):
    recovery = importlib.import_module("custom_components.assistant_zero.recovery")
    user = await hass.auth.async_create_user("Recovery check")
    other = await hass.auth.async_create_user("Other recovery check")
    entries = {}
    entities = {}
    registrations = {}
    registered_targets = {}
    received = []
    fail = set()

    async def notify(call):
        received.append((call.service, call.data, call.context.user_id))
        if call.service in fail:
            raise HomeAssistantError("Synthetic uncertain notification")

    def phone(key, service, platform="mobile_app"):
        entry = SimpleNamespace(entry_id=key, domain="mobile_app", data={"webhook_id": "private-" + key, "device_id": key})
        entries[key] = entry
        entities["device_tracker." + key] = SimpleNamespace(platform=platform, disabled_by=None, config_entry_id=key, unique_id=key)
        registrations["private-" + key] = entry
        registered_targets[service] = "private-" + key
        hass.services.async_register("notify", service, notify)

    phone("phone", "mobile_app_renamed_phone")
    phone("tablet", "mobile_app_tablet")
    phone("other", "mobile_app_other")
    phone("router", "mobile_app_router", platform="router")
    hass.states.async_set("person.recovery_check", "home", {
        "user_id": user.id,
        "device_trackers": ["device_tracker.phone", "device_tracker.tablet", "device_tracker.phone", "device_tracker.router", "device_tracker.missing"],
    })
    hass.states.async_set("person.other_recovery_check", "home", {"user_id": other.id, "device_trackers": ["device_tracker.other"]})
    mobile = {recovery.DATA_CONFIG_ENTRIES: registrations, recovery.DATA_NOTIFY: SimpleNamespace(registered_targets=registered_targets)}
    assert "mobile_app" not in hass.data
    hass.data["mobile_app"] = mobile
    registry = SimpleNamespace(async_get=entities.get)
    try:
        with patch.object(recovery.er, "async_get", return_value=registry), patch.object(type(hass.config_entries), "async_get_entry", side_effect=entries.get):
            targets = recovery.recovery_targets(hass, user)
            assert targets == ["mobile_app_renamed_phone", "mobile_app_tablet"], targets
            assert recovery.recovery_targets(hass, other) == ["mobile_app_other"]
            await recovery.send_recovery(hass, user, targets, "12345678")
            assert [item[0] for item in received] == targets
            assert all(item[1]["message"].startswith("Código: 12345678.") and item[2] == user.id for item in received)
            # One failure must not prevent the other device from being attempted once.
            received.clear()
            fail.add(targets[0])
            try:
                await recovery.send_recovery(hass, user, targets, "23456789")
                raise AssertionError("Uncertain delivery was reported as successful")
            except ValueError:
                pass
            assert sorted(item[0] for item in received) == targets
            assert len(received) == 2
            fail.clear()
            # A replaced phone is picked up immediately, with no enrollment or startup send.
            hass.states.async_set("person.recovery_check", "home", {"user_id": user.id, "device_trackers": ["device_tracker.tablet"]})
            received.clear()
            try:
                await recovery.send_recovery(hass, user, targets, "34567890")
                raise AssertionError("Stale destinations were accepted")
            except ValueError:
                pass
            assert not received
            assert recovery.recovery_targets(hass, user) == ["mobile_app_tablet"]
            # Registry changes, disabled trackers and unregistered notification actions fail closed.
            entities["device_tracker.tablet"].disabled_by = "user"
            assert recovery.recovery_targets(hass, user) == []
            entities["device_tracker.tablet"].disabled_by = None
            registrations.clear()
            assert recovery.recovery_targets(hass, user) == []
            connection = SimpleNamespace(user=user, send_error=lambda *args: errors.append(args))
            errors = []
            assert recovery._authorized(connection, {"id": 99, "user_id": other.id}) is None
            assert errors[0][1] == "unauthorized"
        print("Real HA recovery: current person ownership, multiple devices, identity separation, renamed actions, replacements, disabled/stale devices and one-shot partial failures passed")
    finally:
        del hass.data["mobile_app"]
        for name in registered_targets:
            hass.services.async_remove("notify", name)
        hass.states.async_remove("person.recovery_check")
        hass.states.async_remove("person.other_recovery_check")
        # The first real HA user is the owner and cannot be removed. The temporary
        # HA instance is discarded after this smoke test.
        if not user.is_owner:
            await hass.auth.async_remove_user(user)
        await hass.auth.async_remove_user(other)
