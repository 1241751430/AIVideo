#!/usr/bin/env python3
"""Unit tests for render.py pure functions (no ffmpeg required)."""
import unittest
from pathlib import Path
from unittest.mock import patch

from render import (
    build_clip_command,
    escape_drawtext,
    escape_filter_path,
    find_bgm,
    resolve_media_path,
    resolve_project_path,
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
