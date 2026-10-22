"""Test Safari MediaRecorder duration fallbacks without contacting PowerALX."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "src/lib/teslamon-poweralx-bridge.py"
spec = importlib.util.spec_from_file_location("teslamon_bridge", SOURCE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

def output(data):
    return subprocess.CompletedProcess(args=[], returncode=0, stdout=json.dumps(data), stderr="")

class TeslaMonAudioProbeTests(unittest.TestCase):
    def probe(self, *values):
        with patch.object(bridge.subprocess, "run", side_effect=[output(v) for v in values]) as runner:
            return bridge.media_duration(Path("/tmp/safari-voice.m4a")), runner.call_count

    def test_regular_duration(self):
        duration, calls = self.probe({"format": {"duration": "2.2"},
                                      "streams": [{"codec_type": "audio", "duration": "2.1"}]})
        self.assertEqual(duration, 2.2)
        self.assertEqual(calls, 1)

    def test_fragmented_mp4_without_metadata_uses_audio_packets(self):
        duration, calls = self.probe(
            {"format": {"duration": "N/A"},
             "streams": [{"codec_type": "audio", "duration": "N/A"}]},
            {"packets": [{"pts_time": "0.0", "duration_time": "0.1"},
                         {"pts_time": "1.0", "duration_time": "0.2"},
                         {"pts_time": "1.8", "duration_time": "0.2"}]})
        self.assertAlmostEqual(duration, 2.0)
        self.assertEqual(calls, 2)

    def test_non_audio_rejected(self):
        with self.assertRaisesRegex(bridge.TranscribeFailed, "invalid_audio_container"):
            self.probe({"streams": [], "format": {"duration": "2"}})

    def test_unusable_packet_timing_rejected(self):
        with self.assertRaisesRegex(bridge.TranscribeFailed, "invalid_audio_timing"):
            self.probe({"streams": [{"codec_type": "audio"}], "format": {}},
                       {"packets": [{"pts_time": "N/A"}]})

    def test_recording_over_time_limit_rejected(self):
        with self.assertRaisesRegex(bridge.TranscribeFailed, "invalid_audio_duration"):
            self.probe({"streams": [{"codec_type": "audio"}],
                        "format": {"duration": "25"}})

    def test_packet_based_limit_enforced(self):
        with self.assertRaisesRegex(bridge.TranscribeFailed, "invalid_audio_duration"):
            self.probe({"streams": [{"codec_type": "audio"}], "format": {}},
                       {"packets": [{"pts_time": "0", "duration_time": ".02"},
                                    {"pts_time": "24", "duration_time": ".02"}]})

    def test_ffprobe_failure_has_distinct_code(self):
        with patch.object(bridge.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "ffprobe")):
            with self.assertRaisesRegex(bridge.TranscribeFailed, "invalid_audio_container"):
                bridge.media_duration(Path("/tmp/safari-voice.m4a"))

if __name__ == "__main__":
    unittest.main()
