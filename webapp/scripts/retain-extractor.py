#!/usr/bin/env python3
"""Install, playback-canary, and retain one pinned yt-dlp fallback executable."""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import stat
import subprocess
import sys
import threading
import urllib.parse
import venv
from pathlib import Path


PLAYBACK_FORMAT = "bestvideo[height<=480]+bestaudio/best"
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
PIPE_CAPTURE_LIMIT = 64 * 1024
CANARY_CAPTURE_LIMIT = 8 * 1024 * 1024


class RetainError(RuntimeError):
    pass


def validate_version(value: str) -> str:
    if not re.fullmatch(r"\d{4}\.\d{2}\.\d{2}(?:\.post\d+)?", value):
        raise RetainError("version must be an exact dated yt-dlp release")
    return value


def validate_test_url(value: str) -> str:
    if not value or len(value) > 2048 or value != value.strip() or "#" in value:
        raise RetainError("test URL is invalid")
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise RetainError("test URL is invalid") from exc
    if (parsed.scheme != "https" or (parsed.hostname or "").lower() not in YOUTUBE_HOSTS
            or parsed.username or parsed.password or port):
        raise RetainError("test URL must be HTTPS on a supported YouTube host")
    return value


def selected_video_url(info: dict) -> str | None:
    requested = info.get("requested_formats")
    if isinstance(requested, list) and requested:
        video = next((item for item in requested if isinstance(item, dict)
                      and item.get("vcodec") not in (None, "", "none")), None)
        candidate = video.get("url") if video else None
    else:
        candidate = info.get("url")
    return candidate.strip() if isinstance(candidate, str) and candidate.strip() else None


def _bounded_reader(pipe, limit: int, output: bytearray, overflow: list[bool]) -> None:
    while True:
        chunk = pipe.read(8192)
        if not chunk:
            return
        remaining = limit - len(output)
        if remaining > 0:
            output.extend(chunk[:remaining])
        if len(chunk) > max(remaining, 0):
            overflow[0] = True


def run_bounded(command: list[str], *, timeout: int, capture_limit: int,
                env: dict[str, str] | None = None) -> tuple[int, str, str]:
    try:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=env, start_new_session=True)
    except OSError as exc:
        raise RetainError(f"could not start {Path(command[0]).name}: {exc.__class__.__name__}") from exc
    stdout = bytearray()
    stderr = bytearray()
    # Each reader needs a mutable flag shared with the caller.
    flags = [[False], [False]]
    readers = [
        threading.Thread(target=_bounded_reader, args=(process.stdout, capture_limit, stdout, flags[0]), daemon=True),
        threading.Thread(target=_bounded_reader, args=(process.stderr, capture_limit, stderr, flags[1]), daemon=True),
    ]
    for reader in readers:
        reader.start()
    try:
        code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        for reader in readers:
            reader.join()
        process.stdout.close()
        process.stderr.close()
        raise RetainError(f"{Path(command[0]).name} timed out") from exc
    for reader in readers:
        reader.join()
    process.stdout.close()
    process.stderr.close()
    if any(flag[0] for flag in flags):
        raise RetainError(f"{Path(command[0]).name} output exceeded capture limit")
    return code, stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace")


def _require_success(command: list[str], *, timeout: int, capture_limit: int,
                     env: dict[str, str] | None = None) -> str:
    code, stdout, stderr = run_bounded(command, timeout=timeout, capture_limit=capture_limit, env=env)
    if code != 0:
        detail = (stderr or stdout).strip()
        detail = re.sub(r"https?://[^\s\])}>'\"]+", "[URL redacted]", detail)
        detail = detail[-2000:]
        raise RetainError(detail or f"{Path(command[0]).name} exited with status {code}")
    return stdout.strip()


