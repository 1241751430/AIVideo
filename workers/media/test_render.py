#!/usr/bin/env python3
"""Unit tests for render.py pure functions (no ffmpeg required).

@author zhangbaohong
@date 2026-09-17
@see https://github.com/1241751430/AIVideo.git
"""
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
        """
        功能：验证冒号按 drawtext 规则被转义
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        self.assertEqual(escape_drawtext("a:b"), "a\\:b")

    def test_backslash(self):
        """
        功能：验证反斜杠被双倍转义
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        self.assertEqual(escape_drawtext("a\\b"), "a\\\\b")

    def test_single_quote(self):
        """
        功能：验证单引号被转义
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        self.assertEqual(escape_drawtext("it's"), "it\\'s")

    def test_percent(self):
        """
        功能：验证百分号被转义为双百分号
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        self.assertEqual(escape_drawtext("50%"), "50%%")


class TestEscapeFilterPath(unittest.TestCase):
    def test_brackets(self):
        """
        功能：验证路径中的方括号被转义
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        self.assertEqual(escape_filter_path("[a]"), "\\[a\\]")

    def test_comma(self):
        """
        功能：验证路径中的逗号被转义
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        self.assertEqual(escape_filter_path("a,b"), "a\\,b")


class TestResolveMediaPath(unittest.TestCase):
    def test_none(self):
        """
        功能：验证 None 路径解析结果为 None
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        self.assertIsNone(resolve_media_path(Path("/p"), None))

    def test_empty(self):
        """
        功能：验证空字符串路径解析结果为 None
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        self.assertIsNone(resolve_media_path(Path("/p"), ""))

    def test_relative(self):
        """
        功能：验证相对路径与项目目录拼接为绝对路径
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        self.assertEqual(resolve_media_path(Path("/p"), "audio/x.wav"), "/p/audio/x.wav")

    def test_absolute(self):
        """
        功能：验证绝对路径原样返回
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        self.assertEqual(resolve_media_path(Path("/p"), "/tmp/x.wav"), "/tmp/x.wav")


class TestResolveProjectPath(unittest.TestCase):
    def test_stays_within(self):
        """
        功能：验证项目内路径可正常解析且保持在项目目录内
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        result = resolve_project_path(Path("/app/project/demo"), "output/final.mp4", "Output")
        self.assertTrue(str(result).startswith("/app/project/demo"))

    def test_escapes_project(self):
        """
        功能：验证越出项目边界的穿越路径被拒绝
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        with self.assertRaises(RuntimeError):
            resolve_project_path(Path("/app/project/demo"), "../../etc/passwd", "Bad")


class TestBuildClipCommand(unittest.TestCase):
    def test_title_card_has_duration_and_drawtext(self):
        """
        功能：验证标题卡命令含 lavfi 背景、drawtext 绘制与基础编码参数
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
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
        """
        功能：验证图片命令含循环输入、时长限制与 zoompan 动效滤镜
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
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
        """
        功能：验证片段命令固定采样率、码率并启用 faststart
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
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
        """
        功能：验证图片配旁白时用 apad 补齐到精确时长且不使用 -shortest
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
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
        """
        功能：验证视频素材配旁白时循环补齐并固定输出时长
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
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
        """
        功能：验证标题卡分支保留 -shortest 且不追加 apad
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        # No visual asset: both streams are already duration-bound, so the
        # title-card branch keeps -shortest (and must not gain -af apad).
        cmd = build_clip_command(
            Path("/tmp/clip.mp4"), 1080, 1920, "5", "Hello", None, "/tmp/narr.wav"
        )
        self.assertIn("-shortest", cmd)
        self.assertNotIn("apad", cmd)

    def test_title_card_fallback_has_no_drawtext(self):
        """
        功能：验证兜底标题卡命令不含 drawtext 且使用 libx264
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        cmd = build_title_card_fallback_command(
            Path("/tmp/clip.mp4"), 1080, 1920, "5", None
        )
        self.assertNotIn("drawtext", " ".join(cmd))
        self.assertIn("libx264", cmd)
        self.assertIn("-crf", cmd)

    def test_subtitle_burn_command_styles_subtitles(self):
        """
        功能：验证字幕烧录命令包含样式与边距参数
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        cmd = build_subtitle_burn_command(Path("/tmp/in.mp4"), Path("/tmp/captions.srt"), Path("/tmp/out.mp4"))
        joined = " ".join(cmd)
        self.assertIn("force_style", joined)
        self.assertIn("Outline=2", joined)
        self.assertIn("MarginV=90", joined)

    def test_bgm_mix_command_ducks_music_under_voice(self):
        """
        功能：验证 BGM 混音命令使用侧链压缩让人声优先
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        cmd = build_bgm_mix_command(Path("/tmp/in.mp4"), Path("/tmp/bgm.mp3"), Path("/tmp/out.mp4"))
        joined = " ".join(cmd)
        self.assertIn("sidechaincompress", joined)
        self.assertIn("volume=0.22", joined)
        self.assertIn("duration=first", joined)

    def test_image_prepare_command_outputs_png(self):
        """
        功能：验证图片准备命令输出单帧 PNG
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        cmd = build_image_prepare_command("/tmp/input.webp", Path("/tmp/out.png"))
        self.assertIn("-frames:v", cmd)
        self.assertIn("format=rgba", cmd)
        self.assertEqual(cmd[-1], "/tmp/out.png")


