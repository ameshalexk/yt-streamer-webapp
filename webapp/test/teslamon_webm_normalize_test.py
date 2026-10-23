"""Regression: Safari WebM can have audio packets but no format duration."""
import importlib.util
import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "src/lib/teslamon-poweralx-bridge.py"
spec = importlib.util.spec_from_file_location("teslamon_bridge", SOURCE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
FFMPEG=Path("/opt/homebrew/bin/ffmpeg")
FFPROBE=Path("/opt/homebrew/bin/ffprobe")

class TeslaMonWebmNormalizeTests(unittest.TestCase):
    @unittest.skipUnless(FFMPEG.exists() and FFPROBE.exists(), "Mac codec toolchain required")
    def test_webm_normalized_to_seekable_m4a_with_bounded_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp)
            original=base/"safari.webm"
            subprocess.run([str(FFMPEG),"-y","-v","error","-f","lavfi",
                "-i","sine=frequency=510:duration=2.8","-c:a","libopus",
                str(original)],capture_output=True,check=True,timeout=10)
            duration=bridge.media_duration(original)
            normalized,seconds=bridge.normalize_for_poweralx(
                original,"audio/webm",base,duration)
            self.assertEqual(normalized.suffix,".m4a")
            self.assertTrue(normalized.stat().st_size>128)
            self.assertAlmostEqual(seconds,duration,delta=.35)
            # The Windows worker's old format-duration-only probe must pass.
            output=subprocess.run([str(FFPROBE),"-v","error","-show_entries",
                "format=duration","-of",
                "default=noprint_wrappers=1:nokey=1",str(normalized)],
                capture_output=True,check=True,text=True,timeout=8).stdout.strip()
            self.assertGreater(float(output),2.5)
            self.assertEqual(len(hashlib.sha256(normalized.read_bytes()).hexdigest()),64)

    def test_mp4_wav_passthrough(self):
        for mime in ("audio/mp4","audio/wav"):
            with tempfile.TemporaryDirectory() as tmp:
                source=Path(tmp)/"file.m4a"
                result,duration=bridge.normalize_for_poweralx(source,mime,Path(tmp),2.2)
                self.assertEqual(source,result)
                self.assertEqual(duration,2.2)

    def test_normalization_errors_are_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake=Path(tmp)/"audio.webm"
            fake.write_bytes(bytes(500))
            with self.assertRaisesRegex(bridge.TranscribeFailed,"audio_normalization_failed"):
                bridge.normalize_for_poweralx(fake,"audio/webm",Path(tmp),2.0)
            
if __name__ == "__main__": unittest.main()
