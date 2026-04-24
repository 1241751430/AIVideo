#!/usr/bin/env python3
"""Unit tests for render.py pure functions (no ffmpeg required)."""
import unittest
from tempfile import NamedTemporaryFile
from pathlib import Path
from unittest.mock import patch

from render import (
    build_clip_command,
    build_title_card_fallback_command,
    escape_drawtext,
    escape_filter_path,
    find_bgm,
    make_clip,
    normalize_positive_number,
    resolve_media_path,
    resolve_project_path,
    validate_output_video,
    validate_manifest,
)


class TestEscapeDrawtext(unittest.TestCase):
    def test_colon(self):
        self.assertEqual(escape_drawtext("a:b"), "a\\:b")

    def test_backslash(self):
        self.assertEqual(escape_drawtext("a\\b"), "a\\\\b")

    def test_single_quote(self):
        self.assertEqual(escape_drawtext("it's"), "it\\'s")

    def test_percent(self):
        self.assertEqual(escape_drawtext("50%"), "50%%")


class TestEscapeFilterPath(unittest.TestCase):
    def test_brackets(self):
        self.assertEqual(escape_filter_path("[a]"), "\\[a\\]")

    def test_comma(self):
        self.assertEqual(escape_filter_path("a,b"), "a\\,b")


class TestResolveMediaPath(unittest.TestCase):
    def test_none(self):
        self.assertIsNone(resolve_media_path(Path("/p"), None))

    def test_empty(self):
        self.assertIsNone(resolve_media_path(Path("/p"), ""))

    def test_relative(self):
        self.assertEqual(resolve_media_path(Path("/p"), "audio/x.wav"), "/p/audio/x.wav")

    def test_absolute(self):
        self.assertEqual(resolve_media_path(Path("/p"), "/tmp/x.wav"), "/tmp/x.wav")


class TestResolveProjectPath(unittest.TestCase):
    def test_stays_within(self):
        result = resolve_project_path(Path("/app/projects/demo"), "output/final.mp4", "Output")
        self.assertTrue(str(result).startswith("/app/projects/demo"))

    def test_escapes_project(self):
        with self.assertRaises(RuntimeError):
            resolve_project_path(Path("/app/projects/demo"), "../../etc/passwd", "Bad")


class TestBuildClipCommand(unittest.TestCase):
    def test_title_card_has_duration_and_drawtext(self):
        cmd = build_clip_command(
            Path("/tmp/clip.mp4"), 1080, 1920, "5", "Hello", None, None
        )
        self.assertIn("-f", cmd)
        self.assertIn("lavfi", cmd)
        self.assertIn("-shortest", cmd)
        self.assertIn("libx264", cmd)

    @patch("os.path.exists", return_value=True)
    def test_image_has_loop_and_t(self, _mock):
        cmd = build_clip_command(
            Path("/tmp/clip.mp4"), 1080, 1920, "5", "Hello", "/tmp/img.png", None
        )
        self.assertIn("-loop", cmd)
        self.assertIn("-t", cmd)
        t_index = cmd.index("-t")
        self.assertEqual(cmd[t_index + 1], "5")

    def test_title_card_fallback_has_no_drawtext(self):
        cmd = build_title_card_fallback_command(
            Path("/tmp/clip.mp4"), 1080, 1920, "5", None
        )
        self.assertNotIn("drawtext", " ".join(cmd))
        self.assertIn("libx264", cmd)


class TestManifestValidation(unittest.TestCase):
    def test_rejects_empty_shots(self):
        with self.assertRaises(RuntimeError):
            validate_manifest({"width": 1080, "height": 1920, "shots": []})

    def test_rejects_invalid_duration(self):
        with self.assertRaises(RuntimeError):
            normalize_positive_number(0, "duration")

    def test_normalizes_valid_duration(self):
        manifest = {"width": 1080, "height": 1920, "shots": [{"durationSeconds": 1.23456}]}
        validate_manifest(manifest)
        self.assertEqual(manifest["shots"][0]["durationSeconds"], 1.235)


class TestFallbacks(unittest.TestCase):
    @patch("render.os.path.exists", return_value=True)
    @patch("render.run")
    def test_image_or_audio_clip_failure_falls_back_to_plain_title_card_with_silent_audio(self, run_mock, _exists_mock):
        run_mock.side_effect = [RuntimeError("bad image"), None]
        clip = make_clip(
            Path("/project"),
            Path("/work"),
            {"durationSeconds": 5, "assetPath": "bad.png", "audioPath": "bad.aiff", "title": "Title"},
            1080,
            1920,
            0,
        )
        self.assertEqual(clip, Path("/work/clip_000.mp4"))
        self.assertEqual(run_mock.call_count, 2)
        fallback_command = " ".join(run_mock.call_args_list[1].args[0])
        self.assertNotIn("drawtext", fallback_command)
        self.assertNotIn("bad.aiff", fallback_command)
        self.assertIn("anullsrc", fallback_command)


class TestOutputValidation(unittest.TestCase):
    def test_accepts_valid_video_probe(self):
        with NamedTemporaryFile() as tmp:
            tmp.write(b"video")
            tmp.flush()
            with patch(
                "render.probe_video",
                return_value={
                    "format": {"duration": "5.0"},
                    "streams": [{"codec_type": "video", "width": 1080, "height": 1920}],
                },
            ):
                validate_output_video(Path(tmp.name), 1080, 1920)

    def test_rejects_resolution_mismatch(self):
        with NamedTemporaryFile() as tmp:
            tmp.write(b"video")
            tmp.flush()
            with patch(
                "render.probe_video",
                return_value={
                    "format": {"duration": "5.0"},
                    "streams": [{"codec_type": "video", "width": 720, "height": 1280}],
                },
            ):
                with self.assertRaises(RuntimeError):
                    validate_output_video(Path(tmp.name), 1080, 1920)


class TestFindBgm(unittest.TestCase):
    def test_no_bgm(self):
        self.assertIsNone(find_bgm(Path("/nonexistent")))

    @patch("render.Path.exists", return_value=True)
    def test_finds_mp3(self, _mock):
        result = find_bgm(Path("/project"))
        self.assertIsNotNone(result)
        self.assertTrue(str(result).endswith("bgm.mp3"))


if __name__ == "__main__":
    unittest.main()
