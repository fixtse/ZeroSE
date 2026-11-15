"""Config flow: paste the MyFitnessPal session cookie; options for goal and sync schedule."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_DAILY_GOAL, CONF_HISTORY_START, CONF_SESSION_TOKEN, CONF_SYNC_TIME, DEFAULT_HISTORY_START,
    DEFAULT_SYNC_TIME, DOMAIN,
)
from .mfp import AuthError, MyFitnessPal

TOKEN = selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD))


async def _check(token: str) -> str | None:
    """Return an error key, or None when the cookie works."""
    try:
        async with MyFitnessPal(token):
            return None
    except AuthError:
        return "invalid_auth"
    except Exception:  # network, Cloudflare, site changes
        return "cannot_connect"


class CalorieTrackerConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            token = user_input.get(CONF_SESSION_TOKEN, "").strip()
            if token and (error := await _check(token)):
                errors["base"] = error
            else:
                return self.async_create_entry(title="Calorie Tracker", data={CONF_SESSION_TOKEN: token})
        return self.async_show_form(
            step_id="user", data_schema=vol.Schema({vol.Optional(CONF_SESSION_TOKEN): TOKEN}), errors=errors)

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            token = user_input[CONF_SESSION_TOKEN].strip()
            if not (error := await _check(token)):
                entry = self._get_reauth_entry()
                return self.async_update_reload_and_abort(entry, data={**entry.data, CONF_SESSION_TOKEN: token})
            errors["base"] = error
        return self.async_show_form(
            step_id="reauth_confirm", data_schema=vol.Schema({vol.Required(CONF_SESSION_TOKEN): TOKEN}),
            errors=errors)

    async def async_step_reconfigure(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            token = user_input[CONF_SESSION_TOKEN].strip()
            if not (error := await _check(token)):
                entry = self._get_reconfigure_entry()
                return self.async_update_reload_and_abort(entry, data={**entry.data, CONF_SESSION_TOKEN: token})
            errors["base"] = error
        return self.async_show_form(
            step_id="reconfigure", data_schema=vol.Schema({vol.Required(CONF_SESSION_TOKEN): TOKEN}),
            errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return CalorieTrackerOptionsFlow()


class CalorieTrackerOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            if user_input.get(CONF_SYNC_TIME):
                user_input[CONF_SYNC_TIME] = user_input[CONF_SYNC_TIME][:5]
            return self.async_create_entry(data=user_input)
        options = self.config_entry.options
        return self.async_show_form(step_id="init", data_schema=vol.Schema({
            vol.Optional(CONF_DAILY_GOAL, default=options.get(CONF_DAILY_GOAL, 0)): vol.All(
                vol.Coerce(int), vol.Range(min=0, max=10000)),
            vol.Optional(CONF_SYNC_TIME, default=options.get(CONF_SYNC_TIME, DEFAULT_SYNC_TIME)):
                selector.TimeSelector(),
            vol.Optional(CONF_HISTORY_START, default=options.get(CONF_HISTORY_START, DEFAULT_HISTORY_START)):
                selector.DateSelector(),
        }))
