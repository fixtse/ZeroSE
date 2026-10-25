"""Real Home Assistant flow smoke checks, run in the isolated Codespace venv."""
import asyncio
import importlib
import json
from pathlib import Path
import shutil
import tempfile
from unittest.mock import AsyncMock, patch

from homeassistant.bootstrap import async_setup_hass
from homeassistant.runner import RuntimeConfig
from homeassistant.setup import async_setup_component


async def main():
    with tempfile.TemporaryDirectory(prefix="ha-integration-check-") as directory:
        components = Path(directory) / "custom_components"
        shutil.copytree(Path("integrations/home_assistant/assistant_zero"), components / "assistant_zero")
        shutil.copytree(Path("integrations/home_assistant/assistant_rules"), components / "assistant_rules")
        components.joinpath("__init__.py").touch()
        Path(directory, "configuration.yaml").write_text("homeassistant:\n  name: Integration validation\n  latitude: 0\n  longitude: 0\n  elevation: 0\n  unit_system: metric\n  time_zone: UTC\n  currency: EUR\n  country: ES\nhttp:\n  server_port: 18123\n")
        hass = await async_setup_hass(RuntimeConfig(config_dir=directory))
        assert hass is not None
        try:
            assert await async_setup_component(hass, "assistant_zero", {})
            zero = importlib.import_module("custom_components.assistant_zero.config_flow")
            current = {"revision": 4, "prompt": "Same Zero identity", "homeAssistant": True, "assist": False, "frigate": False, "services": []}
            connection = {"url": "http://zero.invalid:8788", "token": "voice-test-only", "settings_token": "settings-test-only", "satellite_id": "assist_satellite.test"}
            with patch.object(zero, "settings_request", new=AsyncMock(return_value=current)) as request:
                result = await hass.config_entries.flow.async_init("assistant_zero", context={"source": "user"})
                assert result["type"] == "form", result
                result = await hass.config_entries.flow.async_configure(result["flow_id"], connection)
                assert result["type"] == "create_entry", result
                entry = result["result"]
                await hass.async_block_till_done()
                assert entry.state.value == "loaded", entry.state
                options = await hass.config_entries.options.async_init(entry.entry_id)
                assert options["type"] == "form", options
                changed = {key: value for key, value in current.items() if key != "revision"}
                changed.update(prompt="Edited in HA", services="light.turn_on\nfrigate.restart", frigate=True)
                result = await hass.config_entries.options.async_configure(options["flow_id"], changed)
                assert result["type"] == "create_entry", result
                sent = request.call_args.args
                assert sent[2] == "PUT" and sent[3]["revision"] == 4, sent
                assert sent[3]["services"] == ["light.turn_on", "frigate.restart"]
                assert "prompt" not in entry.data and not entry.options
                # Import does not replace settings managed through the UI.
                await hass.config_entries.flow.async_init("assistant_zero", context={"source": "import"}, data={**connection, "url": "http://stale.invalid"})
                assert entry.data["url"] == connection["url"]
            assert await async_setup_component(hass, "assistant_rules", {})
            result = await hass.config_entries.flow.async_init("assistant_rules", context={"source": "user"})
            assert result["type"] == "form", result
            credentials = {"callback_url": "http://zero.invalid/v1/triggers/rule-events", "callback_token": "test-only-callback-credential-long-enough"}
            result = await hass.config_entries.flow.async_configure(result["flow_id"], credentials)
            assert result["type"] == "create_entry", result
            entry = result["result"]
            await hass.async_block_till_done()
            assert entry.state.value == "loaded", entry.state
            assert "assistant_rules" in hass.data
            manager = hass.data["assistant_rules"]
            before = manager.engine.rules.copy()
            options = await hass.config_entries.options.async_init(entry.entry_id)
            result = await hass.config_entries.options.async_configure(options["flow_id"], {**credentials, "callback_url": "http://new-zero.invalid/v1/triggers/rule-events"})
            assert result["type"] == "create_entry", result
            assert manager.config["callback_url"].startswith("http://new-zero.invalid")
            assert manager.engine.rules == before
            for domain in ("assistant_zero", "assistant_rules"):
                assert (components / domain / "brand/icon.png").read_bytes().startswith(b"\x89PNG")
                assert json.loads((components / domain / "strings.json").read_text())["options"]
            print("Real Home Assistant: setup, both config/options flows, shared prompt PUT, no cached prompt, import preservation, callback update and icons passed")
        finally:
            await hass.async_stop(force=True)


asyncio.run(main())
