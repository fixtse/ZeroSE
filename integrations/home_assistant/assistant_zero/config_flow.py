"""Single private YAML-configured bridge; credentials never appear in flow output."""
from homeassistant import config_entries
from . import DOMAIN


class ZeroConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_import(self, data):
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured(updates=data)
        return self.async_create_entry(title="Zero", data=data)
