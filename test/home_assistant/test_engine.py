"""Test HA's real scheduler core without a running Home Assistant instance."""
import importlib.util
import pathlib
import unittest
from copy import deepcopy

PATH = pathlib.Path(__file__).resolve().parents[2] / 'integrations/home_assistant/assistant_rules/engine.py'
spec = importlib.util.spec_from_file_location('assistant_rules_engine', PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
RuleEngine, iso = module.RuleEngine, module.iso


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 1792152000.0
        self.saved, self.events, self.pending, self.states = {}, [], {}, {}
        self.engine = self.make_engine()

    def make_engine(self):
        async def persist(rules):
            self.saved = deepcopy(rules)
        async def emit(event):
            self.assertEqual(self.saved[event['id']]['last_event']['outcome'], 'pending')
            self.events.append(event)
            return 'accepted'
        def schedule(at, callback):
            key = object()
            self.pending[key] = (at, callback)
            return lambda: self.pending.pop(key, None)
        return RuleEngine(lambda: self.now, persist, schedule, emit, lambda entity: self.states.get(entity))

    def value(self, **extra):
        return {'id': 'test-rule', 'generation': 0, 'kind': 'timer', 'status': 'active', 'next_at': iso(self.now + 60), 'repeat_seconds': None, 'condition': None, 'cooldown_seconds': 60, 'recurring': False, **extra}

    async def advance(self, seconds):
        self.now += seconds
        for key, (at, callback) in list(self.pending.items()):
            if at <= self.now and key in self.pending:
                self.pending.pop(key)
                await callback()

    async def feed(self, state):
        self.states['sensor.freezer'] = state
        await self.engine.sensor('test-rule', 0, state)

    def sensor(self, **extra):
        return self.value(kind='alert', next_at=None, condition={'entity_id': 'sensor.freezer', 'operator': 'above', 'value': -10, 'hold_seconds': 20}, **extra)

    async def test_deadline_survives_restart_and_fires_once(self):
        await self.engine.put('owner', self.value())
        self.engine.stop()
        self.engine = self.make_engine()
        await self.engine.restore(self.saved)
        await self.advance(60)
        await self.engine.deadline('test-rule', 0)
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.saved['test-rule']['status'], 'completed')
        self.assertEqual(self.saved['test-rule']['last_event']['outcome'], 'accepted')

    async def test_missed_deadlines_expire_and_recurring_skips_catchup(self):
        await self.engine.put('owner', self.value())
        self.now += 120
        self.engine.stop()
        await self.engine.restore(self.saved)
        self.assertEqual(self.saved['test-rule']['status'], 'expired')
        self.assertEqual(self.events, [])
        await self.engine.put('owner', self.value(generation=1, repeat_seconds=60))
        self.now += 180
        self.engine.stop()
        await self.engine.restore(self.saved)
        self.assertGreater(module.timestamp(self.saved['test-rule']['next_at']), self.now)
        self.assertEqual(self.events, [])

    async def test_hold_breaks_on_unavailable_and_rechecks_current_state(self):
        await self.engine.put('owner', self.sensor())
        await self.feed('-5')
        await self.advance(10)
        await self.feed('unavailable')
        await self.advance(20)
        self.assertEqual(self.events, [])
        await self.feed('-5')
        self.states['sensor.freezer'] = 'unknown'
        await self.advance(20)
        self.assertEqual(self.events, [])
        await self.feed('-5')
        await self.advance(20)
        self.assertEqual(len(self.events), 1)

    async def test_restart_resets_incomplete_holds(self):
        await self.engine.put('owner', self.sensor())
        await self.feed('-5')
        await self.advance(10)
        self.engine.stop()
        self.engine = self.make_engine()
        await self.engine.restore(self.saved)
        await self.feed('-5')
        await self.advance(10)
        self.assertEqual(self.events, [])
        await self.advance(10)
        self.assertEqual(len(self.events), 1)

    async def test_rearm_schedules_cooldown_without_polling(self):
        value = self.sensor(recurring=True)
        value['condition']['hold_seconds'] = 0
        await self.engine.put('owner', value)
        await self.feed('-5')
        await self.feed('unavailable')
        await self.feed('-5')
        self.assertEqual(len(self.events), 1)
        await self.feed('-15')
        await self.advance(10)
        await self.feed('-5')
        await self.advance(50)
        self.assertEqual(len(self.events), 2)

    async def test_forecast_baseline_changes_rain_and_cooldown(self):
        await self.engine.put('owner', self.value(kind='alert', next_at=None, recurring=True, condition={'source': 'weather', 'entity_id': 'weather.home', 'horizon_hours': 24, 'minimum_probability': 30}))
        forecast = [{'datetime': iso(self.now + 3600), 'condition': 'rainy', 'temperature': 20, 'precipitation_probability': 70}]
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(self.events, [])
        forecast[0]['temperature'] = 15
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(len(self.events), 1)
        await self.advance(60)
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(len(self.events), 1)
        forecast[0]['temperature'] = 12
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(len(self.events), 2)

    async def test_failed_callback_is_not_replayed_on_restart(self):
        async def fail(_event):
            raise TimeoutError()
        self.engine.emit = fail
        await self.engine.put('owner', self.value())
        await self.advance(60)
        self.assertEqual(self.saved['test-rule']['last_event']['outcome'], 'uncertain')
        self.engine.stop()
        await self.engine.restore(self.saved)
        await self.advance(60)
        self.assertEqual(self.events, [])

    async def test_ownership_generation_and_cancelled_deadlines(self):
        await self.engine.put('owner', self.value())
        with self.assertRaises(PermissionError):
            await self.engine.put('other', self.value(generation=1))
        await self.engine.put('owner', self.value(generation=1, status='cancelled'))
        await self.engine.deadline('test-rule', 0)
        await self.advance(120)
        self.assertEqual(self.events, [])
        with self.assertRaises(ValueError):
            await self.engine.put('owner', self.value())

    async def test_resume_preserves_cooldown_instead_of_emitting_an_early_callback(self):
        value = self.sensor(recurring=True)
        value['condition']['hold_seconds'] = 0
        await self.engine.put('owner', value)
        await self.feed('-5')
        last_fired = self.saved['test-rule']['last_fired']
        await self.engine.put('owner', {**value, 'generation': 1, 'last_fired': last_fired})
        self.states['sensor.freezer'] = '-5'
        await self.engine.sensor('test-rule', 1, '-5')
        self.assertEqual(len(self.events), 1)
        await self.advance(60)
        self.assertEqual(len(self.events), 2)

    async def weather_rule(self, **condition):
        await self.engine.put('owner', self.value(kind='alert', next_at=None, recurring=True, condition={'source': 'weather', 'entity_id': 'weather.home', 'horizon_hours': 24, 'minimum_probability': 30, **condition}))

    def forecast(self, condition='sunny', **fields):
        return [{'datetime': iso(self.now + 3600), 'condition': condition, 'precipitation_probability': 0, **fields}]

    async def test_general_forecast_alert_includes_dry_storms_snow_wind_fog_and_clearing(self):
        await self.weather_rule(mode='any_change')
        await self.engine.weather('test-rule', 0, self.forecast())
        for count, condition in enumerate(['lightning', 'lightning-rainy', 'snowy', 'hail', 'windy', 'fog', 'exceptional', 'sunny'], 1):
            # Keep forecast timestamps fixed while moving the clock beyond the cooldown.
            forecast = [{'datetime': iso(1792152000 + 3600), 'condition': condition, 'precipitation_probability': 0}]
            await self.advance(60)
            await self.engine.weather('test-rule', 0, forecast)
            self.assertEqual(len(self.events), count)

    async def test_general_alert_detects_temperature_and_wind_changes_without_rain(self):
        await self.weather_rule(mode='any_change')
        forecast = self.forecast(temperature=20, wind_speed=5)
        await self.engine.weather('test-rule', 0, forecast)
        forecast[0]['temperature'] = 30
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(len(self.events), 1)
        await self.advance(60)
        forecast[0]['wind_speed'] = 50
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(len(self.events), 2)
        await self.advance(60)
        await self.engine.weather('test-rule', 0, deepcopy(forecast))
        self.assertEqual(len(self.events), 2)

    async def test_storm_filter_ignores_rain_probability_and_unrelated_conditions(self):
        await self.weather_rule(mode='conditions', conditions=['lightning', 'lightning-rainy'])
        forecast = self.forecast('sunny')
        await self.engine.weather('test-rule', 0, forecast)
        forecast[0]['condition'] = 'snowy'
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(self.events, [])
        forecast[0]['condition'] = 'lightning'
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(len(self.events), 1)
        await self.advance(60)
        forecast[0]['condition'] = 'lightning-rainy'
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(len(self.events), 2)

    async def test_general_forecast_ignores_changes_outside_horizon_and_dictionary_order(self):
        await self.weather_rule(mode='any_change')
        forecast = self.forecast(temperature=20) + [{'datetime': iso(self.now + 3 * 86400), 'condition': 'sunny'}]
        await self.engine.weather('test-rule', 0, forecast)
        forecast[1]['condition'] = 'lightning'
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(self.events, [])
        reordered = [{key: period[key] for key in reversed(period)} for period in forecast]
        await self.engine.weather('test-rule', 0, reordered)
        self.assertEqual(self.events, [])

    async def test_legacy_rain_alert_is_not_silently_broadened_to_storm_only(self):
        await self.weather_rule()
        forecast = self.forecast()
        await self.engine.weather('test-rule', 0, forecast)
        forecast[0]['condition'] = 'lightning'
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(self.events, [])

    async def test_weather_sleep_gate_updates_baseline_without_wake_replay_or_consuming_cooldown(self):
        await self.weather_rule(mode='any_change', sleep_entity='input_boolean.dormir')
        self.states['input_boolean.dormir'] = 'off'
        forecast = self.forecast()
        await self.engine.weather('test-rule', 0, forecast)
        self.states['input_boolean.dormir'] = 'on'
        forecast[0]['condition'] = 'lightning'
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(self.events, [])
        self.assertIsNone(self.saved['test-rule']['last_fired'])
        self.states['input_boolean.dormir'] = 'off'
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(self.events, [])
        forecast[0]['condition'] = 'snowy'
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(len(self.events), 1)

    async def test_unknown_sleep_state_fails_closed(self):
        await self.weather_rule(mode='any_change', sleep_entity='input_boolean.dormir')
        forecast = self.forecast()
        await self.engine.weather('test-rule', 0, forecast)
        for state in [None, 'unknown', 'unavailable']:
            self.states['input_boolean.dormir'] = state
            forecast[0]['temperature'] = len(forecast[0])
            await self.engine.weather('test-rule', 0, forecast)
            self.assertTrue(self.engine.muted(self.saved['test-rule']))
        self.assertEqual(self.events, [])

    async def test_weather_cooldown_is_thirty_minutes(self):
        value = self.value(kind='alert', next_at=None, recurring=True, cooldown_seconds=1800, condition={'source': 'weather', 'entity_id': 'weather.home', 'horizon_hours': 24, 'minimum_probability': 30, 'mode': 'any_change'})
        await self.engine.put('owner', value)
        forecast = self.forecast()
        await self.engine.weather('test-rule', 0, forecast)
        forecast[0]['condition'] = 'lightning'
        await self.engine.weather('test-rule', 0, forecast)
        await self.advance(1799)
        forecast[0]['condition'] = 'snowy'
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(len(self.events), 1)
        await self.advance(1)
        forecast[0]['condition'] = 'hail'
        await self.engine.weather('test-rule', 0, forecast)
        self.assertEqual(len(self.events), 2)
