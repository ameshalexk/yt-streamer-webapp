"""Apply Supervisor options, then replace this process with the shared server."""
import json
import os
from pathlib import Path

SETTINGS = {
    "max_streams": ("MAX_STREAMS", 1, {1, 2, 3}),
    "mjpeg_fps": ("MJPEG_FPS", 12, set(range(3, 31))),
    "mjpeg_height": ("MJPEG_HEIGHT", 480, {240, 360, 480, 720}),
    "download_max_height": ("DL_MAX_HEIGHT", 480, {240, 360, 480, 720}),
}


def apply_options(options):
    """Validate Supervisor values and export the app's environment settings."""
    for key, (variable, default, allowed) in SETTINGS.items():
        value = options.get(key, default)
        # HA's list selector serializes its values as strings.
        if isinstance(value, str) and value.isdecimal():
            value = int(value)
        if type(value) is not int or value not in allowed:
            raise SystemExit(f"Invalid {key}: expected one of {sorted(allowed)}")
        os.environ[variable] = str(value)


def main():
    options_file = Path("/data/options.json")
    options = json.loads(options_file.read_text()) if options_file.exists() else {}
    apply_options(options)

    for variable in ("DATA_DIR", "LIBRARY_DIR", "APNE_ICLOUD_DIR"):
        Path(os.environ[variable]).mkdir(parents=True, exist_ok=True)

    os.chdir("/app")
    os.execvp("node", ["node", "src/server.js"])


if __name__ == "__main__":
    main()
