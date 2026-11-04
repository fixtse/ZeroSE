"""Validate tracker schemas and actual state-change subscriptions in pinned HA."""
import importlib
import json
from unittest.mock import AsyncMock, patch
from uuid import uuid4
from homeassistant.auth.const import GROUP_ID_ADMIN
from homeassistant.components.homeassistant.exposed_entities import async_set_assistant_option
import voluptuous as vol


async def verify_tracker_locations(hass, manager):
    rules = importlib.import_module('custom_components.assistant_zero.rules')
    user = await hass.auth.async_create_user('GPS alert owner', group_ids=[GROUP_ID_ADMIN])
    if not manager.ready:
        await manager.start()
    assert manager.ready
    response = await rules.RulesView(manager).get(None)
    assert json.loads(response.text)['device_tracker_location_alerts'] is True
    for index, (first, second) in enumerate([('device_tracker.gps_a', 'person.gps_b'), ('person.gps_a', 'device_tracker.gps_b'), ('device_tracker.gps_a', 'device_tracker.gps_b')]):
        condition = dict(source='distance', entity_id=first, target_entity_id=second, operator='below', distance_m=300, hold_seconds=0, reset_margin_m=100, max_age_seconds=3600, max_accuracy_m=200)
        condition = rules.DISTANCE_CONDITION(condition)
        hass.states.async_set(first, 'not_home', {'latitude': 0, 'longitude': 0, 'gps_accuracy': 5})
        hass.states.async_set(second, 'not_home', {'latitude': 0, 'longitude': .01, 'gps_accuracy': 5})
        for entity_id in (first, second):
            async_set_assistant_option(hass, 'conversation', entity_id, 'should_expose', True)
        value = rules.RULE_SCHEMA(dict(id=str(uuid4()), generation=0, kind='alert', status='active', next_at=None, repeat_seconds=None, condition=condition, cooldown_seconds=60, recurring=True))
        with patch.object(manager.engine, 'emit', new=AsyncMock(return_value='accepted')) as emit:
            installed = await manager.put(user.id, value)
            await hass.async_block_till_done()
            emit.assert_not_awaited()
            hass.states.async_set(second, 'not_home', {'latitude': 0, 'longitude': .001, 'gps_accuracy': 5})
            await hass.async_block_till_done()
            assert emit.await_count == 1, (index, manager.engine.rules[installed['id']])
            async_set_assistant_option(hass, 'conversation', second, 'should_expose', False)
            assert not await manager.authorized(installed)
            assert await manager.emit({'id': installed['id']}) == 'ignored'
            operation = AsyncMock()
            await manager.dispatch(installed['id'], operation())
            operation.assert_not_awaited()
            # Revoked entities must not prevent cancelling the original rule identity.
            await manager.put(user.id, {**value, 'generation': 1, 'status': 'cancelled'})
    zone = {key: value for key, value in condition.items() if key != 'distance_m'}
    rules.ZONE_CONDITION({**zone, 'source': 'zone', 'entity_id': 'device_tracker.gps_a', 'target_entity_id': 'zone.home', 'operator': 'enter'})
    try:
        rules.DISTANCE_CONDITION({**condition, 'target_entity_id': 'sensor.address'})
    except vol.Invalid:
        pass
    else:
        raise AssertionError('Non-GPS sensor accepted')
    print('Real HA: person/device_tracker GPS pairs, event-driven crossings and capability negotiation passed')
