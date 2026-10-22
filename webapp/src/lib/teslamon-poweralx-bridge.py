#!/usr/bin/env python3
"""Forward one short TeslaMon audio clip to the EXISTING PowerALX Life Recorder
GPU worker. No Mac model, no Mac transcription, no downloads or cloud ASR.

Reuses the life-recorder remote_worker.py SSH/SCP transport and the validated
PowerALX phase1 release. This is an ephemeral, independent TeslaMon job and
does not modify Life Recorder's SQLite database, queue, releases or model files.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from uuid import uuid4

TYPES = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a"}
MAX_BYTES = 5 * 1024 * 1024
MAX_SECONDS = 21.0
ROOT = Path.home() / "Documents/Codex/2026-09-11/life-recorder/receiver"
class TranscribeFailed(Exception):
    pass

def echo(status, code="", text=""):
    payload = {"status": status}
    if code:
        payload["code"] = code
    if text:
        payload["text"] = text
    print(json.dumps(payload, ensure_ascii=False), flush=True)

def media_duration(source: Path) -> float:
    try:
        process = subprocess.run(
            ["/opt/homebrew/bin/ffprobe", "-v", "error", "-show_entries",
             "format=duration", "-of", "default=noprint_wrappers=1:nokey=1",
             str(source)], capture_output=True, timeout=8, check=True, text=True,
        )
        seconds = float(process.stdout.strip())
        if not (0.1 < seconds <= MAX_SECONDS):
            raise TranscribeFailed("invalid_audio_duration")
        return seconds
    except TranscribeFailed:
        raise
    except (ValueError, OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
        raise TranscribeFailed("invalid_audio")

def validate_response(payload: object, request_id: str, sha: str) -> str:
    if not isinstance(payload, dict) or payload.get("id") != request_id or payload.get("sha256") != sha:
        raise TranscribeFailed("poweralx_result_identity_mismatch")
    if payload.get("final") is not True or payload.get("status") != "complete":
        raise TranscribeFailed("poweralx_result_incomplete")
    segments = payload.get("segments")
    if not isinstance(segments, list) or len(segments) > 120:
        raise TranscribeFailed("invalid_poweralx_result")
    transcript = []
    for segment in segments:
        if not isinstance(segment, dict) or segment.get("language") not in ("en", "ml", "hi", "unclear"):
            raise TranscribeFailed("invalid_poweralx_result")
        if segment.get("language") == "unclear":
            continue
        item = segment.get("english") or segment.get("original")
        if not isinstance(item, str):
            raise TranscribeFailed("invalid_poweralx_result")
        normalized = " ".join(item.split())
        if normalized:
            transcript.append(normalized)
    text = " ".join(transcript).strip()
    if not text:
        raise TranscribeFailed("no_speech_detected")
    # The restricted local TeslaMon command parser never needs a transcript
    # over 220 characters. Do not log/store speech, or broaden the tool surface.
    return text[:220]

def run(mime: str, host: str, root: str, release: str):
    if mime not in TYPES or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,59}", host):
        raise TranscribeFailed("invalid_configuration")
    if not re.fullmatch(r"C:\\[A-Za-z0-9_ .\\-]+", root, flags=re.IGNORECASE):
        raise TranscribeFailed("invalid_configuration")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,75}", release):
        raise TranscribeFailed("invalid_configuration")
    if not ROOT.joinpath("remote_worker.py").is_file():
        raise TranscribeFailed("poweralx_transport_missing")
    sys.path.insert(0, str(ROOT))
    from remote_worker import remote_command, transfer, ps_command
    data = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(data) < 128 or len(data) > MAX_BYTES:
        raise TranscribeFailed("invalid_audio")
    # Ephemeral Mac temp files for SSH/SCP only: never decode or transcribe
    # locally. The temporary directory disappears even on remote failure.
    with tempfile.TemporaryDirectory(prefix="teslamon-forward-") as tmp:
        os.chmod(tmp, 0o700)
        base = Path(tmp)
        job_id = str(uuid4())
        source = base / ("clip" + TYPES[mime])
        source.write_bytes(data)
        os.chmod(source, 0o600)
        duration = media_duration(source)
        sha = hashlib.sha256(data).hexdigest()
        metadata = {"id": job_id, "sha256": sha, "started": time.time(), "duration": duration}
        manifest = base / "metadata.json"
        manifest.write_text(json.dumps(metadata), encoding="utf-8")
        os.chmod(manifest, 0o600)
        result_file = base / "result.json"
        # Construct remote paths from only fixed, validated root + UUID.
        # Use a separate per-job TESLAMON folder, not existing life-recorder jobs.
        remote = root.rstrip("\\") + "\\teslamon-jobs\\" + job_id
        dest_audio = remote + "\\audio" + TYPES[mime]
        dest_meta = remote + "\\metadata.json"
        dest_result = remote + "\\result.json"
        remote_command("/usr/bin/ssh", host, ps_command(
            "$ErrorActionPreference='Stop'; "
            f"New-Item -ItemType Directory -Force -Path '{remote}' | Out-Null"), timeout=25)
        completed = False
        try:
            transfer("/usr/bin/scp", host, source, dest_audio)
            transfer("/usr/bin/scp", host, manifest, dest_meta)
            # Existing PowerALX worker release and existing CUDA model cache.
            # No new model names, downloads, Python dependencies or Mac ASR.
            launcher = root.rstrip("\\") + "\\releases\\" + release + "\\run-worker.cmd"
            # Explicitly forbid fetching or installing any additional weights.
            # If the existing PowerALX cache is insufficient, fail closed.
            cmd = ('cmd.exe /d /s /c ""' + launcher + '" --audio "' +
                   dest_audio + '" --metadata "' + dest_meta +
                   '" --out "' + dest_result + '""')
            remote_command("/usr/bin/ssh", host, ps_command(
                "$ErrorActionPreference='Stop'; "
                "$env:HF_HUB_OFFLINE='1'; "
                "$env:TRANSFORMERS_OFFLINE='1'; "
                "$env:HF_DATASETS_OFFLINE='1'; "
                "$env:HF_HUB_DISABLE_TELEMETRY='1'; "
                f"& {cmd}; if ($LASTEXITCODE -ne 0) {{ throw 'ExistingWorkerFailed' }}"),
                timeout=110)
            transfer("/usr/bin/scp", host, result_file, dest_result, download=True)
            result = json.loads(result_file.read_text(encoding="utf-8-sig"))
            text = validate_response(result, job_id, sha)
            completed = True
            return text
        finally:
            # If the remote worker is still running or timed out, never
            # remove inputs under it. Safe cleanup requires confirmed exit.
            if completed:
                try:
                    remote_command("/usr/bin/ssh", host, ps_command(
                        "$ErrorActionPreference='Stop'; "
                        f"Remove-Item -LiteralPath '{remote}' -Recurse -Force"),
                        timeout=20)
                except Exception:
                    pass

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mime", required=True)
    parser.add_argument("--worker-root", required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--ssh-host", default="poweralx")
    opts = parser.parse_args()
    try:
        text = run(opts.mime, opts.ssh_host, opts.worker_root, opts.release)
        echo("ok", text=text)
    except TranscribeFailed as error:
        echo("failed", code=str(error))
    except Exception:
        # No transcript, audio paths, transport stdout or credentials in errors.
        echo("unavailable", code="poweralx_worker_unavailable")

if __name__ == "__main__":
    main()