class TestManifestValidation(unittest.TestCase):
    def test_rejects_empty_shots(self):
        """
        功能：验证空分镜列表的清单被拒绝
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        with self.assertRaises(RuntimeError):
            validate_manifest({"width": 1080, "height": 1920, "shots": []})

    def test_rejects_invalid_duration(self):
        """
        功能：验证非正数的分镜时长被拒绝
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        with self.assertRaises(RuntimeError):
            normalize_positive_number(0, "duration")

    def test_normalizes_valid_duration(self):
        """
        功能：验证合法时长被规范化到三位小数
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        manifest = {"width": 1080, "height": 1920, "shots": [{"durationSeconds": 1.23456}]}
        validate_manifest(manifest)
        self.assertEqual(manifest["shots"][0]["durationSeconds"], 1.235)


class TestFallbacks(unittest.TestCase):
    @patch("render.os.path.exists", return_value=True)
    @patch("render.run")
    def test_image_or_audio_clip_failure_falls_back_to_plain_title_card_with_silent_audio(self, run_mock, _exists_mock):
        """
        功能：验证图片或音频渲染失败时回退为带静音音轨的纯标题卡
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
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
        """
        功能：验证素材预处理将图片归一化为 PNG 并丢弃无有效流的音频
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
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
        """
        功能：验证素材预处理会丢弃不存在的图片路径
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        with TemporaryDirectory() as tmp:
            project_dir = Path(tmp) / "project"
            manifest = {"shots": [{"assetPath": "assets/missing.png"}]}
            prepare_manifest_media(project_dir, project_dir / ".render_tmp", manifest)
            self.assertIsNone(manifest["shots"][0]["assetPath"])


class TestOutputValidation(unittest.TestCase):
    def test_accepts_valid_video_probe(self):
        """
        功能：验证探测结果分辨率与时长匹配时输出校验通过
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
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
        """
        功能：验证分辨率不匹配的输出视频被拒绝
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
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
        """
        功能：验证音频流必须具有正时长才算有效
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
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
        """
        功能：构造用于路径边界测试的清单夹具
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
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
        """
        功能：验证项目内的相对路径清单通过校验
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        with TemporaryDirectory() as tmp:
            validate_manifest_paths(Path(tmp), self._manifest())

    def test_rejects_traversal(self):
        """
        功能：验证穿越出项目目录的视频素材路径被拒绝
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        with TemporaryDirectory() as tmp:
            manifest = self._manifest(assetPath="../outside/evil.mp4", assetKind="video")
            with self.assertRaises(RuntimeError):
                validate_manifest_paths(Path(tmp), manifest)

    def test_gates_video_asset_only(self):
        """
        功能：验证仅视频素材受项目边界检查约束
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        with TemporaryDirectory() as tmp:
            # Reference images may live outside the project (user-supplied);
            # only video assets are boundary-checked.
            validate_manifest_paths(
                Path(tmp), self._manifest(assetPath="/tmp/user-ref.png", assetKind="image")
            )


class TestFindBgm(unittest.TestCase):
    def test_no_bgm(self):
        """
        功能：验证无 BGM 文件时返回 None
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        self.assertIsNone(find_bgm(Path("/nonexistent")))

    @patch("render.Path.exists", return_value=True)
    def test_finds_mp3(self, _mock):
        """
        功能：验证能在 audio 目录下找到 bgm.mp3 文件
        @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
        """
        result = find_bgm(Path("/project"))
        self.assertIsNotNone(result)
        self.assertTrue(str(result).endswith("bgm.mp3"))


if __name__ == "__main__":
    unittest.main()
