#!/usr/bin/env python3
"""End-to-end render smoke test that requires real ffmpeg and ffprobe."""
import json
import shutil
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from render import probe_video, render


@unittest.skipIf(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    "ffmpeg and ffprobe are required for render e2e tests",
)
class TestRenderEndToEnd(unittest.TestCase):
    def test_renders_minimal_title_card_video(self):
        with TemporaryDirectory() as tmp:
            project_dir = Path(tmp) / "project"
            captions_dir = project_dir / "captions"
            captions_dir.mkdir(parents=True)
            manifest = {
                "aspectRatio": "9:16",
                "width": 360,
                "height": 640,
                "durationSeconds": 2,
                "bgmStyle": "none",
                "outputFile": "output/e2e.mp4",
                "captionsFile": "captions/captions.srt",
                "shots": [
                    {
                        "shotId": "scene-1",
                        "title": "E2E Test",
                        "durationSeconds": 2,
                        "assetKind": "generated-card",
                        "assetPath": None,
                        "audioPath": None,
                        "overlayText": "E2E Test",
                        "caption": "E2E Test",
                        "visualPrompt": "minimal test card",
                    }
                ],
            }
            manifest_path = project_dir / "render-manifest.json"
            manifest_path.parent.mkdir(parents=True)
            manifest_path.write_text(json.dumps(manifest), encoding="utf8")
            (captions_dir / "captions.srt").write_text(
                "1\n00:00:00,000 --> 00:00:02,000\nE2E Test\n",
                encoding="utf8",
            )

            output = render(project_dir, manifest_path)

            self.assertTrue(output.exists())
            self.assertGreater(output.stat().st_size, 0)
            probe = probe_video(output)
            video_stream = next(stream for stream in probe["streams"] if stream.get("codec_type") == "video")
            self.assertEqual(video_stream.get("width"), 360)
            self.assertEqual(video_stream.get("height"), 640)
            self.assertGreater(float(probe["format"]["duration"]), 0)


if __name__ == "__main__":
    unittest.main()
