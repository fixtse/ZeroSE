"""Real Home Assistant flow smoke checks, run in the isolated Codespace venv."""
import asyncio
import importlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from ipaddress import ip_address
from unittest.mock import AsyncMock, patch

from homeassistant.bootstrap import async_setup_hass
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo
from homeassistant.runner import RuntimeConfig
from homeassistant.setup import async_setup_component
from homeassistant.helpers.data_entry_flow import FlowManagerResourceView
from homeassistant.helpers import device_registry as dr, entity_registry as er


async def main():
    port = int(os.environ.get("TEST_HA_PORT", "18123"))
    assert 1024 <= port <= 65535
    with tempfile.TemporaryDirectory(prefix="ha-integration-check-") as directory:
        components = Path(directory) / "custom_components"
        shutil.copytree(Path(os.environ.get("ZERO_HA_COMPONENT_PATH", "integrations/home_assistant/assistant_zero")), components / "assistant_zero")
        components.joinpath("__init__.py").touch()
        Path(directory, "configuration.yaml").write_text("homeassistant:\n  name: Integration validation\n  latitude: 0\n  longitude: 0\n  elevation: 0\n  unit_system: metric\n  time_zone: UTC\n  currency: EUR\n  country: ES\nhttp:\n  server_port: 18123\n".replace("server_port: 18123", f"server_port: {port}"))
        hass = await async_setup_hass(RuntimeConfig(config_dir=directory))
        assert hass is not None
        catalog_patch = None
        try:
            conversation_module = importlib.import_module("custom_components.assistant_zero.conversation")
            catalog_items = [{"id": "zero", "name": "Zero"}, {"id": "helper", "name": "Helper"}, {"id": "00000000-0000-4000-8000-000000000001", "name": "Planner"}]
            async def catalog_request(hass_arg, settings, method, path, data=None):
                assert method == "GET" and path.startswith("/v1/voice/assistants?"), (method, path)
                return {"items": list(catalog_items), "total": len(catalog_items)}
            catalog_patch = patch.object(conversation_module, "bridge_request", new=AsyncMock(side_effect=catalog_request))
            catalog_patch.start()
            assert await async_setup_component(hass, "assistant_zero", {})
            from relay_checks import verify_relay
            await verify_relay(hass)
            from exposure_checks import verify_exposure
            await verify_exposure(hass)
            from recovery_checks import verify_recovery
            await verify_recovery(hass)
            zero = importlib.import_module("custom_components.assistant_zero.config_flow")
            current = {"revision": 4, "prompt": "Same Zero identity", "homeAssistant": True}
            connection = {"url": "http://zero.invalid:8788", "token": "voice-test-only", "settings_token": "settings-test-only", "satellite_id": "assist_satellite.test"}
            connection_input = {key: value for key, value in connection.items() if key != 'satellite_id'}
            discovery = ZeroconfServiceInfo(ip_address=ip_address("192.0.2.10"), ip_addresses=[ip_address("192.0.2.10")], port=8788, hostname="zero.local.", type="_zero-assistant._tcp.local.", name="Zero._zero-assistant._tcp.local.", properties={"version": "1", "url": "https://zero.example"})
            discovered = await hass.config_entries.flow.async_init("assistant_zero", context={"source": "zeroconf"}, data=discovery)
            assert discovered["type"] == "form", discovered
            fields = FlowManagerResourceView(hass.config_entries.flow)._prepare_result_json(discovered)["data_schema"]
            assert next(field for field in fields if field["name"] == "url")["default"] == "https://zero.example", fields
            assert not hass.config_entries.async_entries("assistant_zero")
            hass.config_entries.flow.async_abort(discovered["flow_id"])
            # Address-only announcements also work for IPv6 and retain the advertised port.
            discovery.properties = {"version": "1"}
            discovery.ip_address = ip_address("2001:db8::10")
            discovered = await hass.config_entries.flow.async_init("assistant_zero", context={"source": "zeroconf"}, data=discovery)
            fields = FlowManagerResourceView(hass.config_entries.flow)._prepare_result_json(discovered)["data_schema"]
            assert next(field for field in fields if field["name"] == "url")["default"] == "http://[2001:db8::10]:8788", fields
            hass.config_entries.flow.async_abort(discovered["flow_id"])
            discovery.properties = {"url": "https://user:secret@zero.example"}
            invalid = await hass.config_entries.flow.async_init("assistant_zero", context={"source": "zeroconf"}, data=discovery)
            assert invalid["type"] == "abort" and invalid["reason"] == "invalid_discovery", invalid
            discovery.properties = {"version": "1", "url": "https://zero.example"}
            # HA starts pairing, validates external state, creates its real long-lived
            # credential and exchanges secrets without exposing them in redirect URLs.
            from homeassistant.auth.const import GROUP_ID_ADMIN
            pairing_user = await hass.auth.async_create_user("Pairing user", group_ids=[GROUP_ID_ADMIN])
            pairing_calls = []
            async def pairing_request(hass_arg, url, path, payload):
                pairing_calls.append((path, payload))
                if path.endswith("/exchange"):
                    assert len(payload["homeAssistantToken"]) > 24
                    return {"token": "zero-pairing-test", "settings_token": "zero-pairing-test", "callback_token": "zero-pairing-test", "callback_url": "https://zero.example/v1/triggers/rule-events"}
                return {"id": "pairing-request", "approvalUrl": "https://zero.example/admin/?pairing=pairing-request"}
            with patch.object(zero, "zero_request", new=pairing_request):
                paired = await hass.config_entries.flow.async_init("assistant_zero", context={"source": "zeroconf"}, data=discovery)
                paired = await hass.config_entries.flow.async_configure(paired["flow_id"], {"url": "https://zero.example", "home_assistant_url": "https://ha.example", "user_id": pairing_user.id})
                assert paired["type"] == "external", paired
                assert "homeAssistantToken" not in paired["url"] and "secret=" not in paired["url"]
                from types import SimpleNamespace
                from homeassistant.components.http import KEY_HASS
                pairing_module = importlib.import_module("custom_components.assistant_zero.pairing")
                view = pairing_module.PairingCallbackView()
                invalid = await view.get(SimpleNamespace(app={KEY_HASS: hass}, query={"state": "0" * 64}), paired["flow_id"])
                assert invalid.status == 400
                callback = await view.get(SimpleNamespace(app={KEY_HASS: hass}, query={"state": pairing_calls[0][1]["state"]}), paired["flow_id"])
                assert callback.status == 200
                duplicate_callback = await view.get(SimpleNamespace(app={KEY_HASS: hass}, query={"state": pairing_calls[0][1]["state"]}), paired["flow_id"])
                assert duplicate_callback.status == 400
                with patch("custom_components.assistant_zero.async_setup_entry", new=AsyncMock(return_value=True)):
                    completed = await hass.config_entries.flow.async_configure(paired["flow_id"])
                    assert completed["type"] == "create_entry", completed
                    await hass.async_block_till_done()
                paired_entry = completed["result"]
                assert "satellite_id" not in paired_entry.data
                assert paired_entry.data["token"] == "zero-pairing-test"
                assert "homeAssistantToken" not in paired_entry.data
                assert len(pairing_calls) == 2
                assert len(pairing_user.refresh_tokens) == 1
                assert next(iter(pairing_user.refresh_tokens.values())).access_token_expiration.days == 3650
                await hass.config_entries.async_remove(paired_entry.entry_id)
                for refresh in list(pairing_user.refresh_tokens.values()):
                    hass.auth.async_remove_refresh_token(refresh)
            # Missing local fields never submit a pairing mutation; transport and
            # approval-origin errors stay distinct and do not trigger retries.
            with patch.object(zero, "zero_request", new=AsyncMock()) as request:
                missing = await hass.config_entries.flow.async_init("assistant_zero", context={"source": "user"})
                missing = await hass.config_entries.flow.async_configure(missing['flow_id'], {'url': 'https://zero.example'})
                assert missing['errors']['base'] == 'pairing_fields', missing
                request.assert_not_awaited()
                hass.config_entries.flow.async_abort(missing['flow_id'])
            for error, code in [(TimeoutError(), 'pairing_unreachable'), (zero.PairingResponseError(404), 'pairing_rejected'), (ValueError('invalid response'), 'pairing_response')]:
                with patch.object(zero, "zero_request", new=AsyncMock(side_effect=error)) as request:
                    failed_start = await hass.config_entries.flow.async_init('assistant_zero', context={'source': 'user'})
                    failed_start = await hass.config_entries.flow.async_configure(failed_start['flow_id'], {'url': 'https://zero.example', 'home_assistant_url': 'https://ha.example', 'user_id': pairing_user.id})
                    assert failed_start['errors']['base'] == code, failed_start
                    assert request.await_count == 1
                    hass.config_entries.flow.async_abort(failed_start['flow_id'])
            with patch.object(zero, 'zero_request', new=AsyncMock(return_value={'approvalUrl': 'https://other.example/admin/?pairing=test'})) as request:
                mismatch = await hass.config_entries.flow.async_init('assistant_zero', context={'source': 'user'})
                mismatch = await hass.config_entries.flow.async_configure(mismatch['flow_id'], {'url': 'https://zero.example', 'home_assistant_url': 'https://ha.example', 'user_id': pairing_user.id})
                assert mismatch['errors']['base'] == 'approval_mismatch', mismatch
                assert request.await_count == 1
                hass.config_entries.flow.async_abort(mismatch['flow_id'])
            # YAML/manual setup also accepts installations without a satellite.
            package = importlib.import_module('custom_components.assistant_zero')
            package.CONFIG_SCHEMA({'assistant_zero': {'url': 'https://zero.example', 'token': 'test'}})
            zero.connection_schema()({key: value for key, value in connection.items() if key != 'satellite_id'})
            assert all(getattr(key, 'schema', key) != 'satellite_id' for key in zero.connection_schema().schema)
            # An uncertain exchange is submitted once and its HA token is revoked.
            async def failed_exchange(hass_arg, url, path, payload):
                if path.endswith("/exchange"):
                    raise TimeoutError("uncertain exchange")
                return {"id": "failed-request", "approvalUrl": "https://zero.example/admin/?pairing=failed-request"}
            with patch.object(zero, "zero_request", new=AsyncMock(side_effect=failed_exchange)) as request:
                failed = await hass.config_entries.flow.async_init("assistant_zero", context={"source": "user"})
                failed = await hass.config_entries.flow.async_configure(failed["flow_id"], {"url": "https://zero.example", "home_assistant_url": "https://ha.example", "user_id": pairing_user.id})
                state = request.call_args.args[3]["state"]
                await hass.config_entries.flow.async_configure(failed["flow_id"], {"state": state})
                failed = await hass.config_entries.flow.async_configure(failed["flow_id"])
                assert failed["type"] == "abort" and failed["reason"] == "pairing_failed", failed
                assert request.await_count == 2 and not pairing_user.refresh_tokens
            with patch.object(zero, "settings_request", new=AsyncMock(return_value=current)) as request:
                result = await hass.config_entries.flow.async_init("assistant_zero", context={"source": "user"})
                assert result["type"] == "form", result
                FlowManagerResourceView(hass.config_entries.flow)._prepare_result_json(result)
                result = await hass.config_entries.flow.async_configure(result["flow_id"], {"url": connection["url"], "manual": True})
                assert result["type"] == "form" and result["step_id"] == "manual", result
                FlowManagerResourceView(hass.config_entries.flow)._prepare_result_json(result)
                result = await hass.config_entries.flow.async_configure(result["flow_id"], connection_input)
                assert result["type"] == "create_entry", result
                entry = result["result"]
                assert 'satellite_id' not in entry.data
                # Simulate an existing pre-upgrade installation, whose saved
                # physical voice identity must survive the new reconfigure form.
                hass.config_entries.async_update_entry(entry, data={**entry.data, 'satellite_id': connection['satellite_id']})
                await hass.async_block_till_done()
                assert entry.state.value == "loaded", entry.state
                duplicate = await hass.config_entries.flow.async_init("assistant_zero", context={"source": "zeroconf"}, data=discovery)
                assert duplicate["type"] == "abort" and duplicate["reason"] == "already_configured", duplicate
                assert entry.data["url"] == connection["url"]
                entities = er.async_get(hass)
                entity_id = entities.async_get_entity_id("conversation", "assistant_zero", "assistant_zero")
                assert entity_id == "conversation.zero", entity_id
                device = dr.async_get(hass).async_get(entities.async_get(entity_id).device_id)
                assert device.configuration_url == "http://zero.invalid:8788/admin", device
                device_id = device.id
                helper_id = entities.async_get_entity_id("conversation", "assistant_zero", "assistant_zero_helper")
                planner_id = entities.async_get_entity_id("conversation", "assistant_zero", "assistant_zero_00000000-0000-4000-8000-000000000001")
                assert helper_id and planner_id
                from homeassistant.components import conversation as conversation_component
                coordinator = conversation_component.async_get_agent(hass, entity_id)._coordinator
                catalog_items.append({"id": "standard", "name": "Standard"})
                await coordinator.async_refresh()
                await hass.async_block_till_done()
                assert entities.async_get_entity_id("conversation", "assistant_zero", "assistant_zero_standard")
                assert entities.async_get_entity_id("conversation", "assistant_zero", "assistant_zero") == entity_id
                catalog_items[:] = [item for item in catalog_items if item["id"] != "standard"]
                await coordinator.async_refresh()
                await hass.async_block_till_done()
                standard_id = entities.async_get_entity_id("conversation", "assistant_zero", "assistant_zero_standard")
                assert not conversation_component.async_get_agent(hass, standard_id).available
                options = await hass.config_entries.options.async_init(entry.entry_id)
                assert options["type"] == "menu", options
                options = await hass.config_entries.options.async_configure(options["flow_id"], {"next_step_id": "assistant"})
                assert options["type"] == "form", options
                schema = options["data_schema"].schema
                assert {str(key) for key in schema} == {"prompt", "homeAssistant"}
                changed = {"prompt": "Edited in HA", "homeAssistant": True}
                result = await hass.config_entries.options.async_configure(options["flow_id"], changed)
                assert result["type"] == "create_entry", result
                sent = request.call_args.args
                assert sent[2] == "PUT" and sent[3] == {**changed, "revision": 4}, sent
                assert "prompt" not in entry.data and not entry.options
                # Import does not replace settings managed through the UI.
                await hass.config_entries.flow.async_init("assistant_zero", context={"source": "import"}, data={**connection, "url": "http://stale.invalid"})
                assert entry.data["url"] == connection["url"]
                # Reconfiguration refreshes the admin link without replacing voice identities.
                reconfigure = await hass.config_entries.flow.async_init("assistant_zero", context={"source": "reconfigure", "entry_id": entry.entry_id})
                result = await hass.config_entries.flow.async_configure(reconfigure["flow_id"], {**connection_input, "url": "http://new-zero.invalid:8788/"})
                assert result["type"] == "abort" and result["reason"] == "reconfigure_successful", result
                await hass.async_block_till_done()
                assert entry.data['satellite_id'] == connection['satellite_id']
                assert entities.async_get(entity_id).device_id == device_id
                assert dr.async_get(hass).async_get(device_id).configuration_url == "http://new-zero.invalid:8788/admin"
                assert len(dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)) == 1
            # Real auth users and Android device IDs route through the Zero binding,
            # without mistaking the phone for the configured physical satellite.
            from homeassistant.auth.const import GROUP_ID_ADMIN
            from types import SimpleNamespace
            from homeassistant.core import Context
            admin_user = await hass.auth.async_create_user("Android admin", group_ids=[GROUP_ID_ADMIN])
            assert admin_user.is_admin and admin_user.is_active
            conversation_module = importlib.import_module("custom_components.assistant_zero.conversation")
            entity = conversation_module.ZeroConversation(entry)
            entity.hass = hass
            phone_input = SimpleNamespace(language="es", conversation_id=None,
                device_id="android-phone", satellite_id=None, text="Who am I?",
                context=Context(user_id=admin_user.id))
            with patch.object(conversation_module, "converse", new=AsyncMock(return_value="Personal reply")) as converse:
                result = await entity.async_process(phone_input)
                assert result.response.speech["plain"]["speech"] == "Personal reply", result
                assert converse.call_args.kwargs["ha_user_id"] == admin_user.id
                assert converse.call_args.kwargs["assistant_id"] == "zero"
                helper = conversation_module.ZeroConversation(entry, "helper", "Helper")
                helper.hass = hass
                await helper.async_process(phone_input)
                assert converse.call_args.kwargs["assistant_id"] == "helper"
                assert converse.call_args.kwargs["ha_user_id"] == admin_user.id
            # The originating device, its area and the exposed selects there reach Zero.
            from homeassistant.components.homeassistant.exposed_entities import async_expose_entity
            from homeassistant.helpers import area_registry as ar
            bedroom = ar.async_get(hass).async_create("Origin bedroom")
            devices = dr.async_get(hass)
            speaker = devices.async_get_or_create(config_entry_id=entry.entry_id, identifiers={("assistant_zero", "origin-speaker")}, name="Bedroom speaker")
            panel = devices.async_get_or_create(config_entry_id=entry.entry_id, identifiers={("assistant_zero", "origin-panel")}, name="Bedroom panel")
            devices.async_update_device(speaker.id, area_id=bedroom.id)
            devices.async_update_device(panel.id, area_id=bedroom.id)
            reg = er.async_get(hass)
            shown = reg.async_get_or_create("select", "assistant_zero", "origin-show", device_id=panel.id, suggested_object_id="bedroom_panel_show_entity")
            hidden = reg.async_get_or_create("select", "assistant_zero", "origin-hidden", device_id=panel.id, suggested_object_id="bedroom_panel_idle_screen")
            for item in (shown, hidden):
                hass.states.async_set(item.entity_id, "None")
            async_expose_entity(hass, "conversation", shown.entity_id, True)
            async_expose_entity(hass, "conversation", hidden.entity_id, False)
            origin = conversation_module.request_origin(hass, speaker.id, admin_user)
            assert origin == {"device": "Bedroom speaker", "area": "Origin bedroom", "entities": [shown.entity_id]}, origin
            assert conversation_module.request_origin(hass, "android-phone", admin_user) is None
            # Configure → Voice devices admits more owner satellites; their turns
            # use the configured satellite identity Zero knows.
            voice_sat = reg.async_get_or_create("assist_satellite", "assistant_zero", "owner-voice", device_id=speaker.id, suggested_object_id="owner_voice")
            panel_sat = reg.async_get_or_create("assist_satellite", "assistant_zero", "owner-panel", device_id=panel.id, suggested_object_id="owner_panel")
            hass.config_entries.async_update_entry(entry, data={**entry.data, "satellite_id": voice_sat.entity_id})
            await hass.async_block_till_done()
            flow = await hass.config_entries.options.async_init(entry.entry_id)
            assert "voice" in flow["menu_options"], flow
            flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "voice"})
            assert flow["type"] == "form" and flow["step_id"] == "voice", flow
            flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"satellite_ids": [voice_sat.entity_id, panel_sat.entity_id]})
            assert flow["type"] == "create_entry", flow
            await hass.async_block_till_done()
            assert entry.data["satellite_ids"] == [voice_sat.entity_id, panel_sat.entity_id], entry.data
            owners = conversation_module.ZeroConversation(entry)
            owners.hass = hass
            spoken = lambda satellite, device: SimpleNamespace(language="es", conversation_id=None, device_id=device,
                satellite_id=satellite, text="Show the lamp", context=Context())
            with patch.object(conversation_module, "converse", new=AsyncMock(return_value="Shown")) as converse:
                result = await owners.async_process(spoken(panel_sat.entity_id, panel.id))
                assert result.response.speech["plain"]["speech"] == "Shown", result
                assert converse.call_args.args[2] == voice_sat.entity_id
                assert converse.call_args.kwargs["origin"]["device"] == "Bedroom panel"
                await owners.async_process(spoken(voice_sat.entity_id, speaker.id))
                refused = await owners.async_process(spoken("assist_satellite.kitchen", "kitchen-device"))
                assert refused.response.error_code is not None and converse.await_count == 2
            # Removing a device from the list revokes it, including the primary one.
            hass.config_entries.async_update_entry(entry, data={**entry.data, "satellite_ids": [panel_sat.entity_id]})
            with patch.object(conversation_module, "converse", new=AsyncMock(return_value="Shown")) as converse:
                refused = await owners.async_process(spoken(voice_sat.entity_id, speaker.id))
                assert refused.response.error_code is not None and converse.await_count == 0
            hass.config_entries.async_update_entry(entry, data={key: value for key, value in entry.data.items() if key != "satellite_ids"})
            # An authenticated Android user works without a physical satellite;
            # an anonymous device never gains the owner fallback from its absence.
            without_satellite = conversation_module.ZeroConversation(SimpleNamespace(data={key: value for key, value in entry.data.items() if key != 'satellite_id'}))
            without_satellite.hass = hass
            with patch.object(conversation_module, 'converse', new=AsyncMock(return_value='User reply')) as converse:
                result = await without_satellite.async_process(phone_input)
                assert result.response.speech['plain']['speech'] == 'User reply'
                assert converse.call_args.args[2] is None
                assert converse.call_args.kwargs['ha_user_id'] == admin_user.id
                anonymous = SimpleNamespace(**{**vars(phone_input), 'context': Context()})
                await without_satellite.async_process(anonymous)
                assert converse.await_count == 1
            with patch.object(conversation_module, "converse", new=AsyncMock(side_effect=conversation_module.AccessDenied())) as converse:
                result = await entity.async_process(phone_input)
                assert result.response.error_code is not None
                assert converse.await_count == 1
            # An inactive or absent user never gets a phone-to-owner fallback.
            with patch.object(conversation_module, "converse", new=AsyncMock()) as converse:
                with patch.object(hass.auth, "async_get_user", new=AsyncMock(return_value=SimpleNamespace(is_active=False))):
                    await entity.async_process(phone_input)
                    converse.assert_not_awaited()
                phone_input.context = Context()
                await entity.async_process(phone_input)
                converse.assert_not_awaited()
            binding_settings = {**current, "homeAssistantUsers": {admin_user.id: "1234"}}
            with patch.object(zero, "settings_request", new=AsyncMock(return_value=binding_settings)) as request:
                options = await hass.config_entries.options.async_init(entry.entry_id)
                options = await hass.config_entries.options.async_configure(options["flow_id"], {"next_step_id": "users"})
                assert options["type"] == "form", options
                FlowManagerResourceView(hass.config_entries.options)._prepare_result_json(options)
                result = await hass.config_entries.options.async_configure(options["flow_id"], {"user_id": admin_user.id, "chat_id": "5678"})
                assert result["type"] == "create_entry", result
                assert request.call_args.args[3] == {"revision": 4, "userId": admin_user.id, "chatId": "5678"}
                assert request.call_args.kwargs["path"] == "/users"
                assert "homeAssistantUsers" not in entry.data and not entry.options
                # Unlinking is explicit and never removes another user's binding.
                options = await hass.config_entries.options.async_init(entry.entry_id)
                options = await hass.config_entries.options.async_configure(options["flow_id"], {"next_step_id": "users"})
                result = await hass.config_entries.options.async_configure(options["flow_id"], {"user_id": admin_user.id, "chat_id": ""})
                assert result["type"] == "create_entry", result
                assert request.call_args.args[3]["chatId"] is None
            # Delivery is configured under the same Zero config entry.
            options = await hass.config_entries.options.async_init(entry.entry_id)
            options = await hass.config_entries.options.async_configure(options["flow_id"], {"next_step_id": "delivery"})
            assert options["type"] == "form", options
            FlowManagerResourceView(hass.config_entries.options)._prepare_result_json(options)
            credentials = {"callback_url": "http://zero.invalid/v1/triggers/rule-events", "callback_token": "test-only-callback-credential-long-enough"}
            result = await hass.config_entries.options.async_configure(options["flow_id"], credentials)
            assert result["type"] == "create_entry", result
            manager = hass.data["assistant_rules"]
            before = manager.engine.rules.copy()
            options = await hass.config_entries.options.async_init(entry.entry_id)
            options = await hass.config_entries.options.async_configure(options["flow_id"], {"next_step_id": "delivery"})
            result = await hass.config_entries.options.async_configure(options["flow_id"], {**credentials, "callback_url": "http://new-zero.invalid/v1/triggers/rule-events"})
            assert result["type"] == "create_entry", result
            assert manager.config["callback_url"].startswith("http://new-zero.invalid")
            assert manager.engine.rules == before
            from tracker_location_checks import verify_tracker_locations
            await verify_tracker_locations(hass, manager)
            assert len(hass.config_entries.async_entries("assistant_zero")) == 1
            assert not hass.config_entries.async_entries("assistant_rules")
            for domain in ("assistant_zero",):
                assert (components / domain / "brand/icon.png").read_bytes().startswith(b"\x89PNG")
                assert json.loads((components / domain / "strings.json").read_text())["options"]
            print("Real Home Assistant: Android admin routing, inactive/unbound phone denial, user binding/unlink options, setup, both config/options flows, shared prompt PUT, no cached prompt, import preservation, callback update, discovery, admin link, retained voice/device identities and icons passed")
        finally:
            await hass.async_stop(force=True)
            if catalog_patch:
                catalog_patch.stop()


asyncio.run(main())
