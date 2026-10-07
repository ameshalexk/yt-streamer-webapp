import importlib.util
import contextlib
import io
import pathlib
import sys
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "webapp" / "scripts" / "retain-extractor.py"
SPEC = importlib.util.spec_from_file_location("retain_extractor", SCRIPT)
retain_extractor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = retain_extractor
SPEC.loader.exec_module(retain_extractor)


class RetainExtractorTests(unittest.TestCase):
    def test_url_validation_requires_https_and_exact_youtube_host(self):
        valid = "https://www.youtube.com/watch?v=example"
        self.assertEqual(retain_extractor.validate_test_url(valid), valid)
        for url in (
            "http://youtube.com/watch?v=x",
            "https://youtube.com.example.test/watch?v=x",
            "https://user@youtube.com/watch?v=x",
            "https://youtube.com/watch?v=x#fragment",
            "https://youtube.com:8443/watch?v=x",
            "x" * 2049,
        ):
            with self.subTest(url=url[:60]):
                with self.assertRaises(retain_extractor.RetainError):
                    retain_extractor.validate_test_url(url)

    def test_selects_a_video_format_not_audio(self):
        self.assertEqual(retain_extractor.selected_video_url({"url": "/tmp/muxed"}), "/tmp/muxed")
        info = {"requested_formats": [
            {"url": "/tmp/audio", "vcodec": "none"},
            {"url": "/tmp/video", "vcodec": "avc1"},
        ]}
        self.assertEqual(retain_extractor.selected_video_url(info), "/tmp/video")
        self.assertIsNone(retain_extractor.selected_video_url({
            "requested_formats": [{"url": "/tmp/audio", "vcodec": "none"}],
        }))

    def test_atomically_switches_backup_link_and_refuses_real_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir = pathlib.Path(temporary)
            extractors = data_dir / "extractors"
            versions = []
            for version in ("2026.10.01", "2026.10.02"):
                binary = extractors / version / "bin" / "yt-dlp"
                binary.parent.mkdir(parents=True)
                binary.write_text("fixture")
                binary.chmod(0o755)
                versions.append(binary)

            link = retain_extractor.activate_backup_symlink(data_dir, versions[0].parent.parent)
            self.assertTrue((data_dir / "extractor-backup").is_symlink())
            self.assertEqual(link.resolve(), versions[0].resolve())
            retain_extractor.activate_backup_symlink(data_dir, versions[1].parent.parent)
            self.assertEqual(link.resolve(), versions[1].resolve())
            self.assertTrue(versions[0].exists(), "previous retained versions must remain in place")

            blocked = data_dir / "blocked"
            blocked_version = blocked / "extractors" / "2026.10.01"
            binary = blocked_version / "bin" / "yt-dlp"
            binary.parent.mkdir(parents=True)
            binary.write_text("fixture")
            binary.chmod(0o755)
            real_destination = blocked / "extractor-backup"
            real_destination.mkdir()
            with self.assertRaisesRegex(retain_extractor.RetainError, "refusing to overwrite"):
                retain_extractor.activate_backup_symlink(blocked, blocked_version)
            self.assertTrue(real_destination.is_dir())

    def test_bounded_subprocess_capture_limits_output_and_timeout(self):
        code, stdout, _ = retain_extractor.run_bounded(
            [sys.executable, "-c", "print('ok')"], timeout=3, capture_limit=1024,
        )
        self.assertEqual((code, stdout.strip()), (0, "ok"))
        with self.assertRaisesRegex(retain_extractor.RetainError, "output exceeded"):
            retain_extractor.run_bounded(
                [sys.executable, "-c", "print('x' * 10000)"], timeout=3, capture_limit=100,
            )
        with self.assertRaisesRegex(retain_extractor.RetainError, "timed out"):
            retain_extractor.run_bounded(
                [sys.executable, "-c", "import time; time.sleep(3)"], timeout=1, capture_limit=1024,
            )

    def test_cli_handles_validation_errors_without_venv_error_symbol(self):
        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary, contextlib.redirect_stderr(stderr):
            result = retain_extractor.main([
                "--version", "not-a-release", "--data-dir", temporary,
                "--test-url", "https://www.youtube.com/watch?v=example",
            ])
        self.assertEqual(result, 1)
        self.assertIn("exact dated yt-dlp release", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
