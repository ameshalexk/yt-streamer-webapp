import importlib.util
import re
import unittest
from pathlib import Path


ADDON = Path(__file__).resolve().parents[1]
ROOT = ADDON.parent
PIN = "54c513413958c8ef723e92dc7ca02689589cb074"

spec = importlib.util.spec_from_file_location("addon_run", ADDON / "run.py")
addon_run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon_run)


class PackagingTests(unittest.TestCase):
    def test_install_and_update_use_same_local_addon_path(self):
        docs = (ADDON / "DOCS.md").read_text()
        self.assertEqual(docs.count("/local_apps/yt_streamer"), 3)
        self.assertNotIn("/addons/yt_streamer", docs)
        self.assertIn("SOURCE_REF=feb3c94729a963b3dc93a9e2cf3a038e3b5bed58", docs)
        self.assertIn("ha apps reload", docs)
        self.assertIn('cp -R "$STAGING"/yt-streamer-webapp-*/ha-addon/.', docs)

    def test_build_targets_both_supported_architectures_with_same_source_pin(self):
        build = (ADDON / "build.yaml").read_text()
        dockerfile = (ADDON / "Dockerfile").read_text()
        self.assertRegex(build, r"(?m)^\s+aarch64:")
        self.assertRegex(build, r"(?m)^\s+amd64:")
        self.assertEqual(build.count(PIN), 1)
        self.assertRegex(dockerfile, rf"(?m)^ARG APP_REF={PIN}$")
        self.assertIn("YTDLP_VERSION: \"2026.8.19\"", build)
        self.assertIn('yt-dlp[default]==${YTDLP_VERSION}', dockerfile)
        self.assertIn("ARG YTDLP_VERSION=2026.8.19", dockerfile)
        self.assertIn("ffmpeg", dockerfile)
        self.assertIn("YTDLP_PATH=/usr/local/bin/yt-dlp", dockerfile)
        self.assertIn("COPY yt-dlp /usr/local/bin/yt-dlp", dockerfile)

    def test_supervisor_option_defaults_and_string_selectors(self):
        addon_run.apply_options({"mjpeg_height": "720", "download_max_height": "360"})
        import os
        self.assertEqual(os.environ["MAX_STREAMS"], "1")
        self.assertEqual(os.environ["MJPEG_FPS"], "12")
        self.assertEqual(os.environ["MJPEG_HEIGHT"], "720")
        self.assertEqual(os.environ["DL_MAX_HEIGHT"], "360")

    def test_supervisor_options_fail_closed(self):
        for options in (
            {"max_streams": True},
            {"max_streams": 4},
            {"mjpeg_fps": "31"},
            {"mjpeg_height": "1080"},
            {"download_max_height": 240.0},
        ):
            with self.subTest(options=options), self.assertRaises(SystemExit):
                addon_run.apply_options(options)


if __name__ == "__main__":
    unittest.main()
