#!/usr/bin/env python3
"""Local-only Mac mini JXL vs MJPEG microbenchmark; never starts the web server.

Uses independent FFmpeg binaries; codec settings are NOT quality-matched.
Writes disposable video payloads to a temporary directory and removes them.
"""
import argparse
import json
import os
from pathlib import Path
import resource
import subprocess
import tempfile
import time

def bench(name, ffmpeg, size, seconds, out_dir):
    width, height = size
    fps = 12
    output = Path(out_dir) / (f"{name}-{width}x{height}" + (".jxl" if name == "jxl" else ".mjpeg"))
    common = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", f"testsrc2=size={width}x{height}:rate={fps}",
        "-frames:v", str(fps * seconds), "-an", "-map", "0:v:0",
        "-threads", "2",
    ]
    if name == "jxl":
        args = common + [
            "-pix_fmt", "rgb24", "-c:v", "libjxl", "-distance", "2.6",
            "-effort", "1", "-f", "tee",
            f"[f=image2pipe]{output}|[f=framecrc]{output}.crc",
        ]
    else:
        args = common + ["-c:v", "mjpeg", "-q:v", "7", "-f", "mpjpeg", str(output)]

    start = time.perf_counter()
    with subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) as proc:
        _pid, status, stats = os.wait4(proc.pid, 0)
        proc.returncode = os.waitstatus_to_exitcode(status)
        err = proc.stderr.read().decode("utf8", errors="replace").strip()
    wall = time.perf_counter() - start
    if proc.returncode != 0:
        raise RuntimeError(f"{name} failed ({proc.returncode}): {err[-1200:]}")
    byt = output.stat().st_size
    result = dict(codec=name.upper(), resolution=f"{width}x{height}", frames=fps * seconds,
        wall_seconds=round(wall, 2),
        realtime_speed=round(seconds / wall, 2),
        cpu_seconds=round(stats.ru_utime + stats.ru_stime, 2),
        avg_cpu_percent=round(100 * (stats.ru_utime + stats.ru_stime) / wall),
        peak_rss_mib=round(stats.ru_maxrss / (1024 * 1024), 1),
        payload_megabits_per_sec=round(byt * 8 / seconds / 1e6, 3),
        payload_bytes=byt)
    if name == "jxl":
        sizes = [
            int(line.split(",")[4])
            for line in (Path(str(output) + ".crc")).read_text().splitlines()
            if line and line[0].isdigit()
        ]
        result["index_frames"] = len(sizes)
        result["bytes_match_framecrc"] = (sum(sizes) == byt and len(sizes) == fps * seconds)
        if not result["bytes_match_framecrc"]:
            raise AssertionError("JXL frame count or packet lengths do not match output")
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=int, choices=range(1, 16), metavar="1-15", default=4)
    parser.add_argument("--resolution", choices=["480p", "720p", "both"], default="both")
    args = parser.parse_args()
    jxl = os.getenv("JXL_FFMPEG_PATH", "").strip()
    if not jxl or not os.path.isabs(jxl) or not os.access(jxl, os.X_OK):
        raise SystemExit("Set JXL_FFMPEG_PATH to the absolute isolated JXL FFmpeg executable")
    mjpeg = "/opt/homebrew/bin/ffmpeg"
    if not os.access(mjpeg, os.X_OK):
        raise SystemExit("Baseline production FFmpeg not found; no changes made")
    sizes = {"480p": (854, 480), "720p": (1280, 720)}
    chosen = list(sizes) if args.resolution == "both" else [args.resolution]
    results = []
    with tempfile.TemporaryDirectory(prefix="yt-jxl-safe-benchmark-") as directory:
        for label in chosen:
            for name, binary in [("mjpeg", mjpeg), ("jxl", jxl)]:
                print(f"Benchmark: {label} {name} ({args.seconds}s source)...", flush=True)
                results.append(bench(name, binary, sizes[label], args.seconds, directory))
    print(json.dumps({
        "results": results, "note": "Synthetic testsrc2, FFmpeg builds differ, q:v=7 vs JXL distance 2.6. NOT quality-matched, not real video, no simultaneous process load."
    }, indent=2))

if __name__ == "__main__":
    main()
