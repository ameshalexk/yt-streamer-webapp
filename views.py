"""HTTP Views for YT Streamer."""
import os
import logging
import asyncio
from collections import deque
from aiohttp import web, ClientSession, ClientTimeout

from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.components.ffmpeg import get_ffmpeg_manager

from .coordinator import YTStreamerCoordinator
from .const import MIN_STREAM_FPS, MAX_STREAM_FPS

_LOGGER = logging.getLogger(__name__)

# go2rtc configuration
# Since both Home Assistant and go2rtc are in Docker on the same network,
# use the container name as the hostname
GO2RTC_HOST = "go2rtc"  # Container name from docker-compose.yml
GO2RTC_PORT = 1984
GO2RTC_BASE_URL = f"http://{GO2RTC_HOST}:{GO2RTC_PORT}"

# yt-dlp service configuration
YTDLP_SERVICE_HOST = "yt-dlp-service"  # Container name from docker-compose.yml
YTDLP_SERVICE_PORT = 5000  # Internal port (container listens on 5000, exposed as 5001)
YTDLP_SERVICE_URL = f"http://{YTDLP_SERVICE_HOST}:{YTDLP_SERVICE_PORT}"

# The path to the index.html file should be correct in your structure
FRONTEND_PATH = os.path.join(os.path.dirname(__file__), "frontend", "index.html")

class YTStreamerFrontendView(HomeAssistantView):
    """View to serve the frontend iframe content."""
    url = "/api/yt_streamer/frontend"
    name = "api:yt_streamer:frontend"
    requires_auth = False

    def __init__(self, entry: ConfigEntry):
        self.entry = entry

    async def get(self, request):
        """Serve the frontend."""
        hass = request.app["hass"]
        try:
            content = await hass.async_add_executor_job(self._read_frontend_file)
            # Add cache-busting headers to ensure updated UI is served (Tesla browser can be aggressive)
            headers = {
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
            }
            return web.Response(text=content, content_type="text/html", headers=headers)
        except FileNotFoundError:
            _LOGGER.error(f"Frontend file not found at {FRONTEND_PATH}")
            return web.Response(text="YT Streamer Panel: Frontend file not found.", status=500)

    def _read_frontend_file(self) -> str:
        """Read the frontend file."""
        with open(FRONTEND_PATH) as f:
            return f.read()