def activate_backup_symlink(data_dir: Path, version_dir: Path) -> Path:
    data_dir = data_dir.resolve()
    extractors_dir = (data_dir / "extractors").resolve()
    version_dir = version_dir.resolve(strict=True)
    executable = version_dir / "bin" / "yt-dlp"
    if version_dir.parent != extractors_dir or not executable.is_file() or not os.access(executable, os.X_OK):
        raise RetainError("versioned extractor is not inside this data directory")

    destination = data_dir / "extractor-backup"
    if os.path.lexists(destination) and not stat.S_ISLNK(destination.lstat().st_mode):
        raise RetainError("refusing to overwrite a real file or directory at extractor-backup")

    temporary = data_dir / f".extractor-backup.{os.getpid()}.{threading.get_ident()}"
    if os.path.lexists(temporary):
        raise RetainError("temporary backup link path already exists")
    relative_target = os.path.relpath(version_dir, data_dir)
    os.symlink(relative_target, temporary)
    try:
        if os.path.lexists(destination) and not stat.S_ISLNK(destination.lstat().st_mode):
            raise RetainError("refusing to overwrite a real file or directory at extractor-backup")
        os.replace(temporary, destination)
    finally:
        if os.path.lexists(temporary):
            temporary.unlink()
    return destination / "bin" / "yt-dlp"


def _pip_environment() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith("PIP_")}
    env["PIP_CONFIG_FILE"] = os.devnull
    env["PIP_INDEX_URL"] = "https://pypi.org/simple"
    env["PIP_EXTRA_INDEX_URL"] = ""
    return env


def retain(version: str, data_dir: Path, test_url: str) -> dict[str, str]:
    version = validate_version(version)
    test_url = validate_test_url(test_url)
    data_dir = data_dir.expanduser().resolve()
    extractors_dir = data_dir / "extractors"
    extractors_dir.mkdir(parents=True, exist_ok=True)
    version_dir = extractors_dir / version
    binary = version_dir / "bin" / "yt-dlp"
    python = version_dir / "bin" / "python"
    if os.path.lexists(version_dir):
        if (version_dir.is_symlink() or not version_dir.is_dir()
                or version_dir.resolve().parent != extractors_dir.resolve()
                or not binary.is_file() or not os.access(binary, os.X_OK)):
            raise RetainError(f"version directory already exists but is incomplete: {version}")
    else:
        venv.EnvBuilder(with_pip=True).create(version_dir)
        package = f"yt-dlp[default]=={version}"
        _require_success([str(python), "-m", "pip", "install", "--index-url", "https://pypi.org/simple",
                         "--no-input", "--disable-pip-version-check", "--quiet", package],
                        timeout=600, capture_limit=PIPE_CAPTURE_LIMIT, env=_pip_environment())

    installed_version = _require_success([str(binary), "--version"], timeout=10,
                                         capture_limit=PIPE_CAPTURE_LIMIT)
    if installed_version.splitlines()[0].strip() != version:
        raise RetainError("installed yt-dlp version did not match the requested pin")

    args = [str(binary), "--ignore-config", "--js-runtimes", "node", "-J", "--no-playlist",
            "--skip-download", "-f", PLAYBACK_FORMAT, test_url]
    raw = _require_success(args, timeout=15, capture_limit=CANARY_CAPTURE_LIMIT)
    try:
        info = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        raise RetainError("playback canary returned invalid JSON") from exc
    if not isinstance(info, dict) or not selected_video_url(info):
        raise RetainError("playback canary returned no direct video URL")

    link = activate_backup_symlink(data_dir, version_dir)
    return {"version": version, "executable": str(link), "status": "retained"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="exact dated yt-dlp release to pin")
    parser.add_argument("--data-dir", required=True, type=Path, help="application data directory")
    parser.add_argument("--test-url", required=True, help="HTTPS URL on a supported YouTube host")
    args = parser.parse_args(argv)
    try:
        result = retain(args.version, args.data_dir, args.test_url)
    except Exception as exc:
        message = re.sub(r"https?://[^\s\])}>'\"]+", "[URL redacted]", str(exc))[-2000:]
        print(f"retain-extractor: {message}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
