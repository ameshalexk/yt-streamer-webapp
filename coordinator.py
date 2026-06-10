# """Data and state coordinator for YT Streamer."""
import asyncio
import logging
import os
import shutil
import time
import uuid
import json
import re
import subprocess
from typing import Any, AsyncGenerator

import yt_dlp

from homeassistant.core import HomeAssistant
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.components.ffmpeg import get_ffmpeg_manager

from .const import (
    DOMAIN,
    SAVED_MEDIA_DIR_NAME,
    MJPEG_QUALITY,
    MJPEG_STREAM_WIDTH,
    MJPEG_STREAM_HEIGHT,
    MAX_STREAM_FPS,
    SUPPORTED_RESOLUTIONS,
    MIN_STREAM_FPS
)

_LOGGER = logging.getLogger(__name__)

# --- Centralized Resolution Management ---
# Defines download priority (first is highest) and available versions.


class YTStreamerCoordinator(DataUpdateCoordinator):
    """Manages the state and operations for YT Streamer."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry):
        """Initialize the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=None,
        )
        self.entry = entry
        self.hass = hass
        self._saved_media_path = hass.config.path(SAVED_MEDIA_DIR_NAME)
        self._temp_dir = hass.config.path("temp", DOMAIN)
        self._tasks = {}
        # Default to the lowest supported resolution for playback start
        self._now_playing = {"type": None, "id": None, "title": "Idle", "resolution": SUPPORTED_RESOLUTIONS[-1]}
        self._mjpeg_quality = MJPEG_QUALITY  # Store the current quality setting
        self._stream_fps = 24  # Store the current FPS setting, default to 24 FPS for smooth playback
        self._m3u8_mjpeg_quality = MJPEG_QUALITY  # Dedicated quality setting for M3U8/go2rtc streams
        self._m3u8_stream_fps = 24  # Dedicated FPS setting for M3U8/go2rtc streams
        self.ffmpeg = get_ffmpeg_manager(hass)
        self._go2rtc_stream_urls = {}  # Cache for go2rtc stream_name -> original_url mapping

        os.makedirs(self._saved_media_path, exist_ok=True)
        os.makedirs(self._temp_dir, exist_ok=True)

        # --- Playlists persistence ---
        # Store playlists JSON alongside saved media so it's backed up with library
        self._playlists_file_path = os.path.join(self._saved_media_path, "playlists.json")
        
        # --- M3U8 Saved Streams persistence ---
        # Store saved streams JSON alongside saved media so it's backed up with library
        self._saved_streams_file_path = os.path.join(self._saved_media_path, "saved_streams.json")

    # --- Helper Methods for Clarity and Reuse ---

    def _get_video_path(self, stream_type: str, item_id: str, resolution: int) -> str | None:
        """Constructs the path to a video file for a given resolution."""
        filename = f"video_{resolution}.mp4"
        if stream_type == "session":
            task = self.get_task_status(item_id)
            if task and task.get("status") == "ready":
                return task.get("video_paths", {}).get(str(resolution)) # Ensure key is string if needed
        elif stream_type == "saved":
            path = os.path.join(self._saved_media_path, item_id, filename)
            if os.path.exists(path):
                return path
        _LOGGER.warning(f"Could not find video path for {stream_type}/{item_id} at {resolution}p")
        return None

    def _get_validated_resolution(self, requested_res: int, available_res: list[int]) -> int:
        """Checks if a resolution is available, returning a valid fallback if not."""
        if not available_res:
            # Fallback if the list is somehow empty
            return SUPPORTED_RESOLUTIONS[-1]
        if requested_res not in available_res:
            # Default to the highest available resolution if the request is invalid
            new_res = available_res[0]
            _LOGGER.warning(f"Resolution {requested_res}p not available. Defaulting to {new_res}p.")
            return new_res
        return requested_res

    # --- API and State Management ---

    def is_streaming(self) -> bool:
        """Checks if an FFmpeg MJPEG process is currently active."""
        active_process = getattr(self, "_current_mjpeg_process", None)
        return active_process is not None and active_process.returncode is None

    def get_stream_url(self) -> str | None:
        """Get the full stream URL including the active resolution."""
        if self._now_playing["type"] and self._now_playing["id"]:
            resolution = self._now_playing.get("resolution", SUPPORTED_RESOLUTIONS[-1])
            return f"/api/yt_streamer/stream/{self._now_playing['type']}/{self._now_playing['id']}/{resolution}"
        return None

    def get_now_playing_title(self) -> str:
        """Returns the title of the currently playing media."""
        return self._now_playing["title"]

    def get_task_status(self, session_id: str) -> dict:
        """Returns the status of a download task."""
        return self._tasks.get(session_id, {"status": "error", "message": "Invalid session ID."})

    def get_audio_path(self, stream_type: str, item_id: str) -> str | None:
        """Gets the filesystem path for an audio file."""
        if stream_type == "session":
            task = self.get_task_status(item_id)
            if task and task.get("status") == "ready":
                return task.get("audio_path")
        elif stream_type == "saved":
            path = os.path.join(self._saved_media_path, item_id, "audio.mp3")
            if os.path.exists(path):
                return path
        return None

    async def api_submit_url(self, url: str, resolutions: list = None, playlist_id: str | None = None) -> dict:
        """Initializes a new download task from a YouTube URL."""
        _LOGGER.info(f"api_submit_url called. URL: {url}, Received resolutions from frontend: {resolutions}")
        _LOGGER.info(f"Backend SUPPORTED_RESOLUTIONS for validation: {SUPPORTED_RESOLUTIONS}")

        if not resolutions:
            _LOGGER.error("No resolutions provided. Aborting download.")
            raise ValueError("No resolutions provided. Please select at least one resolution.")

        # Validate and sort resolutions.
        validated_resolutions = sorted([r for r in resolutions if r in SUPPORTED_RESOLUTIONS], reverse=True)
        _LOGGER.info(f"Validated resolutions (after filtering with backend list): {validated_resolutions}")
        
        if not validated_resolutions:
            _LOGGER.error("No valid resolutions provided after validation.")
            raise ValueError("No valid resolutions provided. Please select at least one supported resolution.")

        session_id = str(uuid.uuid4())
        session_dir = os.path.join(self._temp_dir, session_id)
        os.makedirs(session_dir, exist_ok=True)

        self._tasks[session_id] = {
            "status": "pending", "message": "Download initiated.", "progress": 0,
            "video_paths": {str(res): os.path.join(session_dir, f"video_{res}.mp4") for res in validated_resolutions},
            "audio_path": os.path.join(session_dir, "audio.mp3"),
            "fps": 24.0,
            "session_dir": session_dir, "original_title": "Unknown Title", "youtube_id": None,
            "resolutions": validated_resolutions,
            "playlist_id": playlist_id
        }
        _LOGGER.info(f"Session {session_id}: Task initialized for URL: {url} with resolutions: {validated_resolutions}")
        self.hass.async_create_task(self._download_and_process(url, session_id))
        return {"session_id": session_id, "message": "Download process started."}

    async def api_get_video_formats(self, url: str) -> dict:
        """Fetches available formats for a video URL."""
        try:
            formats = await self.hass.async_add_executor_job(self._get_video_formats_sync, url)
            return {
                "success": True,
                "formats": formats,
                "title": formats.get("title", "Unknown Title")
            }
        except Exception as e:
            _LOGGER.error(f"Error fetching video formats: {e}")
            return {
                "success": False,
                "message": str(e)
            }

    def _get_video_formats_sync(self, url: str) -> dict:
        """Synchronously fetches available formats for a video."""
        _LOGGER.info(f"Fetching formats for URL: {url}")
        try:
            ydl_opts = {
                'quiet': True,
                'noplaylist': True,
                'skip_download': True,
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                
                # Get available video formats
                available_formats = []
                for f in info.get('formats', []):
                    if f.get('vcodec', 'none') != 'none' and f.get('height'):
                        available_formats.append({
                            'height': f.get('height'),
                            'format_id': f.get('format_id'),
                            'ext': f.get('ext'),
                            'filesize': f.get('filesize'),
                            'fps': f.get('fps')
                        })

                # Sort by height and remove duplicates
                available_formats.sort(key=lambda x: x['height'], reverse=True)
                unique_heights = []
                seen_heights = set()
                for f in available_formats:
                    if f['height'] not in seen_heights:
                        seen_heights.add(f['height'])
                        unique_heights.append(f['height'])

                return {
                    'title': info.get('title', 'Unknown Title'),
                    'available_resolutions': unique_heights,
                    'formats': available_formats
                }

        except Exception as e:
            _LOGGER.error(f"Error in _get_video_formats_sync: {e}")
            raise

    async def api_list_saved_videos(self) -> list:
        """Returns a list of all videos in the media library."""
        return await self.hass.async_add_executor_job(self._list_saved_videos_sync)

    # --- Playlists API ---
    async def api_list_playlists(self) -> list:
        return await self.hass.async_add_executor_job(self._load_playlists_sync)

    async def api_add_playlist(self, name: str, url: str) -> dict:
        if not url:
            raise ValueError("Playlist URL is required")
        playlists = await self.hass.async_add_executor_job(self._load_playlists_sync)
        playlist_id = str(uuid.uuid4())
        playlist = {"id": playlist_id, "name": name or "Untitled", "url": url}
        playlists.append(playlist)
        await self.hass.async_add_executor_job(self._save_playlists_sync, playlists)
        return playlist

    async def api_update_playlist(self, playlist_id: str, name: str, url: str) -> dict:
        if not playlist_id:
            raise ValueError("Playlist id is required")
        playlists = await self.hass.async_add_executor_job(self._load_playlists_sync)
        updated = None
        for pl in playlists:
            if pl.get("id") == playlist_id:
                if name is not None:
                    pl["name"] = name
                if url is not None:
                    pl["url"] = url
                updated = pl
                break
        if updated is None:
            raise ValueError("Playlist not found")
        await self.hass.async_add_executor_job(self._save_playlists_sync, playlists)
        return updated

    async def api_delete_playlist(self, playlist_id: str) -> dict:
        if not playlist_id:
            raise ValueError("Playlist id is required")
        playlists = await self.hass.async_add_executor_job(self._load_playlists_sync)
        new_list = [pl for pl in playlists if pl.get("id") != playlist_id]
        deleted = len(new_list) != len(playlists)
        await self.hass.async_add_executor_job(self._save_playlists_sync, new_list)
        return {"success": deleted}

    # --- NEW ---
    async def api_get_playlist_info(self, playlist_url: str) -> list:
        """Fetches video information from a playlist URL."""
        if not playlist_url:
            _LOGGER.warning("api_get_playlist_info called without a URL.")
            return []
        return await self.hass.async_add_executor_job(
            self._get_playlist_info_sync, playlist_url
        )

    def _get_playlist_info_sync(self, playlist_url: str) -> list:
        """Synchronous worker to fetch playlist info using yt-dlp."""
        _LOGGER.info(f"Fetching playlist info for: {playlist_url}")
        try:
            ydl_opts = {
                # Keep extraction lightweight but still use YouTube's playlist extractor,
                # which handles pagination correctly.
                'extract_flat': 'in_playlist',
                'ignoreerrors': True,
                'skip_download': True,
                'quiet': True,
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                playlist_dict = ydl.extract_info(playlist_url, download=False)

            videos = []
            if 'entries' in playlist_dict:
                for video in playlist_dict.get('entries', []):
                    # Some entries in a playlist can be None (e.g., deleted videos)
                    if not video:
                        continue
                    title = video.get('title')
                    if not title:
                        continue
                    video_url = (
                        video.get('webpage_url')
                        or video.get('url')
                        or (f"https://www.youtube.com/watch?v={video.get('id')}" if video.get('id') else None)
                    )
                    if video_url and not str(video_url).startswith("http") and video.get('id'):
                        video_url = f"https://www.youtube.com/watch?v={video.get('id')}"
                    if title and video_url:
                        videos.append({
                            "title": title,
                            "url": video_url
                        })
            _LOGGER.info(f"Found {len(videos)} videos in playlist.")
            return videos

        except Exception as e:
            _LOGGER.error(f"Error fetching playlist info for {playlist_url}: {e}", exc_info=True)
            return []
    # --- END NEW ---

    # --- NEW: Playlist title ---
    async def api_get_playlist_title(self, playlist_url: str) -> str:
        if not playlist_url:
            return "Untitled"
        return await self.hass.async_add_executor_job(self._get_playlist_title_sync, playlist_url)

    def _get_playlist_title_sync(self, playlist_url: str) -> str:
        try:
            ydl_opts = {
                'extract_flat': 'in_playlist',
                'ignoreerrors': True,
                'skip_download': True,
                'quiet': True,
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(playlist_url, download=False)
                title = info.get('title') or "Untitled"
                return title
        except Exception as e:
            _LOGGER.error(f"Failed to get playlist title for {playlist_url}: {e}")
            return "Untitled"

    async def api_play_saved_video(self, video_id: str, resolution: int = SUPPORTED_RESOLUTIONS[-1]):
        """Sets coordinator state to play a video from the library."""
        video_info = await self.hass.async_add_executor_job(self._get_saved_video_info, video_id)
        if not video_info:
            _LOGGER.error(f"Could not find info for saved video: {video_id}")
            return

        valid_resolution = self._get_validated_resolution(resolution, video_info.get("resolutions", []))
        await self.api_stop_playback()
        self._now_playing = {"type": "saved", "id": video_id, "title": video_info["title"], "resolution": valid_resolution}
        self.async_update_listeners()
        _LOGGER.info(f"Coordinator state set to play saved video: {video_id} at {valid_resolution}p")

    async def api_play_session_video(self, session_id: str, resolution: int = SUPPORTED_RESOLUTIONS[-1]):
        """Sets coordinator state to play a freshly downloaded video."""
        task = self.get_task_status(session_id)
        if task.get("status") != "ready":
            _LOGGER.error(f"Session video not ready for playback: {session_id}")
            return

        valid_resolution = self._get_validated_resolution(resolution, task.get("resolutions", []))
        await self.api_stop_playback()
        self._now_playing = {"type": "session", "id": session_id, "title": task.get("original_title"), "resolution": valid_resolution}
        self.async_update_listeners()
        _LOGGER.info(f"Coordinator state set to play session video: {session_id} at {valid_resolution}p")

    async def api_switch_resolution(self, item_type: str, item_id: str, resolution: int):
        """Switches the resolution of the currently playing video."""
        if not self._now_playing.get("id"):
            _LOGGER.warning("Cannot switch resolution, nothing is playing.")
            return

        _LOGGER.info(f"Switching resolution for {item_type} '{item_id}' to {resolution}p")

        # Update the resolution for the currently playing item
        self._now_playing["resolution"] = resolution
        self.async_update_listeners()

        if item_type == "saved":
            await self.api_play_saved_video(item_id, resolution)
        elif item_type == "session":
            await self.api_play_session_video(item_id, resolution)


    async def api_delete_saved_video(self, video_id: str) -> dict:
        """Deletes a video from the media library."""
        if self._now_playing["type"] == "saved" and self._now_playing["id"] == video_id:
            await self.api_stop_playback()
        return await self.hass.async_add_executor_job(self._delete_saved_video_sync, video_id)

    async def api_delete_all_saved_videos(self) -> dict:
        """Deletes all videos from the media library."""
        if self._now_playing["type"] == "saved":
            await self.api_stop_playback()
        return await self.hass.async_add_executor_job(self._delete_all_saved_videos_sync)

    async def api_delete_saved_videos_by_filter(self, filter_value: str) -> dict:
        """Deletes saved videos matching a playlist filter."""
        if self._now_playing["type"] == "saved":
            await self.api_stop_playback()
        return await self.hass.async_add_executor_job(self._delete_saved_videos_by_filter_sync, filter_value)

    def _delete_all_saved_videos_sync(self) -> dict:
        """Synchronously deletes all video directories from the media library.

        Only subdirectories (individual video entries) are removed.
        playlists.json and saved_streams.json in the library root are preserved.
        """
        try:
            if not os.path.exists(self._saved_media_path):
                return {"success": False, "message": "Media library directory not found."}

            deleted = 0
            for item_name in os.listdir(self._saved_media_path):
                item_dir = os.path.join(self._saved_media_path, item_name)
                if os.path.isdir(item_dir):
                    shutil.rmtree(item_dir)
                    deleted += 1

            _LOGGER.info(f"Deleted {deleted} saved video directories.")
            return {
                "success": True,
                "message": f"Deleted {deleted} videos successfully. Playlists and saved streams were preserved.",
            }
        except Exception as e:
            _LOGGER.error(f"Failed to delete all videos: {e}")
            return {"success": False, "message": f"Failed to delete all videos: {str(e)}"}

    def _delete_saved_videos_by_filter_sync(self, filter_value: str) -> dict:
        """Synchronously deletes videos matching filter: all | unknown | playlist_id."""
        try:
            if not os.path.exists(self._saved_media_path):
                return {"success": False, "message": "Media library directory not found."}

            filter_key = (filter_value or "all").strip()
            if filter_key == "all":
                return self._delete_all_saved_videos_sync()

            playlists = self._load_playlists_sync()
            known_playlist_ids = {pl.get("id") for pl in playlists if pl.get("id")}
            deleted = 0

            for item_name in os.listdir(self._saved_media_path):
                item_dir = os.path.join(self._saved_media_path, item_name)
                info_file = os.path.join(item_dir, "info.json")
                if not os.path.isdir(item_dir) or not os.path.exists(info_file):
                    continue

                should_delete = False
                try:
                    with open(info_file, "r") as f:
                        info_data = json.load(f)
                    playlist_id = info_data.get("playlist_id")
                except Exception:
                    playlist_id = None

                if filter_key == "unknown":
                    # "Unassigned" means no playlist_id or an id that no longer exists.
                    should_delete = not playlist_id or playlist_id not in known_playlist_ids
                else:
                    should_delete = playlist_id == filter_key

                if should_delete:
                    shutil.rmtree(item_dir)
                    deleted += 1

            if filter_key == "unknown":
                return {
                    "success": True,
                    "message": f"Deleted {deleted} unassigned videos successfully.",
                    "deleted": deleted,
                    "filter": "unknown",
                }

            return {
                "success": True,
                "message": f"Deleted {deleted} videos for selected playlist.",
                "deleted": deleted,
                "filter": filter_key,
            }
        except Exception as e:
            _LOGGER.error(f"Failed to delete videos by filter '{filter_value}': {e}")
            return {"success": False, "message": f"Failed to delete filtered videos: {str(e)}"}

    async def api_stop_playback(self):
        """Stops playback and resets the coordinator state."""
        self._now_playing = {"type": None, "id": None, "title": "Idle", "resolution": SUPPORTED_RESOLUTIONS[-1]}
        self.async_update_listeners()
        _LOGGER.info("Playback conceptually stopped in coordinator.")

    # --- Download and Processing Logic ---

    def _progress_hook(self, d, session_id, resolution_info=None):
        """Handle download progress updates."""
        task = self._tasks.get(session_id)
        if not task: return

        if d['status'] == 'downloading':
            try:
                # Get total bytes if available
                total_bytes = d.get('total_bytes') or d.get('total_bytes_estimate', 0)
                downloaded_bytes = d.get('downloaded_bytes', 0)
                
                if total_bytes > 0:
                    # Calculate percentage based on actual bytes
                    progress = (downloaded_bytes / total_bytes) * 100
                else:
                    # Fallback to percentage string if bytes not available
                    percent_str = d.get('_percent_str', '0%')
                    cleaned_percent_str = re.sub(r'\x1b\[[0-9;]*m', '', percent_str)
                    progress = float(cleaned_percent_str.strip().strip('%'))

                task['progress'] = min(progress, 100)  # Ensure we don't exceed 100%
                
                # Add resolution info to message if available
                res_info = f" ({resolution_info}p)" if resolution_info else ""
                task['message'] = f"Downloading{res_info}: {d.get('info_dict', {}).get('title', 'video')[:50]}... {task['progress']:.1f}%"
                
            except (ValueError, TypeError) as e:
                _LOGGER.warning(f"Error parsing progress for session {session_id}: {e}")
                task['message'] = "Processing download progress..."
                
        elif d['status'] == 'finished':
            task['progress'] = 100
            res_info = f" ({resolution_info}p)" if resolution_info else ""
            task['message'] = f"Download complete{res_info}. Post-processing..."

    async def _download_and_process(self, url: str, session_id: str):
        """Asynchronously triggers the synchronous download process."""
        await self.hass.async_add_executor_job(
            self._download_and_process_sync, url, session_id
        )
        task = self.get_task_status(session_id)
        if task.get("status") == "ready":
            # Autoplay the video at the default (lowest) resolution
            await self.api_play_session_video(session_id, SUPPORTED_RESOLUTIONS[-1])

    def _download_and_process_sync(self, url: str, session_id: str):
        """Handles the core download and extraction process for selected resolutions."""
        task = self._tasks.get(session_id)
        if not task: return

        task["status"] = "downloading"
        task["message"] = "Fetching video information..."
        
        successfully_downloaded_resolutions = []
        audio_source_material = {"path": None, "resolution": None} # To pick best source for audio

        try:
            # Step 1: Extract general video info (title, youtube_id, FPS) once
            ydl_info_opts = {'quiet': True, 'noplaylist': True}
            with yt_dlp.YoutubeDL(ydl_info_opts) as ydl_info:
                info = ydl_info.extract_info(url, download=False)
                task['original_title'] = info.get('title', 'Unknown Title')
                task['youtube_id'] = info.get('id')
                # Store duration (seconds) for later progress estimation during audio extraction
                try:
                    dur = info.get('duration')
                    if isinstance(dur, (int, float)) and dur > 0:
                        task['duration'] = float(dur)
                except Exception:
                    pass
                
                _LOGGER.info(f"Session {session_id}: Attempting FPS detection for '{task['original_title']}'...")
                stream_for_fps = next((s for s in info.get('formats', []) if s.get('vcodec', '').startswith('avc1') and s.get('fps')), None)
                if not stream_for_fps: stream_for_fps = next((s for s in info.get('formats', []) if s.get('fps')), None)

                if stream_for_fps and isinstance(stream_for_fps.get('fps'), (int, float)) and stream_for_fps.get('fps') > 0:
                    task['fps'] = stream_for_fps.get('fps')
                    _LOGGER.info(f"Session {session_id}: Detected video FPS: {task['fps']}")
                else:
                    _LOGGER.warning(f"Session {session_id}: Could not detect FPS. Using default: {task['fps']}")

            # Step 2: Download each user-selected resolution directly
            user_selected_resolutions = task.get("resolutions", []) # These are sorted high to low from api_submit_url
            if not user_selected_resolutions:
                _LOGGER.warning(f"Session {session_id}: No resolutions selected or available in task. Aborting download process.")
                raise ValueError("No resolutions provided for download.")

            # Get all available formats for better error reporting
            available_formats = []
            for f in info.get('formats', []):
                if f.get('vcodec', 'none') != 'none' and f.get('height'):
                    available_formats.append({
                        'height': f.get('height'),
                        'format_id': f.get('format_id'),
                        'ext': f.get('ext'),
                        'filesize': f.get('filesize'),
                        'fps': f.get('fps')
                    })

            # Sort and get unique heights
            available_formats.sort(key=lambda x: x['height'], reverse=True)
            available_heights = sorted(set(f['height'] for f in available_formats), reverse=True)
            _LOGGER.info(f"Session {session_id}: Available resolutions for video: {available_heights}")

            for res in user_selected_resolutions:
                task["status"] = "downloading"
                task["message"] = f"Preparing {res}p download..."
                task["progress"] = 0 # Reset progress for each resolution
                
                # Choose the actual height to fetch based on what's available
                actual_res = None
                try:
                    lower_or_equal = [h for h in available_heights if h <= res]
                    if lower_or_equal:
                        actual_res = max(lower_or_equal)
                        # Enforce 240p minimum if user requested >= 240p
                        if res >= 240 and actual_res < 240:
                            _LOGGER.warning(f"Requested {res}p but only <240p available (best {actual_res}p); skipping this resolution.")
                            continue
                    else:
                        # No lower-or-equal available; respect minimum 240p if requested >= 240
                        if res >= 240:
                            _LOGGER.warning(f"Requested {res}p but lowest available is {min(available_heights) if available_heights else 'unknown'}p; skipping below 240p.")
                            continue
                        # If the user explicitly asked below 240, allow smallest available
                        actual_res = min(available_heights) if available_heights else res
                except Exception:
                    actual_res = res

                task["message"] = f"Attempting {actual_res}p (requested {res}p)..."

                # Define output path for this specific resolution's video file
                temp_download_base = os.path.join(task["session_dir"], f"yt_temp_download_{actual_res}")
                final_video_path_for_res = task["video_paths"].get(str(res)) or task["video_paths"].get(str(actual_res)) or os.path.join(task["session_dir"], f"video_{actual_res}.mp4")

                # Prefer mp4-capable streams if possible, but allow any then remux
                format_string = (
                    f"bestvideo[height<={actual_res}][ext=mp4]+bestaudio/best[height<={actual_res}]"
                    f"/bestvideo[height<={actual_res}]+bestaudio/best[height<={actual_res}]"
                )
                ydl_opts = {
                    'outtmpl': temp_download_base,
                    'format': format_string,
                    'progress_hooks': [lambda d, s_id=session_id, r_info=actual_res: self._progress_hook(d, s_id, r_info)],
                    'quiet': True,
                    'noplaylist': True,
                    'merge_output_format': 'mp4'
                }

                _LOGGER.info(f"Session {session_id}: Starting download of {actual_res}p (requested {res}p) for '{task['original_title']}'.")
                try:
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        ydl.download([url])
                    
                    downloaded_mp4_file = temp_download_base + ".mp4"
                    if os.path.exists(downloaded_mp4_file):
                        os.rename(downloaded_mp4_file, final_video_path_for_res)
                        _LOGGER.info(f"Session {session_id}: Successfully downloaded {actual_res}p to {final_video_path_for_res}")
                        # Ensure mapping for actual resolution exists (avoid KeyError later)
                        self._tasks[session_id]["video_paths"][str(actual_res)] = final_video_path_for_res
                        successfully_downloaded_resolutions.append(actual_res)
                        # Keep track of the highest quality successfully downloaded video for audio extraction
                        if audio_source_material["path"] is None or actual_res > audio_source_material["resolution"]:
                            audio_source_material["path"] = final_video_path_for_res
                            audio_source_material["resolution"] = actual_res
                    else:
                        _LOGGER.warning(f"Session {session_id}: Download for {actual_res}p completed, but output file {downloaded_mp4_file} not found.")

                except yt_dlp.utils.DownloadError as e_dl:
                    error_msg = str(e_dl)
                    if "Requested format is not available" in error_msg:
                        error_msg = f"Resolution {actual_res}p (requested {res}p) is not available for this video. Available resolutions are: {', '.join(map(str, available_heights))}p"
                    _LOGGER.error(f"Session {session_id}: Failed to download {actual_res}p (requested {res}p): {error_msg}")
                    task["message"] = f"Failed {actual_res}p. {error_msg}"
                except Exception as e_file_handling:
                    _LOGGER.error(f"Session {session_id}: Error handling file for {actual_res}p after download: {e_file_handling}")
            
            # Update task with successfully downloaded resolutions (unique)
            task["resolutions"] = sorted(list(set(successfully_downloaded_resolutions)), reverse=True)

            if not task["resolutions"]:
                error_msg = f"No video resolutions were successfully downloaded. Available resolutions for this video are: {', '.join(map(str, available_heights))}p"
                _LOGGER.error(f"Session {session_id}: {error_msg}")
                raise ValueError(error_msg)

            # Step 3: Extract Audio (from the best quality successfully downloaded video)
            if audio_source_material["path"] and os.path.exists(audio_source_material["path"]):
                task["status"] = "processing"
                task["message"] = f"Extracting audio from {audio_source_material['resolution']}p version..."
                _LOGGER.info(f"Session {session_id}: Extracting audio from {audio_source_material['path']} to {task['audio_path']}")
                
                try:
                    # Check file size (limit to 4GB)
                    file_size = os.path.getsize(audio_source_material["path"])
                    if file_size > 4 * 1024 * 1024 * 1024:  # 4GB in bytes
                        raise ValueError(f"Video file too large ({file_size / (1024*1024*1024):.1f}GB). Maximum size is 4GB.")

                    # Determine total duration (prefer yt-dlp info; fallback to ffprobe)
                    total_duration = None
                    try:
                        if isinstance(task.get('duration'), (int, float)) and task.get('duration') > 0:
                            total_duration = float(task.get('duration'))
                        if not total_duration:
                            # Attempt ffprobe for exact input file duration
                            probe = subprocess.run([
                                'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                '-of', 'default=noprint_wrappers=1:nokey=1', audio_source_material['path']
                            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
                            if probe.returncode == 0:
                                try:
                                    total_duration = float(probe.stdout.strip())
                                except Exception:
                                    total_duration = None
                    except Exception:
                        total_duration = None

                    # Build the ffmpeg command to extract and create a CBR MP3 for maximum compatibility.
                    ffmpeg_cmd = [
                        self.ffmpeg.binary,
                        '-hide_banner',
                        '-nostdin',
                        '-progress', 'pipe:2',  # emit machine-readable progress to stderr
                        '-copyts',             # Copy timestamps from input
                        '-start_at_zero',      # Start timestamps from zero
                        '-i', audio_source_material["path"],
                        '-map', '0:a:0',       # Map first audio stream
                        '-c:a', 'libmp3lame',  # Use MP3 codec
                        '-b:a', '128k',        # Set Constant Bitrate (CBR) of 128k for seekability
                        '-write_xing', '0',    # Disable Xing header for CBR
                        '-ar', '44100',        # Standard audio sample rate
                        '-ac', '2',            # Stereo
                        '-y',                  # Overwrite output file if exists
                        task["audio_path"]
                    ]

                    _LOGGER.info(f"Session {session_id}: Running FFmpeg with command: {' '.join(ffmpeg_cmd)}")

                    # Stream stderr to update progress
                    process = subprocess.Popen(
                        ffmpeg_cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        bufsize=1
                    )

                    def _parse_time_to_secs(t: str) -> float:
                        # expected format HH:MM:SS.microseconds
                        try:
                            parts = t.split(':')
                            if len(parts) != 3:
                                return 0.0
                            hours = float(parts[0])
                            minutes = float(parts[1])
                            seconds = float(parts[2])
                            return hours * 3600 + minutes * 60 + seconds
                        except Exception:
                            return 0.0

                    # Read progress
                    while True:
                        line = process.stderr.readline()
                        if not line:
                            if process.poll() is not None:
                                break
                            continue
                        line = line.strip()
                        # Progress format lines include out_time_ms or out_time
                        try:
                            if line.startswith('out_time_ms=') and total_duration:
                                out_ms = float(line.split('=', 1)[1].strip() or '0')
                                pct = min(99.0, max(0.0, (out_ms / 1_000_000.0) / total_duration * 100.0))
                                task['progress'] = pct
                                task['message'] = f"Extracting audio... {pct:.1f}%"
                            elif line.startswith('out_time=') and total_duration:
                                out_t = line.split('=', 1)[1].strip()
                                out_s = _parse_time_to_secs(out_t)
                                pct = min(99.0, max(0.0, (out_s / total_duration) * 100.0))
                                task['progress'] = pct
                                task['message'] = f"Extracting audio... {pct:.1f}%"
                            elif line.startswith('progress=') and line.endswith('end'):
                                task['progress'] = 100.0
                                task['message'] = 'Finalizing audio...'
                        except Exception:
                            # ignore parse errors; keep going
                            pass

                    ret = process.wait()
                    if ret != 0:
                        # Read remaining stderr for error details
                        remaining_err = ''
                        try:
                            remaining_err = process.stderr.read() or ''
                        except Exception:
                            pass
                        error_msg = remaining_err if remaining_err else "Unknown FFmpeg error"
                        raise RuntimeError(f"FFmpeg audio extraction failed: {error_msg}")

                    if not os.path.exists(task["audio_path"]) or os.path.getsize(task["audio_path"]) == 0:
                        raise SystemError("Audio extraction produced an empty or missing file.")

                    task['progress'] = 100.0
                    task['message'] = 'Audio extraction complete.'
                    _LOGGER.info(f"Session {session_id}: Audio successfully extracted to {task['audio_path']}")
                except Exception as e:
                    _LOGGER.error(f"Session {session_id}: Error during audio extraction: {e}")
                    raise
            else:
                _LOGGER.error(f"Session {session_id}: No suitable video file available for audio extraction for '{task['original_title']}'.")
                raise SystemError("Audio extraction failed: No source video downloaded successfully.")

            # Step 4: Remove audio from all video files
            task["status"] = "processing"
            task["message"] = "Removing audio from all video files..."
            _LOGGER.info(f"Session {session_id}: Removing audio from all downloaded video files")
            
            for res in task.get("resolutions", []):
                video_path = task["video_paths"][str(res)]
                if os.path.exists(video_path):
                    try:
                        if self._remove_audio_from_video(video_path):
                            _LOGGER.info(f"Session {session_id}: Audio successfully removed from {res}p video")
                        else:
                            _LOGGER.error(f"Session {session_id}: Audio removal failed for {res}p video")
                            raise SystemError(f"Audio removal failed for {res}p video.")
                    except Exception as e:
                        _LOGGER.error(f"Session {session_id}: Error removing audio from {res}p video: {e}")
                        raise

            # Step 5: Save to library
            if task['youtube_id']:
                self._save_to_library_sync(task, url)
                # Clean up temp directory after successful save
                if task.get("session_dir") and os.path.exists(task.get("session_dir")):
                    try:
                        shutil.rmtree(task.get("session_dir"), ignore_errors=True)
                        _LOGGER.info(f"Session {session_id}: Cleaned up temporary directory after successful save")
                    except Exception as cleanup_error:
                        _LOGGER.error(f"Session {session_id}: Failed to clean up temporary directory: {cleanup_error}")

            task["status"] = "ready"
            _LOGGER.info(f"Session {session_id}: Processing complete for '{task['original_title']}'. Final resolutions: {task['resolutions']}")

        except Exception as e:
            _LOGGER.error(f"Session {session_id}: Critical error in processing '{task.get('original_title', 'Unknown Video')}': {e}", exc_info=True)
            task["status"], task["message"] = "error", f"Processing Error: {type(e).__name__} - {str(e)[:200]}"
            # Clean up any temporary files
            if task.get("session_dir") and os.path.exists(task.get("session_dir")):
                try:
                    shutil.rmtree(task.get("session_dir"), ignore_errors=True)
                except Exception as cleanup_error:
                    _LOGGER.error(f"Failed to clean up temporary files for session {session_id}: {cleanup_error}")

    def _save_to_library_sync(self, task: dict, url: str):
        """Saves successfully generated task files to the persistent library."""
        youtube_id = task.get("youtube_id")
        if not youtube_id: return

        sanitized_id = re.sub(r'(?u)[^-\w.]', '', str(youtube_id).strip().replace(" ", "_"))[:100]
        saved_video_dir = os.path.join(self._saved_media_path, sanitized_id)
        os.makedirs(saved_video_dir, exist_ok=True)

        for res in task.get("resolutions", []):
            source_path = task["video_paths"][str(res)]
            dest_path = os.path.join(saved_video_dir, f"video_{res}.mp4")
            if os.path.exists(source_path):
                _LOGGER.info(f"Copying video for {res}p from {source_path} to {dest_path}")
                shutil.copy2(source_path, dest_path)
                # Update the task's path to the library location so that session-type
                # playback still works after the temp directory is cleaned up.
                task["video_paths"][str(res)] = dest_path

        source_audio_path = task.get("audio_path")
        dest_audio_path = os.path.join(saved_video_dir, "audio.mp3")
        if source_audio_path and os.path.exists(source_audio_path):
            _LOGGER.info(f"Copying seekable audio from {source_audio_path} to {dest_audio_path}")
            shutil.copy2(source_audio_path, dest_audio_path)
        else:
            _LOGGER.warning(f"Could not find source audio file at {source_audio_path} to save to library.")

        info = { "id": sanitized_id, "original_youtube_id": youtube_id, "title": task.get("original_title"),
                 "fps": task.get("fps", 24.0), "resolutions": task.get("resolutions", []),
                 "original_url": url, "saved_date": time.strftime("%Y-%m-%d %H:%M:%S"),
                 "playlist_id": task.get("playlist_id") }

        with open(os.path.join(saved_video_dir, "info.json"), 'w') as f:
            json.dump(info, f, indent=4)
        _LOGGER.info(f"Saved {youtube_id} to library with resolutions: {info['resolutions']}.")

    def _list_saved_videos_sync(self) -> list:
        """Scans the library directory and lists all saved videos."""
        saved_items = []
        for item_name in os.listdir(self._saved_media_path):
            item_dir = os.path.join(self._saved_media_path, item_name)
            info_file = os.path.join(item_dir, "info.json")
            if os.path.isdir(item_dir) and os.path.exists(info_file):
                try:
                    with open(info_file, 'r') as f: info_data = json.load(f)
                    saved_items.append({
                        "id": item_name,
                        "title": info_data.get("title", item_name),
                        "resolutions": info_data.get("resolutions", []),
                        "original_youtube_id": info_data.get("original_youtube_id"),
                        "original_url": info_data.get("original_url"),
                        "playlist_id": info_data.get("playlist_id")
                    })
                except Exception as e:
                    _LOGGER.error(f"Error reading saved item {item_dir}: {e}")
        return sorted(saved_items, key=lambda x: x.get('title', '').lower())

    def _get_saved_video_info(self, video_id: str) -> dict | None:
        """Retrieves the info.json data for a specific saved video."""
        info_path = os.path.join(self._saved_media_path, video_id, "info.json")
        if not os.path.exists(info_path): return None
        try:
            with open(info_path, 'r') as f: return json.load(f)
        except Exception: return None

    def _delete_saved_video_sync(self, video_id: str) -> dict:
        """Deletes a video's directory from the library."""
        video_dir_path = os.path.join(self._saved_media_path, video_id)
        if not os.path.isdir(video_dir_path):
            return {"success": False, "message": "Video directory not found."}
        try:
            shutil.rmtree(video_dir_path)
            _LOGGER.info(f"Deleted saved video directory: {video_dir_path}")
            return {"success": True, "message": "Video deleted successfully."}
        except Exception as e:
            _LOGGER.error(f"Failed to delete video directory {video_dir_path}: {e}")
            return {"success": False, "message": f"Failed to delete video: {str(e)}"}

    # --- MJPEG Stream Generation (FIXED) ---

    # --- Playlists persistence helpers ---
    def _load_playlists_sync(self) -> list:
        try:
            if os.path.exists(self._playlists_file_path):
                with open(self._playlists_file_path, 'r') as f:
                    data = json.load(f)
                    if isinstance(data, list):
                        # Ensure minimal schema
                        normalized = []
                        for item in data:
                            if isinstance(item, dict) and item.get("url"):
                                normalized.append({
                                    "id": item.get("id") or str(uuid.uuid4()),
                                    "name": item.get("name") or "Untitled",
                                    "url": item.get("url")
                                })
                        return normalized
            return []
        except Exception as e:
            _LOGGER.error(f"Failed to load playlists: {e}")
            return []

    def _save_playlists_sync(self, playlists: list) -> None:
        try:
            # Best-effort atomic write
            tmp_path = self._playlists_file_path + ".tmp"
            with open(tmp_path, 'w') as f:
                json.dump(playlists or [], f, indent=2)
            os.replace(tmp_path, self._playlists_file_path)
        except Exception as e:
            _LOGGER.error(f"Failed to save playlists: {e}")

    # --- M3U8 Saved Streams persistence helpers ---
    def _load_saved_streams_sync(self) -> list:
        try:
            if os.path.exists(self._saved_streams_file_path):
                with open(self._saved_streams_file_path, 'r') as f:
                    data = json.load(f)
                    if isinstance(data, list):
                        # Ensure minimal schema
                        normalized = []
                        for item in data:
                            if isinstance(item, dict) and item.get("url"):
                                normalized.append({
                                    "id": item.get("id") or str(uuid.uuid4()),
                                    "name": item.get("name") or "Untitled",
                                    "url": item.get("url"),
                                    "dateAdded": item.get("dateAdded") or item.get("added_date") or time.strftime("%Y-%m-%dT%H:%M:%S")
                                })
                        return normalized
            return []
        except Exception as e:
            _LOGGER.error(f"Failed to load saved streams: {e}")
            return []

    def _save_saved_streams_sync(self, streams: list) -> None:
        try:
            # Best-effort atomic write
            tmp_path = self._saved_streams_file_path + ".tmp"
            with open(tmp_path, 'w') as f:
                json.dump(streams or [], f, indent=2)
            os.replace(tmp_path, self._saved_streams_file_path)
        except Exception as e:
            _LOGGER.error(f"Failed to save saved streams: {e}")

    # --- M3U8 Saved Streams API ---
    async def api_list_m3u8_saved_streams(self) -> list:
        return await self.hass.async_add_executor_job(self._load_saved_streams_sync)

    async def api_add_m3u8_saved_stream(self, name: str, url: str) -> dict:
        if not url:
            raise ValueError("Stream URL is required")
        streams = await self.hass.async_add_executor_job(self._load_saved_streams_sync)
        
        # Check if URL already exists
        existing_index = next((i for i, s in enumerate(streams) if s.get("url") == url), None)
        if existing_index is not None:
            # Update existing stream
            streams[existing_index]["name"] = name or "Untitled"
            streams[existing_index]["dateAdded"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            stream = streams[existing_index]
        else:
            # Add new stream
            stream_id = str(uuid.uuid4())
            stream = {
                "id": stream_id,
                "name": name or "Untitled",
                "url": url,
                "dateAdded": time.strftime("%Y-%m-%dT%H:%M:%S")
            }
            streams.append(stream)
        
        await self.hass.async_add_executor_job(self._save_saved_streams_sync, streams)
        return stream

    async def api_delete_m3u8_saved_stream(self, stream_id: str) -> dict:
        if not stream_id:
            raise ValueError("Stream id is required")
        streams = await self.hass.async_add_executor_job(self._load_saved_streams_sync)
        new_list = [s for s in streams if s.get("id") != stream_id]
        deleted = len(new_list) != len(streams)
        await self.hass.async_add_executor_job(self._save_saved_streams_sync, new_list)
        return {"success": deleted}

    def get_mjpeg_quality(self) -> int:
        """Get the current MJPEG quality setting."""
        return self._mjpeg_quality

    def set_mjpeg_quality(self, quality: int) -> None:
        """Set the MJPEG quality setting."""
        if not 1 <= quality <= 31:
            raise ValueError("Quality must be between 1 and 31")
        self._mjpeg_quality = quality
        _LOGGER.info(f"MJPEG quality set to {quality}")

    def get_stream_fps(self) -> int:
        """Get the current stream FPS setting."""
        return self._stream_fps

    def set_stream_fps(self, fps: int) -> None:
        """Set the stream FPS setting."""
        if not MIN_STREAM_FPS <= fps <= MAX_STREAM_FPS:
            raise ValueError(f"FPS must be between {MIN_STREAM_FPS} and {MAX_STREAM_FPS}")
        self._stream_fps = fps
        _LOGGER.info(f"Stream FPS set to {fps}")

    def get_m3u8_mjpeg_quality(self) -> int:
        """Get the current M3U8 MJPEG quality setting."""
        return self._m3u8_mjpeg_quality

    def set_m3u8_mjpeg_quality(self, quality: int) -> None:
        """Set the M3U8 MJPEG quality setting."""
        if not 1 <= quality <= 31:
            raise ValueError("Quality must be between 1 and 31")
        self._m3u8_mjpeg_quality = quality
        _LOGGER.info(f"M3U8 MJPEG quality set to {quality}")

    def get_m3u8_stream_fps(self) -> int:
        """Get the current M3U8 stream FPS setting."""
        return self._m3u8_stream_fps

    def set_m3u8_stream_fps(self, fps: int) -> None:
        """Set the M3U8 stream FPS setting."""
        if not MIN_STREAM_FPS <= fps <= MAX_STREAM_FPS:
            raise ValueError(f"FPS must be between {MIN_STREAM_FPS} and {MAX_STREAM_FPS}")
        self._m3u8_stream_fps = fps
        _LOGGER.info(f"M3U8 stream FPS set to {fps}")

    async def _mjpeg_generator(self, stream_type: str, item_id: str, resolution: int, quality: int = None, timestamp: float = None) -> AsyncGenerator[bytes, None]:
        """Async generator for the MJPEG stream, serving a specific resolution."""
        video_path = self._get_video_path(stream_type, item_id, resolution)
        if not video_path or not await self.hass.async_add_executor_job(os.path.exists, video_path):
            _LOGGER.error(f"MJPEG stream failed: Video path not found or file does not exist for {stream_type}/{item_id} at {resolution}p")
            return

        # Use provided quality or fall back to current setting
        quality = quality if quality is not None else self._mjpeg_quality

        # Use the user-configured FPS for every stream.
        target_fps = self._stream_fps
        _LOGGER.info(f"Starting FFmpeg process for {stream_type}/{item_id} at {resolution}p, streaming at {target_fps} FPS with quality {quality}.")

        # Build FFmpeg command with timestamp support
        ffmpeg_cmd = [
            self.ffmpeg.binary,
            "-re",
            "-stream_loop", "-1",
            "-i", video_path,
            "-f", "mjpeg",
            "-q:v", str(quality),
            "-vf", f"fps={target_fps}",
        ]

        # Add timestamp seek if provided
        if timestamp is not None:
            ffmpeg_cmd.insert(2, "-ss")
            ffmpeg_cmd.insert(3, str(timestamp))

        ffmpeg_cmd.append("-")
        _LOGGER.debug(f"FFmpeg command: {' '.join(ffmpeg_cmd)}")

        process = await asyncio.create_subprocess_exec(
            *ffmpeg_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        setattr(self, "_current_mjpeg_process", process)
        _LOGGER.info(f"MJPEG FFmpeg process started with PID {process.pid}")

        # The rest of the function remains identical...
        async def log_stderr():
            while not process.stderr.at_eof():
                line = await process.stderr.readline()
                if not line: break
                _LOGGER.debug(f"FFmpeg stderr: {line.decode().strip()}")
        stderr_logger_task = asyncio.create_task(log_stderr())

        frame_buffer = b''
        try:
            while True:
                chunk = await process.stdout.read(4096)
                if not chunk:
                    _LOGGER.info("FFmpeg process provided no more output.")
                    break

                frame_buffer += chunk

                start = frame_buffer.find(b'\xff\xd8')
                end = frame_buffer.find(b'\xff\xd9')

                if start != -1 and end != -1:
                    frame = frame_buffer[start:end+2]
                    frame_buffer = frame_buffer[end+2:]

                    yield (b'--frame\r\n'
                           b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')

        except (asyncio.CancelledError, ConnectionResetError) as e:
            _LOGGER.info(f"MJPEG stream for {item_id} was closed by the client: {type(e).__name__}")
        except Exception as e:
            _LOGGER.error(f"Unexpected error in MJPEG generator for {item_id}: {e}", exc_info=True)
        finally:
            if process and process.returncode is None:
                _LOGGER.info(f"Terminating FFmpeg process PID {process.pid} for {item_id}")
                try:
                    process.terminate()
                    await asyncio.gather(process.wait(), stderr_logger_task)
                except Exception as term_error:
                    _LOGGER.warning(f"Error during FFmpeg termination for {item_id}, killing process. Error: {term_error}")
                    process.kill()
                    await process.wait()

            setattr(self, "_current_mjpeg_process", None)
            _LOGGER.info(f"MJPEG generator for {item_id} has finished.")

    def _remove_audio_from_video(self, video_path: str) -> bool:
        """Removes audio track from a video file, keeping only video."""
        try:
            # Create temporary output path
            temp_output = video_path + ".temp.mp4"
            
            # FFmpeg command to remove audio track
            ffmpeg_cmd = [
                self.ffmpeg.binary,
                '-i', video_path,
                '-c:v', 'copy',  # Copy video stream without re-encoding
                '-an',  # Remove audio
                '-y',  # Overwrite output file
                temp_output
            ]
            
            _LOGGER.info(f"Removing audio from video: {video_path}")
            
            # Run FFmpeg process
            process = subprocess.run(
                ffmpeg_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            
            if process.returncode != 0:
                error_msg = process.stderr if process.stderr else "Unknown error"
                _LOGGER.error(f"FFmpeg error removing audio: {error_msg}")
                return False
            
            # Replace original file with audio-free version
            if os.path.exists(temp_output):
                os.replace(temp_output, video_path)
                _LOGGER.info(f"Successfully removed audio from: {video_path}")
                return True
            else:
                _LOGGER.error(f"Audio removal failed: output file not created")
                return False
                
        except Exception as e:
            _LOGGER.error(f"Error removing audio from {video_path}: {e}")
            return False