class YTStreamerApiView(HomeAssistantView):
    """API View for YT Streamer."""
    url = "/api/yt_streamer/api/{path:.*}"
    name = "api:yt_streamer:api"
    requires_auth = True

    def __init__(self, coordinator: YTStreamerCoordinator):
        self.coordinator = coordinator
    
    async def _extract_youtube_stream_url(self, youtube_url: str) -> dict:
        """Extract video and audio URLs from YouTube using external yt-dlp service.
        
        Returns dict with 'video_url' and optional 'audio_url'.
        """
        try:
            async with ClientSession() as session:
                # Call the yt-dlp service
                async with session.post(
                    f"{YTDLP_SERVICE_URL}/extract",
                    json={"url": youtube_url, "max_height": 720},
                    timeout=ClientTimeout(total=30)
                ) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        _LOGGER.error(f"yt-dlp service error: {resp.status} - {error_text}")
                        raise ValueError(f"yt-dlp service returned error: {error_text}")
                    
                    result = await resp.json()
                    
                    video_url = result.get('video_url')
                    audio_url = result.get('audio_url')
                    
                    if not video_url:
                        raise ValueError("yt-dlp service did not return a video URL")
                    
                    _LOGGER.info(f"Extracted YouTube stream via yt-dlp service")
                    _LOGGER.info(f"  Video: {video_url[:100]}...")
                    if audio_url:
                        _LOGGER.info(f"  Audio: {audio_url[:100]}...")
                    else:
                        _LOGGER.info(f"  Audio: None (video-only or combined)")
                    
                    return {
                        'video_url': video_url,
                        'audio_url': audio_url,
                        'fps': result.get('fps'),
                    }
                
        except Exception as e:
            _LOGGER.error(f"Error calling yt-dlp service: {e}", exc_info=True)
            raise

    async def get(self, request, path: str):
        """Handle GET requests."""
        # Normalize path (remove leading/trailing slashes)
        path = path.strip('/')
        
        if path == "get_quality":
            return web.json_response({"quality": self.coordinator.get_mjpeg_quality()})
        
        if path == "get_fps":
            return web.json_response({"fps": self.coordinator.get_stream_fps()})

        if path == "get_m3u8_quality":
            return web.json_response({"quality": self.coordinator.get_m3u8_mjpeg_quality()})

        if path == "get_m3u8_fps":
            return web.json_response({"fps": self.coordinator.get_m3u8_stream_fps()})

        if path == "list_saved":
            return web.json_response(await self.coordinator.api_list_saved_videos())

        if path == "playlists":
            return web.json_response(await self.coordinator.api_list_playlists())
        
        if path == "m3u8_saved_streams":
            return web.json_response(await self.coordinator.api_list_m3u8_saved_streams())

        if path.startswith("status/"):
            session_id = path.split("/")[-1]
            return web.json_response(self.coordinator.get_task_status(session_id))

        if path == "video_formats":
            url = request.query.get("url")
            if not url:
                return web.json_response({"message": "url parameter is required"}, status=400)
            return web.json_response(await self.coordinator.api_get_video_formats(url))

        if path == "playlist_info":
            playlist_url = request.query.get('playlist_url')
            if not playlist_url:
                return web.json_response({"error": "playlist_url parameter is required"}, status=400)
            videos = await self.coordinator.api_get_playlist_info(playlist_url)
            return web.json_response(videos)

        if path == "playlist_title":
            playlist_url = request.query.get('playlist_url')
            if not playlist_url:
                return web.json_response({"error": "playlist_url parameter is required"}, status=400)
            title = await self.coordinator.api_get_playlist_title(playlist_url)
            return web.json_response({"title": title})

        # go2rtc proxy endpoints
        if path == "go2rtc/streams":
            # List streams
            async with ClientSession() as session:
                try:
                    async with session.get(f"{GO2RTC_BASE_URL}/api/streams") as resp:
                        data = await resp.json()
                        _LOGGER.debug(f"go2rtc streams list: {len(data)} streams")
                        return web.json_response(data)
                except Exception as e:
                    _LOGGER.error(f"Error proxying go2rtc streams list: {e}")
                    return web.json_response({"error": str(e)}, status=500)
        
        # Check stream status - must come after exact match check
        if path.startswith("go2rtc/streams/") and path != "go2rtc/streams":
            stream_name = path.replace("go2rtc/streams/", "")
            async with ClientSession() as session:
                try:
                    async with session.get(f"{GO2RTC_BASE_URL}/api/streams/{stream_name}") as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            _LOGGER.info(f"Stream '{stream_name}' status: {data}")
                            return web.json_response(data)
                        else:
                            error_text = await resp.text()
                            _LOGGER.warning(f"Stream '{stream_name}' not found: {resp.status} - {error_text}")
                            return web.json_response({"error": "Stream not found"}, status=404)
                except Exception as e:
                    _LOGGER.error(f"Error getting stream status: {e}")
                    return web.json_response({"error": str(e)}, status=500)

        return web.json_response({"message": "Invalid API path"}, status=404)

    async def post(self, request, path: str):
        """Handle POST requests."""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"message": "Invalid or missing JSON body"}, status=400)

        # Normalize path (remove leading/trailing slashes)
        path = path.strip('/')

        if path == "submit_url":
            url = data.get("url")
            resolutions = data.get("resolutions")
            playlist_id = data.get("playlist_id")
            if not url:
                return web.json_response({"message": "URL is required"}, status=400)
            if not resolutions:
                return web.json_response({"message": "Resolutions are required"}, status=400)
            return web.json_response(await self.coordinator.api_submit_url(url, resolutions, playlist_id))

        if path == "switch_resolution":
            resolution = data.get("resolution")
            item_type = data.get("type")
            item_id = data.get("id")
            if not all([resolution, item_type, item_id]):
                return web.json_response({"message": "Resolution, type, and id are required."}, status=400)
            await self.coordinator.api_switch_resolution(item_type, item_id, resolution)
            return web.json_response({"success": True})

        if path == "play_saved":
            video_id = data.get("video_id")
            if not video_id:
                return web.json_response({"message": "video_id is required"}, status=400)
            await self.coordinator.api_play_saved_video(video_id)
            return web.json_response({"success": True})

        if path == "playlists":
            name = data.get("name")
            url = data.get("url")
            try:
                created = await self.coordinator.api_add_playlist(name, url)
                return web.json_response(created)
            except Exception as e:
                return web.json_response({"message": str(e)}, status=400)

        if path == "playlists/update":
            playlist_id = data.get("id")
            name = data.get("name")
            url = data.get("url")
            try:
                updated = await self.coordinator.api_update_playlist(playlist_id, name, url)
                return web.json_response(updated)
            except Exception as e:
                return web.json_response({"message": str(e)}, status=400)

        if path == "m3u8_saved_streams":
            name = data.get("name")
            url = data.get("url")
            try:
                created = await self.coordinator.api_add_m3u8_saved_stream(name, url)
                return web.json_response(created)
            except Exception as e:
                return web.json_response({"message": str(e)}, status=400)

        if path == "update_quality":
            try:
                quality = data.get('quality')
                if quality is None:
                    return web.json_response({"success": False, "message": "Quality parameter is required"})
                
                quality = int(quality)
                if not 1 <= quality <= 31:
                    return web.json_response({"success": False, "message": "Quality must be between 1 and 31"})
                
                self.coordinator.set_mjpeg_quality(quality)
                return web.json_response({"success": True, "message": f"Quality updated to {quality}"})
            except Exception as e:
                return web.json_response({"success": False, "message": str(e)})

        if path == "update_fps":
            try:
                fps = data.get('fps')
                if fps is None:
                    return web.json_response({"success": False, "message": "FPS parameter is required"})
                
                fps = int(fps)
                if not MIN_STREAM_FPS <= fps <= MAX_STREAM_FPS:
                    return web.json_response({"success": False, "message": f"FPS must be between {MIN_STREAM_FPS} and {MAX_STREAM_FPS}"})
                
                self.coordinator.set_stream_fps(fps)
                return web.json_response({"success": True, "message": f"FPS updated to {fps}"})
            except Exception as e:
                return web.json_response({"success": False, "message": str(e)})

        if path == "update_m3u8_quality":
            try:
                quality = data.get('quality')
                if quality is None:
                    return web.json_response({"success": False, "message": "Quality parameter is required"})

                quality = int(quality)
                if not 1 <= quality <= 31:
                    return web.json_response({"success": False, "message": "Quality must be between 1 and 31"})

                self.coordinator.set_m3u8_mjpeg_quality(quality)
                return web.json_response({"success": True, "message": f"M3U8 quality updated to {quality}"})
            except Exception as e:
                return web.json_response({"success": False, "message": str(e)})

        if path == "update_m3u8_fps":
            try:
                fps = data.get('fps')
                if fps is None:
                    return web.json_response({"success": False, "message": "FPS parameter is required"})

                fps = int(fps)
                if not MIN_STREAM_FPS <= fps <= MAX_STREAM_FPS:
                    return web.json_response({"success": False, "message": f"FPS must be between {MIN_STREAM_FPS} and {MAX_STREAM_FPS}"})

                self.coordinator.set_m3u8_stream_fps(fps)
                return web.json_response({"success": True, "message": f"M3U8 FPS updated to {fps}"})
            except Exception as e:
                return web.json_response({"success": False, "message": str(e)})

        # go2rtc proxy endpoints
        if path == "go2rtc/streams":
            # Add stream to go2rtc
            stream_name = data.get('name')
            stream_urls = data.get('urls', [])
            if not stream_name or not stream_urls:
                return web.json_response({"error": "name and urls are required"}, status=400)
            
            # Log the stream details
            _LOGGER.info(f"Adding stream to go2rtc: name={stream_name}, urls={stream_urls}")
            
            # Detect stream format
            for url in stream_urls:
                url_lower = url.lower()
                if '.m3u8' in url_lower:
                    _LOGGER.info(f"Detected M3U8/HLS stream format: {url[:100]}...")
                elif '.m3u' in url_lower:
                    _LOGGER.info(f"Detected M3U playlist format: {url[:100]}...")
                elif 'rtsp://' in url_lower:
                    _LOGGER.info(f"Detected RTSP stream format: {url[:100]}...")
                elif 'youtube.com' in url_lower or 'youtu.be' in url_lower:
                    _LOGGER.info(f"Detected YouTube URL: {url[:100]}...")
                else:
                    _LOGGER.info(f"Unknown stream format: {url[:100]}...")
            
            # go2rtc API format: Use PUT with query parameters
            # For M3U8 streams, use simple ffmpeg: prefix for transcoding
            # For YouTube URLs, use ytdl: prefix to enable yt-dlp support
            # Get current FPS setting to apply to transcoding
            target_fps = self.coordinator.get_stream_fps()
            _LOGGER.info(f"Using target FPS for stream transcoding: {target_fps}")
            
            processed_urls = []
            
            for url in stream_urls:
                url_lower = url.lower()
                if '.m3u8' in url_lower or 'm3u8' in url_lower:
                    # Use simple ffmpeg: prefix for M3U8 transcoding to MJPEG (video only)
                    # Audio will be played directly from original M3U8 stream using hls.js in frontend
                    # Apply FPS setting at transcoding level for better performance
                    # Add input_flags=-re to read input at native frame rate (prevents fast transcoding/buffering)
                    ffmpeg_url = f"ffmpeg:{url}#video=mjpeg#video/fps={target_fps}#input_flags=-re"
                    _LOGGER.info(f"Using ffmpeg: prefix for M3U8 stream at {target_fps} FPS with real-time input: {url[:100]}...")
                    processed_urls.append(ffmpeg_url)
                elif 'youtube.com' in url_lower or 'youtu.be' in url_lower:
                    # Extract video stream URL from YouTube using yt-dlp
                    # Use MJPEG format for YouTube (HLS doesn't work well with separate audio/video)
                    try:
                        # Call external yt-dlp service (already async)
                        stream_urls_dict = await self._extract_youtube_stream_url(url)
                        video_url = stream_urls_dict['video_url']
                        audio_url = stream_urls_dict.get('audio_url')
                        detected_fps = stream_urls_dict.get('fps')
                        
                        # Use detected FPS from video metadata for proper sync with audio
                        # This ensures video plays at the same rate as audio
                        if detected_fps and isinstance(detected_fps, (int, float)) and detected_fps > 0:
                            youtube_fps = int(detected_fps)
                            _LOGGER.info(f"Using detected video FPS: {youtube_fps} for YouTube stream")
                        else:
                            youtube_fps = target_fps
                            _LOGGER.warning(f"Could not detect video FPS, using configured FPS: {youtube_fps}")
                        
                        # For YouTube, transcode to MJPEG for video (for main player compatibility)
                        # Audio will be handled separately in frontend via proxied direct stream
                        # Use detected FPS to maintain sync with audio
                        # Add input_flags=-re to read input at native frame rate (prevents fast transcoding/buffering)
                        ffmpeg_url = f"ffmpeg:{video_url}#video=mjpeg#video/fps={youtube_fps}#input_flags=-re"
                        _LOGGER.info(f"YouTube stream (will transcode to MJPEG at {youtube_fps} FPS with real-time input): {video_url[:100]}...")
                        processed_urls.append(ffmpeg_url)
                        
                        # Pass audio URL and FPS to frontend if available
                        if audio_url:
                            data['youtube_audio_url'] = audio_url
                            _LOGGER.info(f"YouTube audio URL will be proxied through backend")
                        else:
                            _LOGGER.warning("No separate audio stream found")
                        
                        # Pass detected FPS to frontend for proper frame timing
                        data['youtube_fps'] = youtube_fps
                        _LOGGER.info(f"Returning detected FPS to frontend: {youtube_fps}")
                        
                    except Exception as e:
                        _LOGGER.error(f"Failed to extract YouTube stream URL: {e}")
                        # Return error to user
                        return web.json_response({
                            "error": f"Failed to extract stream URL from YouTube video: {str(e)}"
                        }, status=400)
                else:
                    processed_urls.append(url)
            
            urls_param = " ".join(processed_urls)
            _LOGGER.debug(f"Sending to go2rtc: PUT {GO2RTC_BASE_URL}/api/streams?name={stream_name}&src={urls_param[:200]}...")
            
            async with ClientSession() as session:
                try:
                    # go2rtc API: PUT with query parameters
                    # Note: aiohttp's params will URL-encode, which is correct
                    # Add transcoding options to ensure MJPEG output works
                    # Use "copy" for video to let go2rtc handle transcoding automatically
                    async with session.put(
                        f"{GO2RTC_BASE_URL}/api/streams",
                        params={"name": stream_name, "src": urls_param},
                        timeout=ClientTimeout(total=60)  # Increased timeout for M3U8 streams to initialize
                    ) as resp:
                        response_text = await resp.text()
                        _LOGGER.info(f"go2rtc response: status={resp.status}, body={response_text[:200]}")
                        
                        if resp.status in (200, 201, 204):
                            _LOGGER.info(f"Successfully added stream '{stream_name}' to go2rtc")
                            # Store original URL(s) for seeking
                            for url in stream_urls:
                                # Store the first URL (original URL before processing)
                                self.coordinator._go2rtc_stream_urls[stream_name] = url
                                _LOGGER.info(f"Stored URL for stream '{stream_name}' in cache: {url[:100]}...")
                                break
                            response_data = {"success": True}
                            # Include audio URL if available (for YouTube streams)
                            if 'youtube_audio_url' in data:
                                response_data['youtube_audio_url'] = data['youtube_audio_url']
                                _LOGGER.info(f"Returning YouTube audio URL to frontend")
                            # Include detected FPS if available (for YouTube streams)
                            if 'youtube_fps' in data:
                                response_data['youtube_fps'] = data['youtube_fps']
                                _LOGGER.info(f"Returning YouTube FPS to frontend: {data['youtube_fps']}")
                            return web.json_response(response_data)
                        else:
                            _LOGGER.error(f"go2rtc returned error: {resp.status} - {response_text}")
                            # Return the actual error message from go2rtc
                            return web.json_response({"error": response_text}, status=resp.status)
                except Exception as e:
                    error_msg = str(e)
                    _LOGGER.error(f"Error proxying go2rtc stream add to {GO2RTC_BASE_URL}: {e}", exc_info=True)
                    # Provide more helpful error message
                    if "Connect" in error_msg or "Connection" in error_msg:
                        return web.json_response({
                            "error": f"Cannot connect to go2rtc at {GO2RTC_BASE_URL}. Make sure go2rtc is running and accessible."
                        }, status=500)
                    return web.json_response({"error": error_msg}, status=500)

        return web.json_response({"message": "Invalid API path"}, status=404)

    async def delete(self, request, path: str):
        """Handle DELETE requests."""
        # Normalize path (remove leading/trailing slashes)
        path = path.strip('/')
        
        if path.startswith("delete_saved/"):
            video_id = path.split("/")[-1]
            return self.json(await self.coordinator.api_delete_saved_video(video_id))
        elif path == "delete_all_saved":
            filter_value = request.query.get("filter", "all")
            return self.json(await self.coordinator.api_delete_saved_videos_by_filter(filter_value))
        elif path.startswith("playlists/"):
            playlist_id = path.split("/")[-1]
            try:
                result = await self.coordinator.api_delete_playlist(playlist_id)
                return self.json(result)
            except Exception as e:
                return self.json({"success": False, "message": str(e)}, status_code=400)
        elif path.startswith("m3u8_saved_streams/"):
            stream_id = path.split("/")[-1]
            try:
                result = await self.coordinator.api_delete_m3u8_saved_stream(stream_id)
                return self.json(result)
            except Exception as e:
                return self.json({"success": False, "message": str(e)}, status_code=400)
        
        # go2rtc proxy endpoints
        elif path.startswith("go2rtc/streams/"):
            # Delete stream from go2rtc - stream name is in the path
            stream_name = path.split("go2rtc/streams/")[-1]
            if not stream_name:
                return self.json({"error": "stream name is required"}, status_code=400)
            
            async with ClientSession() as session:
                try:
                    async with session.delete(f"{GO2RTC_BASE_URL}/api/streams?src={stream_name}") as resp:
                        if resp.status == 200:
                            # Clean up cached URL
                            self.coordinator._go2rtc_stream_urls.pop(stream_name, None)
                            return self.json({"success": True})
                        else:
                            error_text = await resp.text()
                            return self.json({"error": error_text}, status_code=resp.status)
                except Exception as e:
                    _LOGGER.error(f"Error proxying go2rtc stream delete: {e}")
                    return self.json({"error": str(e)}, status_code=500)
            
        return self.json({"message": "Invalid API path"}, status_code=404)


