"""Real pinned HA: schemas, coordinate-only changes, hold validation, cleanup."""
import asyncio
import importlib
import json
from pathlib import Path
import shutil
import tempfile
from unittest.mock import AsyncMock
from uuid import uuid4

from homeassistant.bootstrap import async_setup_hass
from homeassistant.runner import RuntimeConfig
from homeassistant.setup import async_setup_component
import voluptuous as vol


async def main():
    with tempfile.TemporaryDirectory(prefix='ha-location-check-') as directory:
        components = Path(directory) / 'custom_components'
        shutil.copytree(Path('integrations/home_assistant/assistant_zero'), components / 'assistant_zero')
        components.joinpath('__init__.py').touch()
        Path(directory, 'configuration.yaml').write_text('homeassistant:\n  name: Location tests\n  latitude: 0\n  longitude: 0\n  elevation: 0\n  unit_system: metric\n  time_zone: UTC\n  currency: EUR\n  country: ES\nhttp:\n  server_port: 18157\n')
        hass = await async_setup_hass(RuntimeConfig(config_dir=directory))
        assert hass is not None
        manager = None
        try:
            assert await async_setup_component(hass, 'assistant_zero', {})
            module = importlib.import_module('custom_components.assistant_zero.rules')
            manager = module.Manager(hass, {})
            manager.engine.emit = AsyncMock(return_value='accepted')
            manager.ready = True
            def person(entity, longitude):
                hass.states.async_set(entity, 'not_home', {'latitude': 0, 'longitude': longitude, 'gps_accuracy': 5})
            person('person.a', 0)
            person('person.b', .04)
            hass.states.async_set('zone.office', '0', {'latitude': 0, 'longitude': .02, 'radius': 100})
            condition = dict(source='distance', entity_id='person.a', target_entity_id='person.b', operator='below', distance_m=3200, reset_margin_m=100, hold_seconds=0, max_age_seconds=3600, max_accuracy_m=200)
            value = dict(id=str(uuid4()), generation=0, kind='alert', status='active', next_at=None, repeat_seconds=None, condition=condition, cooldown_seconds=60, recurring=True)
            for invalid in [float('nan'), float('inf'), True]:
                try:
                    module.RULE_SCHEMA({**value, 'condition': {**condition, 'distance_m': invalid}})
                except vol.Invalid:
                    pass
                else:
                    raise AssertionError('Accepted invalid numeric threshold')
            await manager.put('owner', module.RULE_SCHEMA(value))
            assert manager.engine.emit.call_count == 0
            person('person.b', .02)  # State stays not_home: attributes alone must trigger.
            person('person.b', .04)  # Capture both crossings even before task dispatch.
            await hass.async_block_till_done()
            assert manager.engine.emit.call_count == 1
            person('person.b', .021)
            await hass.async_block_till_done()
            assert manager.engine.emit.call_count == 1
            await manager.put('owner', module.RULE_SCHEMA({**value, 'generation': 1, 'status': 'paused'}))
            assert value['id'] not in manager.listeners
            zone = {**value, 'id': str(uuid4()), 'recurring': False, 'condition': {key: val for key, val in {**condition, 'source': 'zone', 'target_entity_id': 'zone.office', 'operator': 'enter'}.items() if key != 'distance_m'}}
            await manager.put('owner', module.RULE_SCHEMA(zone))
            person('person.a', .02)
            await hass.async_block_till_done()
            assert manager.engine.emit.call_count == 2
            assert zone['id'] not in manager.listeners
            try:
                await manager.put('owner', module.RULE_SCHEMA({**value, 'id': str(uuid4()), 'condition': {**condition, 'target_entity_id': 'person.a'}}))
            except ValueError:
                pass
            else:
                raise AssertionError('Accepted self-distance')
            print(json.dumps({'result': 'passed', 'checks': ['schemas', 'coordinate-only changes', 'crossing baseline', 'one-shot cleanup', 'pause cleanup', 'self-distance rejection']}))
        finally:
            if manager:
                await manager.stop()
            await hass.async_stop()


asyncio.run(main())
