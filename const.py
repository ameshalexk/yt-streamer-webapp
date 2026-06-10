"""Constants for the YT Streamer integration."""

# The domain of your integration. Should be unique.
DOMAIN = "yt_streamer"

# Name of the directory inside /config where media will be stored.
SAVED_MEDIA_DIR_NAME = "yt_streamer_library"


# --- Configuration Constants ---

# Set the MAXIMUM video height to download. To enable 720p, this must be 720.
# Valid values: 240, 360, 480, 720
MAX_VIDEO_HEIGHT = 720

# Supported resolutions for video downloads in descending order
# These should match the available YouTube video qualities
SUPPORTED_RESOLUTIONS = [720, 480, 360, 240]

# MJPEG Stream Quality. A value from 1 to 31.
# Lower is higher quality. 2-5 is a good range for high quality.
# 31 is the lowest quality, 1 is the highest quality
MJPEG_QUALITY = 1

# Leave at 0 to use the original video's width and height for the stream.
# Set to a specific value to force a particular resolution
MJPEG_STREAM_WIDTH = 0
MJPEG_STREAM_HEIGHT = 0

# Stream FPS Settings
# These control the frame rate of the video stream
MIN_STREAM_FPS = 5  # Minimum allowed FPS
MAX_STREAM_FPS = 30  # Maximum allowed FPS


# --- Service Names ---
SERVICE_DOWNLOAD_URL = "download_url"
SERVICE_PLAY_SAVED = "play_saved"
SERVICE_DELETE_SAVED = "delete_saved"
SERVICE_STOP_PLAYBACK = "stop_playback"

# --- Camera Entity ---
CAMERA_ENTITY_ID = "camera.yt_streamer_live_view"

# --- Validation ---
def validate_constants():
    """Validate that constants are within acceptable ranges."""
    if MAX_VIDEO_HEIGHT not in SUPPORTED_RESOLUTIONS:
        raise ValueError(f"MAX_VIDEO_HEIGHT must be one of {SUPPORTED_RESOLUTIONS}")
    if not 1 <= MJPEG_QUALITY <= 31:
        raise ValueError("MJPEG_QUALITY must be between 1 and 31")
    if not MIN_STREAM_FPS <= MAX_STREAM_FPS:
        raise ValueError(f"MAX_STREAM_FPS must be greater than or equal to MIN_STREAM_FPS ({MIN_STREAM_FPS})")
    if MJPEG_STREAM_WIDTH < 0 or MJPEG_STREAM_HEIGHT < 0:
        raise ValueError("MJPEG_STREAM_WIDTH and MJPEG_STREAM_HEIGHT must be >= 0")

# Run validation on module import
validate_constants()