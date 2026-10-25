"""Exercise the real HA listener with a small fake weather entity, without HA imports."""
import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

source = Path(__file__).parents[2] / 'integrations/home_assistant/assistant_zero/rules.py'
manager_class = next(node for node in ast.parse(source.read_text()).body if isinstance(node, ast.ClassDef) and node.name == 'Manager')
namespace = {'callback': lambda function: function, 'DATA_COMPONENT': 'weather', 'WeatherEntityFeature': SimpleNamespace(FORECAST_HOURLY=2)}
exec(compile(ast.Module(body=[manager_class], type_ignores=[]), str(source), 'exec'), namespace)
Manager = namespace['Manager']


class WeatherSubscriptionsTests(unittest.IsolatedAsyncioTestCase):
    def manager(self, hourly=True, fail_hourly=False):
        callbacks, removed, tasks = {}, [], []
        def subscribe(kind, callback):
            if kind == 'hourly' and fail_hourly:
                raise ValueError('hourly subscription failed')
            callbacks[kind] = callback
            return lambda: removed.append(kind)
        async def update(kinds):
            for kind in kinds:
                callbacks[kind]([{'datetime': '2026-10-25T01:00:00Z', 'temperature': 20}])
        entity = SimpleNamespace(supported_features=3 if hourly else 1, async_subscribe_forecast=subscribe, async_update_listeners=update)
        manager = Manager.__new__(Manager)
        manager.hass = SimpleNamespace(data={'weather': SimpleNamespace(get_entity=lambda _: entity)}, states=SimpleNamespace(get=lambda _: SimpleNamespace(attributes={'temperature_unit': '°C'})))
        manager.engine = SimpleNamespace(weather=AsyncMock(), rules={})
        manager.listeners = {}
        manager.task = lambda coro: tasks.append(coro)
        return manager, callbacks, removed, tasks

    async def test_opted_in_rule_subscribes_both_types_and_unsubscribes_both_on_pause(self):
        manager, callbacks, removed, tasks = self.manager()
        rule = {'id': 'rule', 'generation': 1, 'kind': 'alert', 'status': 'active', 'condition': {'source': 'weather', 'entity_id': 'weather.home', 'hourly_updates': True}}
        await manager.listen(rule)
        await asyncio.gather(*tasks)
        self.assertEqual(set(callbacks), {'daily', 'hourly'})
        calls = manager.engine.weather.call_args_list
        self.assertEqual({call.args[-1] for call in calls}, {'daily', 'hourly'})
        self.assertTrue(all(call.args[3] == {'temperature': '°C'} for call in calls))
        await manager.listen({**rule, 'status': 'paused'})
        self.assertEqual(removed, ['daily', 'hourly'])
        self.assertEqual(manager.listeners, {})

    async def test_legacy_or_daily_only_provider_keeps_daily_subscription(self):
        for enabled, supported in [(False, True), (True, False)]:
            manager, callbacks, removed, tasks = self.manager(hourly=supported)
            rule = {'id': 'rule', 'generation': 0, 'kind': 'alert', 'status': 'active', 'condition': {'source': 'weather', 'entity_id': 'weather.home', 'hourly_updates': enabled}}
            await manager.listen(rule)
            await asyncio.gather(*tasks)
            self.assertEqual(set(callbacks), {'daily'})
            manager.listeners['rule']()
            self.assertEqual(removed, ['daily'])

    async def test_partial_subscription_failure_cleans_up_without_leaking_daily_listener(self):
        manager, _, removed, tasks = self.manager(fail_hourly=True)
        rule = {'id': 'rule', 'generation': 0, 'kind': 'alert', 'status': 'active', 'condition': {'source': 'weather', 'entity_id': 'weather.home', 'hourly_updates': True}}
        with self.assertRaises(ValueError):
            await manager.listen(rule)
        self.assertEqual(removed, ['daily'])
        self.assertEqual(tasks, [])
        self.assertEqual(manager.listeners, {})
