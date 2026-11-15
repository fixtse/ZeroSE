"""Calorie Tracker: food catalog and diary in Home Assistant, synced from MyFitnessPal."""

from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timedelta
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    CONF_DAILY_GOAL, CONF_HISTORY_START, CONF_SESSION_TOKEN, CONF_SYNC_TIME, DEFAULT_HISTORY_START,
    DEFAULT_SYNC_TIME, DOMAIN, OVERLAP_DAYS, SIGNAL_UPDATED, STORAGE_VERSION,
)
from .core import KINDS, Catalog, meal_key
from .mfp import AuthError, MyFitnessPal, sync_catalog

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.SENSOR, Platform.BUTTON]
NUMBER = vol.All(vol.Coerce(float), vol.Range(min=0, max=100000))
DAY = cv.matches_regex(r"^\d{4}-\d{2}-\d{2}$")
MEAL = vol.All(cv.string, vol.Length(min=1, max=30))


class Tracker:
    """Runtime state for the single config entry."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.store: Store = Store(hass, STORAGE_VERSION, f"{DOMAIN}.data")
        self.catalog = Catalog()
        self.lock = asyncio.Lock()
        self.sync_task: asyncio.Task | None = None
        self.status: dict[str, Any] = {"state": "idle"}

    async def load(self) -> None:
        self.catalog = Catalog.load(await self.store.async_load())
        self.status = self.catalog.sync.get("status", {"state": "idle"})
        if self.status.get("state") == "running":  # interrupted by a restart
            self.status = {**self.status, "state": "interrupted"}

    async def save(self) -> None:
        self.catalog.sync["status"] = self.status
        await self.store.async_save(self.catalog.dump())
        async_dispatcher_send(self.hass, SIGNAL_UPDATED)

    def today(self) -> str:
        return dt_util.now().date().isoformat()

    # ---- MyFitnessPal sync ---------------------------------------------------------------
    def start_sync(self, since: date | None = None) -> asyncio.Task:
        if self.sync_task and not self.sync_task.done():
            return self.sync_task
        self.sync_task = self.entry.async_create_background_task(
            self.hass, self._sync(since), f"{DOMAIN}_sync")
        # Failures are reported through the status sensor; avoid "exception never retrieved".
        self.sync_task.add_done_callback(lambda task: task.cancelled() or task.exception())
        return self.sync_task

    async def _sync(self, since: date | None) -> dict[str, Any]:
        token = self.entry.data.get(CONF_SESSION_TOKEN, "")
        if not token:
            raise HomeAssistantError("Add your MyFitnessPal session cookie in the integration options")
        today = dt_util.now().date()
        scanned = self.catalog.sync.get("diary_scanned_through")
        if since:
            start = since
        elif scanned:
            start = date.fromisoformat(scanned) - timedelta(days=OVERLAP_DAYS)
        else:
            start = date.fromisoformat(self.entry.options.get(CONF_HISTORY_START, DEFAULT_HISTORY_START))
        self.status = {"state": "running", "started": dt_util.utcnow().isoformat(), "range": f"{start}..{today}"}
        await self.save()

        async def progress(message: str) -> None:
            self.status = {**self.status, "progress": message}
            await self.save()  # keeps the scan position if Home Assistant restarts

        try:
            async with MyFitnessPal(token) as client:
                try:
                    result = await sync_catalog(client, self.catalog, start, today, progress)
                finally:
                    self._remember_token(client.session_token)
        except AuthError as error:
            self.status = {"state": "auth_failed", "error": str(error), "at": dt_util.utcnow().isoformat()}
            await self.save()
            self.entry.async_start_reauth(self.hass)
            raise HomeAssistantError("MyFitnessPal session expired; update the cookie in Home Assistant") from error
        except Exception as error:
            _LOGGER.exception("MyFitnessPal sync failed")
            self.status = {"state": "error", "error": str(error)[:300], "at": dt_util.utcnow().isoformat()}
            await self.save()
            raise HomeAssistantError(f"MyFitnessPal sync failed: {error}") from error
        self.status = {"state": "ok", "at": dt_util.utcnow().isoformat(), "range": f"{start}..{today}",
                       "result": {k: v for k, v in result.items() if k != "new_food_names"}}
        await self.save()
        return result

    @callback
    def _remember_token(self, token: str) -> None:
        if token and token != self.entry.data.get(CONF_SESSION_TOKEN):
            self.hass.config_entries.async_update_entry(
                self.entry, data={**self.entry.data, CONF_SESSION_TOKEN: token})


def _tracker(hass: HomeAssistant) -> Tracker:
    entries = hass.config_entries.async_loaded_entries(DOMAIN)
    if not entries:
        raise ServiceValidationError("Calorie Tracker is not set up")
    return entries[0].runtime_data


def _message(error: Exception) -> str:
    return str(error).strip("'\"")


def _fail(call: ServiceCall, error: Exception) -> ServiceResponse:
    """Correctable errors go back in the response so API clients (Zero) can read and fix them."""
    if call.return_response:
        return {"error": _message(error)}
    raise ServiceValidationError(_message(error)) from error


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    async def search(call: ServiceCall) -> ServiceResponse:
        t = _tracker(hass)
        return t.catalog.search(call.data.get("query", ""), call.data.get("kind"),
                                call.data["offset"], call.data["limit"])

    async def get_food(call: ServiceCall) -> ServiceResponse:
        try:
            return _tracker(hass).catalog.food(call.data["food_id"])
        except KeyError as error:
            return _fail(call, error)

    async def recommend(call: ServiceCall) -> ServiceResponse:
        targets = {k: call.data[k] for k in ("calories", "protein", "carbohydrates", "fat") if k in call.data}
        try:
            return _tracker(hass).catalog.recommend(
                targets, call.data.get("kind"), call.data.get("query", ""), call.data["limit"])
        except ValueError as error:
            return _fail(call, error)

    async def log_food(call: ServiceCall) -> ServiceResponse:
        t = _tracker(hass)
        eaten = dt_util.as_local(call.data.get("eaten_at") or dt_util.now())
        values = {k: call.data[k] for k in ("calories", "protein", "carbohydrates", "fat", "fiber", "sugar", "sodium")
                  if k in call.data}
        async with t.lock:
            try:
                entry = t.catalog.log(
                    day=eaten.date().isoformat(), eaten_at=eaten, meal=call.data["meal"],
                    food_id=call.data.get("food_id"), name=call.data.get("name"), values=values or None,
                    servings=call.data.get("servings"), quantity=call.data.get("quantity"),
                    unit=call.data.get("unit"))
            except (KeyError, ValueError) as error:
                return _fail(call, error)
            await t.save()
        return {"entry": entry, "day_totals": t.catalog.day(entry["day"])["totals"]}

    async def delete_entries(call: ServiceCall) -> ServiceResponse:
        t = _tracker(hass)
        async with t.lock:
            try:
                deleted = t.catalog.delete(call.data["entry_ids"])
            except KeyError as error:
                return _fail(call, error)
            await t.save()
        return {"deleted": deleted}

    async def get_diary(call: ServiceCall) -> ServiceResponse:
        t = _tracker(hass)
        start = call.data.get("start") or t.today()
        end = call.data.get("end")
        if not end or end == start:
            return t.catalog.day(start)
        if end < start or (date.fromisoformat(end) - date.fromisoformat(start)).days > 366:
            raise ServiceValidationError("end must be after start and within 366 days")
        return t.catalog.range(start, end)

    async def save_food(call: ServiceCall) -> ServiceResponse:
        t = _tracker(hass)
        values = {k: call.data[k] for k in ("calories", "protein", "carbohydrates", "fat", "fiber", "sugar", "sodium")
                  if k in call.data}
        async with t.lock:
            food = t.catalog.save_manual(call.data["name"], call.data.get("brand", ""),
                                         call.data["serving_amount"], call.data["serving_unit"], values)
            await t.save()
        return {"food": t.catalog.brief(food)}

    async def sync(call: ServiceCall) -> ServiceResponse:
        t = _tracker(hass)
        since = date.fromisoformat(call.data["since"]) if call.data.get("since") else None
        task = t.start_sync(since)
        if not call.return_response:
            return None
        return await task

    targets = {vol.Optional(k): NUMBER for k in ("calories", "protein", "carbohydrates", "fat")}
    nutrients = {**targets, **{vol.Optional(k): NUMBER for k in ("fiber", "sugar", "sodium")}}
    kind = {vol.Optional("kind"): vol.In(KINDS)}
    register = hass.services.async_register
    register(DOMAIN, "search_foods", search, vol.Schema({
        vol.Optional("query", default=""): cv.string, **kind,
        vol.Optional("offset", default=0): vol.All(int, vol.Range(min=0)),
        vol.Optional("limit", default=10): vol.All(int, vol.Range(min=1, max=50)),
    }), supports_response=SupportsResponse.ONLY)
    register(DOMAIN, "get_food", get_food, vol.Schema({vol.Required("food_id"): cv.string}),
             supports_response=SupportsResponse.ONLY)
    register(DOMAIN, "recommend_foods", recommend, vol.Schema({
        **targets, **kind, vol.Optional("query", default=""): cv.string,
        vol.Optional("limit", default=5): vol.All(int, vol.Range(min=1, max=20)),
    }), supports_response=SupportsResponse.ONLY)
    register(DOMAIN, "log_food", log_food, vol.Schema({
        vol.Required("meal"): MEAL, vol.Optional("food_id"): cv.string,
        vol.Optional("name"): vol.All(cv.string, vol.Length(min=1, max=200)), **nutrients,
        vol.Optional("servings"): vol.All(vol.Coerce(float), vol.Range(min=0.01, max=100)),
        vol.Optional("quantity"): vol.All(vol.Coerce(float), vol.Range(min=0.01, max=100000)),
        vol.Optional("unit"): vol.All(cv.string, vol.Length(max=50)),
        vol.Optional("eaten_at"): cv.datetime,
    }), supports_response=SupportsResponse.OPTIONAL)
    register(DOMAIN, "delete_entries", delete_entries, vol.Schema({
        vol.Required("entry_ids"): vol.All(cv.ensure_list, [cv.string], vol.Length(min=1, max=50)),
    }), supports_response=SupportsResponse.OPTIONAL)
    register(DOMAIN, "get_diary", get_diary, vol.Schema({
        vol.Optional("start"): DAY, vol.Optional("end"): DAY,
    }), supports_response=SupportsResponse.ONLY)
    register(DOMAIN, "save_food", save_food, vol.Schema({
        vol.Required("name"): vol.All(cv.string, vol.Length(min=1, max=200)),
        vol.Optional("brand", default=""): cv.string,
        vol.Optional("serving_amount", default=1): vol.All(vol.Coerce(float), vol.Range(min=0.001)),
        vol.Optional("serving_unit", default="serving"): vol.All(cv.string, vol.Length(min=1, max=50)),
        vol.Required("calories"): NUMBER, **{k: v for k, v in nutrients.items() if str(k) != "calories"},
    }), supports_response=SupportsResponse.OPTIONAL)
    register(DOMAIN, "sync_myfitnesspal", sync, vol.Schema({vol.Optional("since"): DAY}),
             supports_response=SupportsResponse.OPTIONAL)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    tracker = Tracker(hass, entry)
    await tracker.load()
    entry.runtime_data = tracker
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    hour, minute = (int(x) for x in entry.options.get(CONF_SYNC_TIME, DEFAULT_SYNC_TIME).split(":"))

    @callback
    def daily_sync(now: datetime) -> None:
        if entry.data.get(CONF_SESSION_TOKEN) and tracker.status.get("state") != "auth_failed":
            tracker.start_sync()

    @callback
    def midnight(now: datetime) -> None:
        async_dispatcher_send(hass, SIGNAL_UPDATED)

    entry.async_on_unload(async_track_time_change(hass, daily_sync, hour=hour, minute=minute, second=0))
    entry.async_on_unload(async_track_time_change(hass, midnight, hour=0, minute=0, second=5))
    entry.async_on_unload(entry.add_update_listener(_options_changed))
    tracker.options_snapshot = dict(entry.options)
    return True


async def _options_changed(hass: HomeAssistant, entry: ConfigEntry) -> None:
    # Token rotation updates entry data; only reload when the user changed options.
    if dict(entry.options) != getattr(entry.runtime_data, "options_snapshot", None):
        await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    task = entry.runtime_data.sync_task
    if task and not task.done():
        task.cancel()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
