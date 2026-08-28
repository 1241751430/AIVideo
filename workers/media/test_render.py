#!/usr/bin/env python3
"""Unit tests for render.py pure functions (no ffmpeg required)."""
import unittest
from tempfile import NamedTemporaryFile, TemporaryDirectory
from pathlib import Path
from unittest.mock import patch

from render import (
    build_bgm_mix_command,
    build_clip_command,
    build_image_prepare_command,
    build_subtitle_burn_command,
    build_title_card_fallback_command,
    escape_drawtext,
    escape_filter_path,
    find_bgm,
    has_audio_stream,
    make_clip,
    normalize_positive_number,
    prepare_manifest_media,
    resolve_media_path,
    resolve_project_path,
    validate_output_video,
    validate_manifest,
    validate_manifest_paths,
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
        result = resolve_project_path(Path("/app/project/demo"), "output/final.mp4", "Output")
        self.assertTrue(str(result).startswith("/app/project/demo"))

    def test_escapes_project(self):
        with self.assertRaises(RuntimeError):
            resolve_project_path(Path("/app/project/demo"), "../../etc/passwd", "Bad")


class TestBuildClipCommand(unittest.TestCase):
    def test_title_card_has_duration_and_drawtext(self):
        cmd = build_clip_command(
            Path("/tmp/clip.mp4"), 1080, 1920, "5", "Hello", None, None
        )
        self.assertIn("-f", cmd)
        self.assertIn("lavfi", cmd)
        self.assertIn("-shortest", cmd)
        self.assertIn("libx264", cmd)
        self.assertIn("-r", cmd)
        self.assertIn("30", cmd)
        self.assertIn("-crf", cmd)
        self.assertIn("20", cmd)
        self.assertIn("geq=", " ".join(cmd))
        self.assertIn("box=1", " ".join(cmd))

    @patch("os.path.exists", return_value=True)
    def test_image_has_loop_t_and_motion(self, _mock):
        cmd = build_clip_command(
            Path("/tmp/clip.mp4"), 1080, 1920, "5", "Hello", "/tmp/img.png", None
        )
        self.assertIn("-loop", cmd)
        self.assertIn("-t", cmd)
        t_index = cmd.index("-t")
        self.assertEqual(cmd[t_index + 1], "5")
        filter_index = cmd.index("-vf")
        self.assertIn("zoompan", cmd[filter_index + 1])
        self.assertIn("fade=t=in", cmd[filter_index + 1])
        self.assertIn("fade=t=out", cmd[filter_index + 1])

    def test_clip_command_uses_stable_audio_and_faststart_settings(self):
        cmd = build_clip_command(
            Path("/tmp/clip.mp4"), 1080, 1920, "5", "Hello", None, None
        )
        self.assertIn("-ar", cmd)
        self.assertIn("48000", cmd)
        self.assertIn("-b:a", cmd)
        self.assertIn("192k", cmd)
        self.assertIn("+faststart", cmd)

    @patch("os.path.exists", return_value=True)
    def test_image_with_audio_pads_to_exact_duration_no_shortest(self, _mock):
        # Narration is usually shorter than the planned shot. Using -shortest
        # here would trim the clip to the audio and desync the fixed-length
        # caption timeline, so the image+audio branch must pad the audio to
        # silence and pin the output to exactly -t duration instead.
        cmd = build_clip_command(
            Path("/tmp/clip.mp4"), 1080, 1920, "5", "Hello", "/tmp/img.png", "/tmp/narr.wav"
        )
        self.assertNotIn("-shortest", cmd)
        self.assertIn("-af", cmd)
        self.assertEqual(cmd[cmd.index("-af") + 1], "apad")
        # The output is pinned to exactly the planned duration: the -t that
        # follows -af apad carries the shot duration.
        self.assertEqual(cmd[cmd.index("-t", cmd.index("-af")) + 1], "5")

    @patch("os.path.exists", return_value=True)
    def test_video_asset_with_audio_pads_to_exact_duration(self, _mock):
        cmd = build_clip_command(
            Path("/tmp/clip.mp4"),
            1080,
            1920,
            "6",
            "Hello",
            "/tmp/scene.mp4",
            "/tmp/narr.wav",
            "libx264",
            "video",
        )
        self.assertIn("-stream_loop", cmd)
        self.assertNotIn("-shortest", cmd)
        self.assertIn("apad", cmd)
        self.assertEqual(cmd[cmd.index("-t", cmd.index("-af")) + 1], "6")

    def test_title_card_branch_keeps_shortest(self):
        # No visual asset: both streams are already duration-bound, so the
        # title-card branch keeps -shortest (and must not gain -af apad).
        cmd = build_clip_command(
            Path("/tmp/clip.mp4"), 1080, 1920, "5", "Hello", None, "/tmp/narr.wav"
        )
        self.assertIn("-shortest", cmd)
        self.assertNotIn("apad", cmd)

    def test_title_card_fallback_has_no_drawtext(self):
        cmd = build_title_card_fallback_command(
            Path("/tmp/clip.mp4"), 1080, 1920, "5", None
        )
        self.assertNotIn("drawtext", " ".join(cmd))
        self.assertIn("libx264", cmd)
        self.assertIn("-crf", cmd)

    def test_subtitle_burn_command_styles_subtitles(self):
        cmd = build_subtitle_burn_command(Path("/tmp/in.mp4"), Path("/tmp/captions.srt"), Path("/tmp/out.mp4"))
        joined = " ".join(cmd)
        self.assertIn("force_style", joined)
        self.assertIn("Outline=2", joined)
        self.assertIn("MarginV=90", joined)

    def test_bgm_mix_command_ducks_music_under_voice(self):
        cmd = build_bgm_mix_command(Path("/tmp/in.mp4"), Path("/tmp/bgm.mp3"), Path("/tmp/out.mp4"))
        joined = " ".join(cmd)
        self.assertIn("sidechaincompress", joined)
        self.assertIn("volume=0.22", joined)
        self.assertIn("duration=first", joined)

    def test_image_prepare_command_outputs_png(self):
        cmd = build_image_prepare_command("/tmp/input.webp", Path("/tmp/out.png"))
        self.assertIn("-frames:v", cmd)
        self.assertIn("format=rgba", cmd)
        self.assertEqual(cmd[-1], "/tmp/out.png")


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

    @patch("render.run")
    @patch("render.has_audio_stream", return_value=False)
    def test_prepare_manifest_media_normalizes_images_and_drops_bad_audio(self, _audio_mock, run_mock):
        with TemporaryDirectory() as tmp:
            project_dir = Path(tmp) / "project"
            work_dir = project_dir / ".render_tmp"
            image = project_dir / "assets" / "ref.webp"
            audio = project_dir / "audio" / "bad.aiff"
            image.parent.mkdir(parents=True)
            audio.parent.mkdir(parents=True)
            image.write_bytes(b"image")
            audio.write_bytes(b"audio")
            manifest = {
                "shots": [
                    {
                        "assetPath": "assets/ref.webp",
                        "audioPath": "audio/bad.aiff",
                    }
                ]
            }
            prepare_manifest_media(project_dir, work_dir, manifest)
            self.assertTrue(str(manifest["shots"][0]["assetPath"]).endswith("shot_000.png"))
            self.assertIsNone(manifest["shots"][0]["audioPath"])
            self.assertEqual(run_mock.call_count, 1)

    def test_prepare_manifest_media_drops_missing_image(self):
        with TemporaryDirectory() as tmp:
            project_dir = Path(tmp) / "project"
            manifest = {"shots": [{"assetPath": "assets/missing.png"}]}
            prepare_manifest_media(project_dir, project_dir / ".render_tmp", manifest)
            self.assertIsNone(manifest["shots"][0]["assetPath"])


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

    def test_has_audio_stream_requires_positive_duration(self):
        with patch(
            "render.probe_media",
            return_value={
                "format": {"duration": "0"},
                "streams": [{"codec_type": "audio", "duration": "0"}],
            },
        ):
            self.assertFalse(has_audio_stream(Path("/tmp/audio.aiff")))


class TestManifestPathBoundary(unittest.TestCase):
    def _manifest(self, **shot_extra):
        shot = {"assetPath": "assets/scene.mp4", "audioPath": "audio/scene.wav"}
        shot.update(shot_extra)
        return {
            "width": 1080,
            "height": 1920,
            "outputFile": "output/final.mp4",
            "captionsFile": "captions/captions.srt",
            "shots": [shot],
        }

    def test_accepts_relative_paths(self):
        with TemporaryDirectory() as tmp:
            validate_manifest_paths(Path(tmp), self._manifest())

    def test_rejects_traversal(self):
        with TemporaryDirectory() as tmp:
            manifest = self._manifest(assetPath="../outside/evil.mp4", assetKind="video")
            with self.assertRaises(RuntimeError):
                validate_manifest_paths(Path(tmp), manifest)

    def test_gates_video_asset_only(self):
        with TemporaryDirectory() as tmp:
            # Reference images may live outside the project (user-supplied);
            # only video assets are boundary-checked.
            validate_manifest_paths(
                Path(tmp), self._manifest(assetPath="/tmp/user-ref.png", assetKind="image")
            )


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