class YTStreamerMediaView(HomeAssistantView):
    """API View for public media stream URLs."""
    url = "/api/yt_streamer/{path:.*}"
    name = "api:yt_streamer:media"
    requires_auth = False

    def __init__(self, coordinator: YTStreamerCoordinator):
        self.coordinator = coordinator
        self.ffmpeg = get_ffmpeg_manager(coordinator.hass)

    async def _stream_ffmpeg_mjpeg(
        self,
        request,
        ffmpeg_cmd: list[str],
        log_label: str,
        target_fps: int | None = None,
    ):
        """Run FFmpeg and stream its MJPEG output as a multipart response."""
        response = web.StreamResponse(
            status=200,
            reason='OK',
            headers={
                'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        )
        await response.prepare(request)

        process = await asyncio.create_subprocess_exec(
            *ffmpeg_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        _LOGGER.info(f"{log_label}: started FFmpeg process PID {process.pid}")

        async def log_stderr():
            while not process.stderr.at_eof():
                line = await process.stderr.readline()
                if not line:
                    break
                _LOGGER.debug(f"{log_label} stderr: {line.decode(errors='ignore').strip()}")

        stderr_logger_task = asyncio.create_task(log_stderr())
        frame_buffer = b''
        frame_count = 0
        frame_duration = (1.0 / target_fps) if target_fps and target_fps > 0 else None
        last_frame_time = asyncio.get_event_loop().time()

        try:
            while True:
                chunk = await process.stdout.read(4096)
                if not chunk:
                    _LOGGER.info(f"{log_label}: FFmpeg provided no more output")
                    break

                frame_buffer += chunk

                while True:
                    start = frame_buffer.find(b'\xff\xd8')
                    end = frame_buffer.find(b'\xff\xd9', start)
                    if start == -1 or end == -1 or end < start:
                        break

                    frame = frame_buffer[start:end + 2]
                    frame_buffer = frame_buffer[end + 2:]
                    if frame_duration is not None:
                        current_time = asyncio.get_event_loop().time()
                        time_since_last_frame = current_time - last_frame_time
                        if time_since_last_frame < frame_duration:
                            await asyncio.sleep(frame_duration - time_since_last_frame)

                    frame_data = (
                        b'--frame\r\n'
                        b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n'
                    )
                    await response.write(frame_data)
                    frame_count += 1
                    if frame_duration is not None:
                        last_frame_time = asyncio.get_event_loop().time()

            _LOGGER.info(f"{log_label}: finished after sending {frame_count} frames")
        except (asyncio.CancelledError, ConnectionResetError, BrokenPipeError) as exc:
            _LOGGER.info(f"{log_label}: stream closed by client ({type(exc).__name__})")
        except Exception as exc:
            _LOGGER.error(f"{log_label}: error while streaming MJPEG: {exc}", exc_info=True)
        finally:
            if process.returncode is None:
                try:
                    process.terminate()
                    await asyncio.wait_for(process.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    _LOGGER.warning(f"{log_label}: FFmpeg did not terminate in time, killing")
                    process.kill()
                    await process.wait()
                except Exception as exc:
                    _LOGGER.warning(f"{log_label}: error while terminating FFmpeg: {exc}")
                    process.kill()
                    await process.wait()

            stderr_logger_task.cancel()
            try:
                await stderr_logger_task
            except asyncio.CancelledError:
                pass

            try:
                await response.write_eof()
            except Exception:
                pass

        return response

    async def _handle_mjpeg_seek(self, request, stream_name: str, timestamp: float, target_fps: int, quality: int):
        """Handle MJPEG stream seeking using FFmpeg with timestamp."""
        try:
            # Get original URL from coordinator cache
            original_url = self.coordinator._go2rtc_stream_urls.get(stream_name)
            _LOGGER.info(f"Cache lookup for stream '{stream_name}': {'FOUND' if original_url else 'NOT FOUND'}")
            
            # If not in cache, try to get from go2rtc (may fail)
            if not original_url:
                try:
                    async with ClientSession() as session:
                        async with session.get(f"{GO2RTC_BASE_URL}/api/streams/{stream_name}") as resp:
                            if resp.status == 200:
                                stream_info = await resp.json()
                                _LOGGER.info(f"Stream info for {stream_name}: {stream_info}")
                                producers = stream_info.get('producers', [])
                                if producers and len(producers) > 0:
                                    producer = producers[0]
                                    original_url = producer.get('url') or (producer.get('urls', [None])[0] if producer.get('urls') else None)
                except Exception as e:
                    _LOGGER.debug(f"Could not get stream info from go2rtc: {e}")
            
            if not original_url:
                _LOGGER.error(f"Could not find source URL for stream {stream_name} (not in cache and go2rtc API unavailable)")
                return web.Response(text=f"Stream source URL not available for seeking: {stream_name}", status=404)
            
            _LOGGER.info(f"Source URL for {stream_name}: {original_url[:100]}...")
            
            # Check if it's a YouTube URL - if so, extract video URL
            video_url = original_url
            if 'youtube.com' in original_url or 'youtu.be' in original_url:
                try:
                    # Extract YouTube video URL using yt-dlp service
                    async with ClientSession() as yt_session:
                        async with yt_session.post(
                            f"{YTDLP_SERVICE_URL}/extract",
                            json={"url": original_url, "max_height": 720},
                            timeout=ClientTimeout(total=30)
                        ) as yt_resp:
                            if yt_resp.status != 200:
                                error_text = await yt_resp.text()
                                _LOGGER.error(f"yt-dlp service error: {yt_resp.status} - {error_text}")
                                return web.Response(text=f"Error extracting YouTube URL: {error_text}", status=500)
                            
                            result = await yt_resp.json()
                            video_url = result.get('video_url')
                            if not video_url:
                                return web.Response(text="yt-dlp service did not return a video URL", status=500)
                            
                            _LOGGER.info(f"Extracted YouTube video URL for seeking: {video_url[:100]}...")
                except Exception as e:
                    _LOGGER.error(f"Error extracting YouTube URL: {e}", exc_info=True)
                    return web.Response(text=f"Error extracting YouTube URL: {str(e)}", status=500)
            
            # Use FFmpeg to transcode with seeking
            ffmpeg_cmd = [
                self.ffmpeg.binary,
                "-ss", str(timestamp),  # Seek to timestamp
                "-re",  # Read input at native frame rate
                "-i", video_url,  # Input URL
                "-f", "mjpeg",  # Output format
                "-q:v", str(quality),  # Quality
                "-vf", f"fps={target_fps}",  # Frame rate filter
                "-"  # Output to stdout
            ]
            
            _LOGGER.info(f"FFmpeg seek command: {' '.join(ffmpeg_cmd[:8])}... (seeking to {timestamp}s)")
            return await self._stream_ffmpeg_mjpeg(
                request,
                ffmpeg_cmd,
                f"MJPEG seek stream for {stream_name}",
                target_fps=target_fps,
            )
                    
        except Exception as e:
            _LOGGER.error(f"Error in MJPEG seek handler: {e}", exc_info=True)
            return web.Response(text=f"Seek error: {str(e)}", status=500)

    async def get(self, request, path: str):
        """Handle GET requests for media."""
        hass: HomeAssistant = request.app["hass"]

        if path.startswith("stream/"):
            try:
                # Parse path and query parameters
                parts = path.split('/')
                if len(parts) < 4:
                    return web.Response(text="Invalid stream path format", status=400)
                
                stream_type = parts[1]
                item_id = parts[2]
                resolution = int(parts[3])
                
                # Get timestamp from query parameters if present
                timestamp = None
                if 'timestamp' in request.query:
                    try:
                        timestamp = float(request.query['timestamp'])
                    except ValueError:
                        return web.Response(text="Invalid timestamp parameter", status=400)

                # Get quality from query parameters if present
                quality = None
                if 'quality' in request.query:
                    try:
                        quality = int(request.query['quality'])
                    except ValueError:
                        return web.Response(text="Invalid quality parameter", status=400)

                response = web.StreamResponse(
                    status=200, reason='OK',
                    headers={'Content-Type': 'multipart/x-mixed-replace; boundary=frame'}
                )
                await response.prepare(request)

                try:
                    # Pass timestamp and quality to the generator
                    async for frame in self.coordinator._mjpeg_generator(stream_type, item_id, resolution, quality, timestamp):
                        await response.write(frame)
                    await response.write_eof()
                    return response
                except Exception as e:
                    _LOGGER.error(f"Error during MJPEG stream for {path}: {e}", exc_info=True)
                    if not response.prepared:
                        return web.Response(text=f"Stream error: {str(e)}", status=500)
                    # If response is already prepared, we need to close it properly
                    try:
                        await response.write_eof()
                    except Exception:
                        pass
                    return response

            except ValueError as e:
                return web.Response(text=f"Invalid parameters: {str(e)}", status=400)
            except Exception as e:
                _LOGGER.error(f"Unexpected error in stream handler: {e}", exc_info=True)
                return web.Response(text=f"Server error: {str(e)}", status=500)

        elif path.startswith("audio/"):
            try:
                # Audio path doesn't need resolution
                _, stream_type, item_id = path.split('/')
            except ValueError:
                return web.Response(text="Invalid audio URL format", status=400)

            audio_path = self.coordinator.get_audio_path(stream_type, item_id)
            if audio_path and os.path.exists(audio_path):
                return web.FileResponse(audio_path, headers={"Content-Type": "audio/mp3"})

        elif path.startswith("go2rtc/stream.m3u8"):
            # Proxy HLS stream from go2rtc
            stream_name = request.query.get('src')
            playlist_id = request.query.get('playlist')
            
            if not stream_name:
                return web.Response(text="src parameter is required", status=400)
            
            # If playlist ID is provided, proxy the actual playlist segment
            if playlist_id:
                # Proxy the playlist segment directly from go2rtc
                playlist_url = f"{GO2RTC_BASE_URL}/hls/{playlist_id}"
                _LOGGER.info(f"Proxying HLS playlist segment: {playlist_id}, go2rtc URL: {playlist_url}")
                
                async with ClientSession() as session:
                    try:
                        async with session.get(playlist_url, timeout=ClientTimeout(total=60)) as resp:
                            _LOGGER.info(f"HLS playlist segment response status: {resp.status}, content-type: {resp.headers.get('Content-Type', 'unknown')}")
                            
                            if resp.status != 200:
                                error_text = await resp.text()
                                _LOGGER.error(f"go2rtc HLS playlist error: {resp.status} - {error_text[:200]}")
                                return web.Response(text=f"go2rtc error: {resp.status}", status=resp.status)
                            
                            # Stream the playlist content directly
                            content = await resp.read()
                            content_type = resp.headers.get('Content-Type', 'application/vnd.apple.mpegurl')
                            _LOGGER.debug(f"Proxied HLS playlist segment: {len(content)} bytes, content-type: {content_type}")
                            
                            return web.Response(
                                body=content,
                                content_type=content_type,
                                headers={
                                    'Cache-Control': 'no-cache',
                                    'Pragma': 'no-cache',
                                    'Access-Control-Allow-Origin': '*'
                                }
                            )
                    except Exception as e:
                        _LOGGER.error(f"Error proxying go2rtc HLS playlist: {e}", exc_info=True)
                        return web.Response(text=f"Proxy error: {str(e)}", status=500)
            else:
                # Proxy the main HLS playlist
                hls_url = f"{GO2RTC_BASE_URL}/api/stream.m3u8?src={stream_name}"
                _LOGGER.info(f"Proxying HLS stream from go2rtc: {stream_name}, go2rtc URL: {hls_url}")
                
                async with ClientSession() as session:
                    try:
                        async with session.get(hls_url, timeout=ClientTimeout(total=60)) as resp:
                            _LOGGER.info(f"HLS stream response status: {resp.status}, content-type: {resp.headers.get('Content-Type', 'unknown')}")
                            
                            if resp.status != 200:
                                error_text = await resp.text()
                                _LOGGER.error(f"go2rtc HLS error: {resp.status} - {error_text[:200]}")
                                return web.Response(text=f"go2rtc error: {resp.status} - {error_text[:200]}", status=resp.status)
                            
                            # Get the HLS playlist content
                            playlist_content = await resp.text()
                            content_length = len(playlist_content)
                            _LOGGER.info(f"Received HLS playlist: {content_length} bytes, first 500 chars: {repr(playlist_content[:500])}")
                            
                            # Check if playlist is empty
                            if not playlist_content or content_length == 0:
                                _LOGGER.warning(f"Empty HLS playlist received from go2rtc for stream {stream_name}. Stream may not be ready yet.")
                                # Return 204 No Content instead of error playlist
                                return web.Response(
                                    status=204,
                                    headers={
                                        'Cache-Control': 'no-cache',
                                        'Pragma': 'no-cache',
                                        'Access-Control-Allow-Origin': '*'
                                    }
                                )
                            
                            # Replace relative URLs in the playlist with absolute URLs pointing back through our proxy
                            # go2rtc returns relative URLs like "hls/playlist.m3u8?id=xxx"
                            # We need to make them absolute URLs through our proxy
                            import re
                            from urllib.parse import urlparse, urlunparse
                            
                            # Get the base URL for the proxy - construct it from the request
                            scheme = request.scheme
                            host = request.host
                            request_path = request.path

                            # Build the base proxy URL
                            base_proxy_url = f"{scheme}://{host}{request_path}"
                            _LOGGER.info(f"Base proxy URL: {base_proxy_url}")
                            
                            # Replace relative hls/ URLs with our proxy URL
                            original_content = playlist_content
                            playlist_content = re.sub(
                                r'hls/([^\s\n]+)',
                                lambda m: f"{base_proxy_url}?src={stream_name}&playlist={m.group(1)}",
                                playlist_content
                            )
                            
                            if playlist_content != original_content:
                                _LOGGER.info(f"Rewrote playlist URLs. Original (first 200): {repr(original_content[:200])}, Rewritten (first 200): {repr(playlist_content[:200])}")
                            else:
                                _LOGGER.warning(f"No URLs were rewritten in playlist. Content: {repr(playlist_content[:200])}")
                            
                            return web.Response(
                                text=playlist_content,
                                content_type='application/vnd.apple.mpegurl',
                                headers={
                                    'Cache-Control': 'no-cache',
                                    'Pragma': 'no-cache',
                                    'Access-Control-Allow-Origin': '*'
                                }
                            )
                    except Exception as e:
                        _LOGGER.error(f"Error proxying go2rtc HLS stream: {e}", exc_info=True)
                        return web.Response(text=f"Proxy error: {str(e)}", status=500)
        
        elif path.startswith("go2rtc/stream.mjpeg"):
            # Proxy MJPEG stream from go2rtc with frame rate control and optional timestamp seeking
            stream_name = request.query.get('src')
            if not stream_name:
                return web.Response(text="src parameter is required", status=400)
            
            # Get timestamp parameter for seeking
            timestamp_param = request.query.get('timestamp')
            timestamp = None
            if timestamp_param:
                try:
                    timestamp = float(timestamp_param)
                    _LOGGER.info(f"Timestamp seek requested: {timestamp} seconds")
                except (ValueError, TypeError):
                    _LOGGER.warning(f"Invalid timestamp parameter: {timestamp_param}")
            
            # Get FPS from query parameter or fall back to dedicated M3U8 settings.
            fps_param = request.query.get('fps')
            if fps_param:
                try:
                    target_fps = int(fps_param)
                    _LOGGER.info(f"Using FPS from query parameter: {target_fps}")
                except (ValueError, TypeError):
                    target_fps = self.coordinator.get_m3u8_stream_fps()
                    _LOGGER.warning(f"Invalid FPS parameter, using M3U8 setting: {target_fps}")
            else:
                target_fps = self.coordinator.get_m3u8_stream_fps()
                _LOGGER.info(f"No FPS parameter, using M3U8 setting: {target_fps}")

            # Get quality from query parameter or fall back to dedicated M3U8 settings.
            quality_param = request.query.get('quality')
            if quality_param:
                try:
                    quality = int(quality_param)
                    _LOGGER.info(f"Using quality from query parameter: {quality}")
                except (ValueError, TypeError):
                    quality = self.coordinator.get_m3u8_mjpeg_quality()
                    _LOGGER.warning(f"Invalid quality parameter, using M3U8 setting: {quality}")
            else:
                quality = self.coordinator.get_m3u8_mjpeg_quality()
                _LOGGER.info(f"No quality parameter, using M3U8 setting: {quality}")

            # If timestamp is provided, use FFmpeg-based seeking from the original source.
            if timestamp is not None and timestamp > 0:
                return await self._handle_mjpeg_seek(request, stream_name, timestamp, target_fps, quality)

            source_mjpeg_url = f"{GO2RTC_BASE_URL}/api/stream.mjpeg?src={stream_name}"
            ffmpeg_cmd = [
                self.ffmpeg.binary,
                "-fflags", "nobuffer",
                "-i", source_mjpeg_url,
                "-f", "mjpeg",
                "-q:v", str(quality),
                "-vf", f"fps={target_fps}",
                "-"
            ]

            _LOGGER.info(
                f"Proxying MJPEG stream from go2rtc: {stream_name} at {target_fps} FPS with quality {quality}"
            )
            return await self._stream_ffmpeg_mjpeg(
                request,
                ffmpeg_cmd,
                f"go2rtc MJPEG stream for {stream_name}",
                target_fps=target_fps,
            )
        
        elif path.startswith("go2rtc/stream.mp3"):
            # Proxy MP3 audio stream from go2rtc (for M3U8 audio)
            stream_name = request.query.get('src')
            if not stream_name:
                return web.Response(text="src parameter is required", status=400)
            
            # Use go2rtc's MP3 endpoint which extracts and transcodes audio
            mp3_url = f"{GO2RTC_BASE_URL}/api/stream.mp3?src={stream_name}"
            _LOGGER.info(f"Proxying MP3 audio stream from go2rtc: {stream_name}")
            
            async with ClientSession() as session:
                try:
                    async with session.get(mp3_url, timeout=None) as resp:
                        if resp.status != 200:
                            error_text = await resp.text()
                            _LOGGER.error(f"go2rtc MP3 error: {resp.status} - {error_text[:200]}")
                            return web.Response(text=f"go2rtc error: {resp.status} - {error_text[:200]}", status=resp.status)
                        
                        # Create streaming response for audio
                        response = web.StreamResponse(
                            status=200,
                            reason='OK',
                            headers={
                                'Content-Type': 'audio/mpeg',
                                'Cache-Control': 'no-cache',
                                'Accept-Ranges': 'none'
                            }
                        )
                        await response.prepare(request)
                        
                        # Stream audio data directly from go2rtc
                        chunk_count = 0
                        total_bytes = 0
                        
                        try:
                            while True:
                                chunk = await resp.content.read(8192)
                                if not chunk:
                                    break
                                
                                chunk_count += 1
                                total_bytes += len(chunk)
                                await response.write(chunk)
                                
                                if chunk_count % 100 == 0:
                                    _LOGGER.debug(f"MP3 audio progress: {chunk_count} chunks, {total_bytes} bytes ({total_bytes/1024/1024:.2f} MB)")
                        
                        except Exception as stream_error:
                            _LOGGER.warning(f"MP3 audio stream ended: {stream_error} (sent {chunk_count} chunks, {total_bytes} bytes)")
                        finally:
                            try:
                                await response.write_eof()
                            except Exception:
                                pass
                        
                        _LOGGER.info(f"Finished proxying MP3 audio for {stream_name}: {chunk_count} chunks, {total_bytes} bytes ({total_bytes/1024/1024:.2f} MB)")
                        return response
                        
                except Exception as e:
                    _LOGGER.error(f"Error proxying go2rtc MP3 stream: {e}", exc_info=True)
                    return web.Response(text=f"Proxy error: {str(e)}", status=500)
        
        elif path.startswith("youtube/audio"):
            # Proxy YouTube audio streams (both HLS manifests and direct MP4 downloads)
            audio_url = request.query.get('url')
            if not audio_url:
                return web.Response(text="url parameter is required", status=400)
            
            _LOGGER.info(f"Proxying YouTube audio stream: {audio_url[:100]}...")
            
            async with ClientSession() as session:
                try:
                    async with session.get(audio_url, timeout=ClientTimeout(total=30)) as resp:
                        if resp.status != 200:
                            error_text = await resp.text()
                            _LOGGER.error(f"YouTube audio error: {resp.status} - {error_text[:200]}")
                            return web.Response(text=f"Error: {resp.status}", status=resp.status)
                        
                        content_type = resp.headers.get('Content-Type', 'application/octet-stream')
                        
                        # Check if this is an HLS manifest (text) or direct download (binary)
                        if 'application/vnd.apple.mpegurl' in content_type or content_type == 'text/plain':
                            # HLS manifest - read as text and rewrite URLs
                            _LOGGER.debug(f"Proxying HLS manifest (Content-Type: {content_type})")
                            content = await resp.text()
                            
                            # Rewrite relative URLs to absolute URLs via our proxy
                            import re
                            from urllib.parse import urljoin, quote
                            
                            # Match segment URLs (both relative and absolute)
                            def rewrite_url(match):
                                segment_url = match.group(1)
                                if segment_url.startswith('http'):
                                    # Absolute URL - encode it and proxy it
                                    return match.group(0).replace(segment_url, f"/api/yt_streamer/youtube/audio?url={quote(segment_url, safe='')}")
                                else:
                                    # Relative URL - construct absolute URL
                                    absolute_url = urljoin(audio_url, segment_url)
                                    return match.group(0).replace(segment_url, f"/api/yt_streamer/youtube/audio?url={quote(absolute_url, safe='')}")
                            
                            # Rewrite URLs in the manifest (both #EXTINF lines and direct URLs)
                            content = re.sub(r'(https?://[^\s\n]+)', rewrite_url, content)
                            content = re.sub(r'^([^#\n]+\.(ts|m4s|aac|mp4))', rewrite_url, content, flags=re.MULTILINE)
                            
                            return web.Response(text=content, content_type=content_type, headers={
                                'Access-Control-Allow-Origin': '*',
                                'Cache-Control': 'no-cache'
                            })
                        else:
                            # Direct download (MP4, MP3, etc.) - stream binary data
                            _LOGGER.debug(f"Proxying direct download stream (Content-Type: {content_type})")
                            
                            # Stream the binary content
                            response = web.StreamResponse(
                                status=200,
                                reason='OK',
                                headers={
                                    'Content-Type': content_type,
                                    'Access-Control-Allow-Origin': '*',
                                    'Accept-Ranges': 'bytes',
                                }
                            )
                            
                            # Forward Content-Length if available
                            if 'Content-Length' in resp.headers:
                                response.headers['Content-Length'] = resp.headers['Content-Length']
                            
                            await response.prepare(request)
                            
                            # Stream chunks
                            async for chunk in resp.content.iter_chunked(8192):
                                await response.write(chunk)
                            
                            await response.write_eof()
                            return response
                        
                except Exception as e:
                    _LOGGER.error(f"Error proxying YouTube audio: {e}", exc_info=True)
                    return web.Response(text=f"Proxy error: {str(e)}", status=500)

        return web.Response(text="Invalid media path", status=404)
