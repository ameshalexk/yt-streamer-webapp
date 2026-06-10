"""The YT Streamer integration."""
from __future__ import annotations
import logging
import os

from homeassistant.config_entries import ConfigEntry
from homeassistant.components import frontend
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN
from .coordinator import YTStreamerCoordinator
from .views import (
    YTStreamerFrontendView,
    YTStreamerApiView,
    YTStreamerMediaView,
)

_LOGGER = logging.getLogger(__name__)

### CHANGE THIS LINE ###
PLATFORMS = []
# PLATFORMS = ["camera"] # This was causing the startup error

async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the YT Streamer component."""
    hass.data[DOMAIN] = {}
    return True

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up YT Streamer from a config entry."""
    coordinator = YTStreamerCoordinator(hass, entry)
    hass.data[DOMAIN][entry.entry_id] = coordinator

    frontend.async_register_built_in_panel(
        hass,
        component_name="iframe",
        sidebar_title="YT Streamer",
        sidebar_icon="mdi:youtube-tv",
        frontend_url_path="yt_streamer",
        config={"url": "/api/yt_streamer/frontend"},
        require_admin=False,
    )

    # Register the API views
    hass.http.register_view(YTStreamerFrontendView(entry))
    hass.http.register_view(YTStreamerApiView(coordinator))
    hass.http.register_view(YTStreamerMediaView(coordinator))

    # Load platforms
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # --- Register Services ---
    async def handle_download_url(call: ServiceCall):
        url = call.data.get("url")
        if url:
            await coordinator.api_submit_url(url)

    async def handle_play_saved(call: ServiceCall):
        video_id = call.data.get("video_id")
        if video_id:
            await coordinator.api_play_saved_video(video_id)

    async def handle_delete_saved(call: ServiceCall):
        video_id = call.data.get("video_id")
        if video_id:
            await coordinator.api_delete_saved_video(video_id)

    async def handle_stop_playback(call: ServiceCall):
        await coordinator.api_stop_playback()

    hass.services.async_register(DOMAIN, "download_url", handle_download_url)
    hass.services.async_register(DOMAIN, "play_saved", handle_play_saved)
    hass.services.async_register(DOMAIN, "delete_saved", handle_delete_saved)
    hass.services.async_register(DOMAIN, "stop_playback", handle_stop_playback)

    return True

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

    if unload_ok:
        hass.services.async_remove(DOMAIN, "download_url")
        hass.services.async_remove(DOMAIN, "play_saved")
        hass.services.async_remove(DOMAIN, "delete_saved")
        hass.services.async_remove(DOMAIN, "stop_playback")
        frontend.async_remove_panel(hass, "yt_streamer")
        hass.data[DOMAIN].pop(entry.entry_id)

    return unload_ok