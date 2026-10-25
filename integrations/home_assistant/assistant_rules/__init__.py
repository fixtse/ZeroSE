"""Compatibility entry point; Zero Assistant now owns scheduling."""
from custom_components.assistant_zero.rules import CONFIG_SCHEMA, DOMAIN, async_setup_rules


async def async_setup(hass, config):
    if DOMAIN in config:
        await async_setup_rules(hass, config[DOMAIN])
    return True


async def async_setup_entry(hass, entry):
    await async_setup_rules(hass, entry.data)
    return True
