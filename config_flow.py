"""Config flow for YT Streamer."""
import voluptuous as vol

from homeassistant.config_entries import ConfigFlow
from homeassistant.const import CONF_NAME
from homeassistant.data_entry_flow import FlowResult

from .const import DOMAIN

class YTStreamerConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for YT Streamer."""

    VERSION = 1

    async def async_step_user(self, user_input=None) -> FlowResult:
        """Handle the initial step."""
        # Ensure only one instance of the integration can be configured.
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            # Here you could process user_input if you had configuration options.
            # For now, we just create the entry.
            return self.async_create_entry(title="YT Streamer", data=user_input)

        # Show a simple form to the user to confirm adding the integration.
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({}), # No fields needed for now
            description_placeholders={
                "docs_url": "https://www.home-assistant.io" # Replace with your docs
            }
        )