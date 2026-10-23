"""Apply Supervisor options, then replace this process with the shared server."""
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

SETTINGS = {
    "max_streams": ("MAX_STREAMS", 1, {1, 2, 3}),
    "mjpeg_fps": ("MJPEG_FPS", 12, set(range(3, 31))),
    "mjpeg_height": ("MJPEG_HEIGHT", 480, {240, 360, 480, 720}),
    "download_max_height": ("DL_MAX_HEIGHT", 480, {240, 360, 480, 720}),
}

ACCESS_OPTIONS = {
    "access_control_origin": "CAST_CONTROL_ORIGIN",
    "access_issuer": "CAST_ACCESS_ISSUER",
    "access_audience": "CAST_ACCESS_AUDIENCE",
}


def _origin(value, *, issuer=False):
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != "https" or not parsed.hostname or
                parsed.username or parsed.password or parsed.port or
                parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            raise ValueError("Invalid HTTPS origin")
        if issuer and not parsed.hostname.endswith(".cloudflareaccess.com"):
            raise ValueError("Issuer must be a Cloudflare Access team hostname")
    except (ValueError, TypeError):
        raise SystemExit("APNE Access origin/issuer must be HTTPS origins with no path or credentials")
    return parsed.scheme + "://" + parsed.hostname


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

    access = {key: options.get(key, "") for key in ACCESS_OPTIONS}
    if not all(isinstance(value, str) for value in access.values()):
        raise SystemExit("APNE Access options must be strings")
    if any(access.values()):
        if not all(access.values()):
            raise SystemExit("Configure all three APNE Access options together")
        origin = _origin(access["access_control_origin"])
        issuer = _origin(access["access_issuer"], issuer=True)
        audience = access["access_audience"]
        if not re.fullmatch(r"[A-Za-z0-9_-]{20,}", audience):
            raise SystemExit("APNE Access audience must be a Cloudflare Access application AUD")
        os.environ["CAST_CONTROL_ORIGIN"] = origin
        os.environ["CAST_ACCESS_ISSUER"] = issuer
        os.environ["CAST_ACCESS_AUDIENCE"] = audience


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
