import importlib.util
import os
import re
import unittest
from pathlib import Path
from unittest.mock import patch


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
        self.assertIn("SOURCE_REF=ccbd9cf8ee5fb824bbeb6b49959f99156a75d4b7", docs)
        self.assertIn("ha store reload", docs)
        self.assertIn('cp -R "$STAGING"/yt-streamer-webapp-*/ha-addon/.', docs)

    def test_build_targets_both_supported_architectures_with_same_source_pin(self):
        build = (ADDON / "build.yaml").read_text()
        dockerfile = (ADDON / "Dockerfile").read_text()
        self.assertRegex(build, r"(?m)^\s+aarch64:")
        self.assertRegex(build, r"(?m)^\s+amd64:")
        self.assertEqual(build.count(PIN), 1)
        self.assertRegex(dockerfile, rf"(?m)^ARG APP_REF={PIN}$")
        self.assertIn('YTDLP_VERSION: "2026.8.19"', build)
        self.assertIn('yt-dlp[default]==${YTDLP_VERSION}', dockerfile)
        self.assertIn("ARG YTDLP_VERSION=2026.8.19", dockerfile)
        self.assertIn("ffmpeg", dockerfile)
        self.assertIn("YTDLP_PATH=/usr/local/bin/yt-dlp", dockerfile)
        self.assertIn("COPY yt-dlp /usr/local/bin/yt-dlp", dockerfile)
        self.assertIn("ARG YTDLP_FALLBACK_VERSION=2026.8.19", dockerfile)
        self.assertIn('yt-dlp[default]==${YTDLP_FALLBACK_VERSION}', dockerfile)
        self.assertIn("YTDLP_FALLBACK_PATH=/opt/yt-dlp-backup/bin/yt-dlp", dockerfile)

    def test_addon_supplies_streamha_signed_access_defaults(self):
        config = (ADDON / "config.yaml").read_text()
        self.assertIn('access_control_origin: "https://streamha.ameshalex.com"', config)
        self.assertIn('access_issuer: "https://ameshalex.cloudflareaccess.com"', config)
        self.assertRegex(config, r'access_audience: "[A-Za-z0-9_-]{20,}"')
        self.assertIn("access_control_origin: str", config)
        self.assertIn("access_issuer: str", config)
        self.assertIn("access_audience: str", config)

    def test_supervisor_option_defaults_and_string_selectors(self):
        with patch.dict(os.environ, {}, clear=True):
            addon_run.apply_options({"mjpeg_height": "720", "download_max_height": "360"})
            self.assertEqual(os.environ["MAX_STREAMS"], "1")
            self.assertEqual(os.environ["MJPEG_FPS"], "12")
            self.assertEqual(os.environ["MJPEG_HEIGHT"], "720")
            self.assertEqual(os.environ["DL_MAX_HEIGHT"], "360")
            self.assertNotIn("CAST_CONTROL_ORIGIN", os.environ)

    def test_apne_access_is_configured_as_a_complete_signed_triple(self):
        options = {
            "access_control_origin": "https://streamha.ameshalex.com",
            "access_issuer": "https://example.cloudflareaccess.com",
            "access_audience": "Ab_12345678901234567890",
        }
        with patch.dict(os.environ, {}, clear=True):
            addon_run.apply_options(options)
            self.assertEqual(os.environ["CAST_CONTROL_ORIGIN"], options["access_control_origin"])
            self.assertEqual(os.environ["CAST_ACCESS_ISSUER"], options["access_issuer"])
            self.assertEqual(os.environ["CAST_ACCESS_AUDIENCE"], options["access_audience"])

    def test_apne_access_rejects_partial_or_invalid_origins(self):
        valid = {
            "access_control_origin": "https://streamha.ameshalex.com",
            "access_issuer": "https://example.cloudflareaccess.com",
            "access_audience": "Ab_12345678901234567890",
        }
        invalid = [
            {"access_control_origin": valid["access_control_origin"]},
            {**valid, "access_control_origin": "http://streamha.ameshalex.com"},
            {**valid, "access_control_origin": "https://streamha.ameshalex.com/evil"},
            {**valid, "access_issuer": "https://untrusted.example.com"},
            {**valid, "access_issuer": "https://example.cloudflareaccess.com/certs"},
            {**valid, "access_audience": "short"},
            {**valid, "access_audience": 123},
        ]
        for options in invalid:
            with self.subTest(options=options), patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(SystemExit):
                    addon_run.apply_options(options)
                self.assertNotIn("CAST_CONTROL_ORIGIN", os.environ)

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
