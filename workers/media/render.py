#!/usr/bin/env python3
"""
媒体渲染脚本：驱动 ffmpeg 将标题卡、图片与视频素材按分镜渲染为片段，再拼接、烧录字幕并混入 BGM 产出最终视频。

@author zhangbaohong
@date 2026-09-17
@see https://github.com/1241751430/AIVideo.git
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

OUTPUT_FPS = "30"
VIDEO_CRF = "20"
AUDIO_SAMPLE_RATE = "48000"
AUDIO_BITRATE = "192k"


def run(command: list[str]) -> None:
    """
    功能：执行外部命令，命令失败时抛出 RuntimeError
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    completed = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "command failed")


def warn(message: str) -> None:
    """
    功能：向控制台输出 WARNING 级别的警告信息
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    print(f"WARNING: {message}", flush=True)


def ensure_binary(name: str) -> None:
    """
    功能：检查指定二进制程序存在于 PATH 中，否则抛出异常
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    if shutil.which(name) is None:
        raise RuntimeError(f"{name} is required but not found in PATH")


def detect_gpu_encoder() -> str | None:
    """Detect available hardware video encoder via ffmpeg.

    Returns the encoder name if a supported GPU encoder is found,
    or None if only CPU encoding is available.

    Detection order:
    - macOS: h264_videotoolbox (Apple VideoToolbox)
    - Linux/Windows NVIDIA: h264_nvenc
    - Linux VAAPI: h264_vaapi

    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    candidates: list[str]
    if platform.system() == "Darwin":
        candidates = ["h264_videotoolbox"]
    elif platform.system() == "Linux":
        candidates = ["h264_nvenc", "h264_vaapi"]
    elif platform.system() == "Windows":
        candidates = ["h264_nvenc", "h264_amf"]
    else:
        candidates = ["h264_nvenc"]

    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
        )
        encoder_output = result.stdout
    except Exception:
        return None

    for encoder in candidates:
        if encoder in encoder_output:
            return encoder
    return None


def resolve_video_encoder(gpu_flag: bool) -> str:
    """Return the video encoder to use.

    When *gpu_flag* is True the function tries to auto-detect a hardware
    encoder.  If detection fails it falls back to ``libx264`` and prints
    a warning.

    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    if not gpu_flag:
        return "libx264"

    encoder = detect_gpu_encoder()
    if encoder:
        print(f"GPU encoder detected: {encoder}", flush=True)
        return encoder

    print("WARNING: --gpu enabled but no hardware encoder found, falling back to libx264", flush=True)
    return "libx264"


def resolve_media_path(project_dir: Path, value: str | None) -> str | None:
    """
    功能：将相对项目目录的媒体路径解析为绝对路径，空值返回 None
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    if not value:
        return None
    candidate = Path(value)
    if candidate.is_absolute():
        return str(candidate)
    return str(project_dir / candidate)


def resolve_project_path(project_dir: Path, value: str, label: str) -> Path:
    """
    功能：解析项目内路径并拒绝越出项目目录边界的访问
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    candidate = (project_dir / value).resolve()
    project_root = project_dir.resolve()
    if candidate != project_root and project_root not in candidate.parents:
        raise RuntimeError(f"{label} must stay within the project directory")
    return candidate


def escape_drawtext(value: str) -> str:
    """
    功能：转义 drawtext 滤镜文本参数中的特殊字符
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    return (
        value.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("%", "%%")
    )


def escape_filter_path(value: str) -> str:
    """
    功能：转义滤镜表达式中文件路径的特殊字符
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    return (
        value.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("[", "\\[")
        .replace("]", "\\]")
        .replace(",", "\\,")
    )


def build_image_filter(width: int, height: int, duration: str) -> str:
    """
    功能：构建图片的放大缩放（zoompan）动效与淡入淡出滤镜链
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    frames = max(1, int(round(float(duration) * int(OUTPUT_FPS))))
    return (
        f"scale={width * 2}:{height * 2}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},"
        f"zoompan=z='min(zoom+0.0008,1.08)':d={frames}:s={width}x{height}:fps={OUTPUT_FPS},"
        f"fade=t=in:st=0:d=0.25,fade=t=out:st=max(0\\,{float(duration) - 0.35:.3f}):d=0.35,"
        "format=yuv420p"
    )


def build_video_filter(width: int, height: int, duration: str) -> str:
    """
    功能：构建视频的缩放裁切、统一帧率与淡入淡出滤镜链
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},"
        f"fps={OUTPUT_FPS},"
        f"fade=t=in:st=0:d=0.25,fade=t=out:st=max(0\\,{float(duration) - 0.35:.3f}):d=0.35,"
        "format=yuv420p"
    )


def build_title_card_filter(width: int, height: int, title: str) -> str:
    """
    功能：构建标题卡的渐变背景、装饰条与文字绘制滤镜链
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    title_size = max(44, min(72, width // 18))
    accent_height = max(10, height // 120)
    return (
        f"geq=r='16+34*Y/H':g='24+24*X/W':b='38+70*(1-Y/H)',"
        f"drawbox=x=0:y={height - accent_height}:w={width}:h={accent_height}:color=0x6d5dfc@0.95:t=fill,"
        f"drawbox=x={width * 0.08:.0f}:y={height * 0.34:.0f}:w={width * 0.84:.0f}:h={height * 0.28:.0f}:color=black@0.35:t=fill,"
        f"drawtext=text='{title}':fontcolor=white:fontsize={title_size}:line_spacing=16:"
        "box=1:boxcolor=black@0.22:boxborderw=28:x=(w-text_w)/2:y=(h-text_h)/2,"
        "format=yuv420p"
    )


def append_output_quality_settings(command: list[str], video_encoder: str) -> None:
    """
    功能：向 ffmpeg 命令追加统一的帧率、视频编码与音频质量参数
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    command.extend(["-r", OUTPUT_FPS, "-c:v", video_encoder])
    if video_encoder == "libx264":
        command.extend(["-preset", "medium", "-crf", VIDEO_CRF])
    command.extend(
        [
            "-c:a",
            "aac",
            "-ar",
            AUDIO_SAMPLE_RATE,
            "-b:a",
            AUDIO_BITRATE,
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ]
    )


def build_subtitle_burn_command(input_path: Path, captions: Path, output_path: Path) -> list[str]:
    """
    功能：构建将字幕烧录进视频的 ffmpeg 命令
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    style = "FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=90,Alignment=2"
    return [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-vf",
        f"subtitles='{escape_filter_path(captions.as_posix())}':force_style='{style}'",
        "-c:a",
        "copy",
        str(output_path),
    ]


def build_bgm_mix_command(input_path: Path, bgm: Path, output_path: Path) -> list[str]:
    """
    功能：构建将 BGM 经侧链压缩给人声让路后混音的 ffmpeg 命令
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    return [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-stream_loop",
        "-1",
        "-i",
        str(bgm),
        "-filter_complex",
        "[1:a]volume=0.22[bgm];[bgm][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=500[ducked];[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=2[aout]",
        "-map",
        "0:v",
        "-map",
        "[aout]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-ar",
        AUDIO_SAMPLE_RATE,
        "-b:a",
        AUDIO_BITRATE,
        str(output_path),
    ]


def build_clip_command(
    clip_path: Path,
    width: int,
    height: int,
    duration: str,
    title: str,
    image_path: str | None,
    audio_path: str | None,
    video_encoder: str = "libx264",
    asset_kind: str = "image",
) -> list[str]:
    """
    功能：根据素材类型（视频/图片/标题卡）构建单个分镜片段的渲染 ffmpeg 命令
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    has_video_asset = asset_kind == "video" and bool(image_path and os.path.exists(image_path))
    has_image = (not has_video_asset) and bool(image_path and os.path.exists(image_path))
    has_audio = bool(audio_path and os.path.exists(audio_path))

    if has_video_asset:
        # Loop the generated clip so a short clip still fills the shot's
        # planned duration; -t on this input caps it there exactly.
        command = [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-stream_loop",
            "-1",
            "-t",
            duration,
            "-i",
            image_path,
        ]
    elif has_image:
        command = [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-loop",
            "1",
            "-t",
            duration,
            "-i",
            image_path,
        ]
    else:
        command = [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c=0x101826:s={width}x{height}:d={duration}",
        ]

    if has_audio:
        # Cap the narration input at the planned duration so the output can
        # reach exactly -t without -shortest ending it early when the clip
        # loops; when narration is shorter than the shot, the (video-less)
        # audio stream simply pads with silence at the end.
        command.extend(["-t", duration, "-i", audio_path])
    else:
        command.extend(
            [
                "-f",
                "lavfi",
                "-t",
                duration,
                "-i",
                "anullsrc=channel_layout=stereo:sample_rate=44100",
            ]
        )

    if has_video_asset:
        command.extend(
            [
                "-vf",
                build_video_filter(width, height, duration),
            ]
        )
    elif has_image:
        command.extend(
            [
                "-vf",
                build_image_filter(width, height, duration),
            ]
        )
    else:
        command.extend(
            [
                "-vf",
                build_title_card_filter(width, height, title),
            ]
        )

    # The image and video branches already bound their visual stream to
    # `duration` (via -loop 1 -t / -stream_loop -1 -t on the input). When they
    # also carry narration, we must NOT use -shortest: it would trim the clip to
    # the (usually shorter) narration audio and desync the fixed-length caption
    # timeline. Instead pad the audio with silence (-af apad) and pin the output
    # to exactly -t duration, so every clip is precisely durationSeconds long and
    # the concatenated total matches the SRT. The title-card branch has no such
    # asset and keeps -shortest (both its streams are already duration-bound).
    has_visual_asset = has_video_asset or has_image
    if has_visual_asset and has_audio:
        command.extend(
            [
                "-af",
                "apad",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-t",
                duration,
            ]
        )
    else:
        command.extend(
            [
                "-shortest",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
            ]
        )
    append_output_quality_settings(command, video_encoder)
    command.append(str(clip_path))
    return command


def build_title_card_fallback_command(
    clip_path: Path,
    width: int,
    height: int,
    duration: str,
    audio_path: str | None,
    video_encoder: str = "libx264",
) -> list[str]:
    """
    功能：构建素材渲染失败时兜底的纯色标题卡 ffmpeg 命令
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    command = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        f"color=c=0x101826:s={width}x{height}:d={duration}",
    ]
    if audio_path and os.path.exists(audio_path):
        command.extend(["-i", audio_path])
    else:
        command.extend(
            [
                "-f",
                "lavfi",
                "-t",
                duration,
                "-i",
                "anullsrc=channel_layout=stereo:sample_rate=44100",
            ]
        )
    command.extend(
        [
            "-shortest",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-vf",
            "format=yuv420p",
        ]
    )
    append_output_quality_settings(command, video_encoder)
    command.append(str(clip_path))
    return command


def build_image_prepare_command(source_path: str, target_path: Path) -> list[str]:
    """
    功能：构建将源图片归一化为单帧 PNG 的 ffmpeg 命令
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    return [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        source_path,
        "-frames:v",
        "1",
        "-vf",
        "format=rgba",
        str(target_path),
    ]


def prepare_manifest_media(project_dir: Path, work_dir: Path, manifest: dict) -> None:
    """
    功能：批量预处理清单中所有分镜引用的图片与音频素材
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    assets_dir = work_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    for index, shot in enumerate(manifest["shots"]):
        prepare_shot_image(project_dir, assets_dir, shot, index)
        prepare_shot_audio(project_dir, shot, index)


def prepare_shot_image(project_dir: Path, assets_dir: Path, shot: dict, index: int) -> None:
    """
    功能：预处理单个分镜的图片/视频素材，不可用时降级为标题卡
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    image_path = resolve_media_path(project_dir, shot.get("assetPath"))
    if not image_path:
        return
    if shot.get("assetKind") == "video":
        # Video assets are already real motion clips; ffmpeg can consume them
        # directly. Probe for a usable video stream instead of normalizing to PNG.
        if not os.path.exists(image_path):
            warn(f"video asset missing for shot {index + 1}; using title card")
            shot["assetPath"] = None
            return
        try:
            if not has_video_stream(Path(image_path)):
                warn(f"video asset has no readable stream for shot {index + 1}; using title card")
                shot["assetPath"] = None
        except RuntimeError as exc:
            warn(f"video asset could not be probed for shot {index + 1}; using title card: {exc}")
            shot["assetPath"] = None
        return
    if not os.path.exists(image_path):
        warn(f"image asset missing for shot {index + 1}; using title card")
        shot["assetPath"] = None
        return
    prepared_path = assets_dir / f"shot_{index:03d}.png"
    try:
        run(build_image_prepare_command(image_path, prepared_path))
        shot["assetPath"] = str(prepared_path)
    except RuntimeError as exc:
        warn(f"image asset could not be normalized for shot {index + 1}; using title card: {exc}")
        shot["assetPath"] = None


def prepare_shot_audio(project_dir: Path, shot: dict, index: int) -> None:
    """
    功能：预处理单个分镜的旁白音频，不可用时降级为静音
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    audio_path = resolve_media_path(project_dir, shot.get("audioPath"))
    if not audio_path:
        return
    if not os.path.exists(audio_path):
        shot["audioPath"] = None
        return
    try:
        if not has_audio_stream(Path(audio_path)):
            warn(f"audio has no readable stream for shot {index + 1}; using silence")
            shot["audioPath"] = None
    except RuntimeError as exc:
        warn(f"audio could not be probed for shot {index + 1}; using silence: {exc}")
        shot["audioPath"] = None


def make_clip(project_dir: Path, work_dir: Path, shot: dict, width: int, height: int, index: int, video_encoder: str = "libx264") -> Path:
    """
    功能：渲染单个分镜片段的 mp4 文件，失败时依次回退软编码与纯标题卡
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    duration_seconds = normalize_positive_number(shot.get("durationSeconds"), f"Shot {index + 1} duration")
    duration = str(duration_seconds)
    clip_path = work_dir / f"clip_{index:03d}.mp4"
    image_path = resolve_media_path(project_dir, shot.get("assetPath"))
    audio_path = resolve_media_path(project_dir, shot.get("audioPath"))
    title = escape_drawtext(shot.get("overlayText") or shot.get("title") or "AI Video")
    asset_kind = shot.get("assetKind") or "image"
    errors: list[str] = []
    try:
        run(build_clip_command(clip_path, width, height, duration, title, image_path, audio_path, video_encoder, asset_kind))
        return clip_path
    except RuntimeError as exc:
        errors.append(str(exc))
    if video_encoder != "libx264":
        try:
            run(build_clip_command(clip_path, width, height, duration, title, image_path, audio_path, "libx264", asset_kind))
            return clip_path
        except RuntimeError as exc:
            errors.append(str(exc))

    fallback_reason = "image/audio processing failed" if image_path else "drawtext failed"
    warn(f"{fallback_reason} for shot {index + 1}; rendering plain title card with silent audio")
    try:
        run(build_title_card_fallback_command(clip_path, width, height, duration, None, "libx264"))
    except RuntimeError:
        raise RuntimeError(f"Shot {index + 1} failed after fallback attempts: {' | '.join(errors)}")
    return clip_path


def validate_manifest(manifest: dict) -> None:
    """
    功能：校验并规范化渲染清单的宽高与分镜时长字段
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    width = normalize_positive_int(manifest.get("width"), "Manifest width")
    height = normalize_positive_int(manifest.get("height"), "Manifest height")
    shots = manifest.get("shots")
    if not isinstance(shots, list) or len(shots) == 0:
        raise RuntimeError("Manifest must contain at least one shot")
    manifest["width"] = width
    manifest["height"] = height
    for index, shot in enumerate(shots):
        if not isinstance(shot, dict):
            raise RuntimeError(f"Shot {index + 1} must be an object")
        shot["durationSeconds"] = normalize_positive_number(shot.get("durationSeconds"), f"Shot {index + 1} duration")


def normalize_positive_int(value: object, label: str) -> int:
    """
    功能：校验取值为正整数并返回，非法时抛出异常
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise RuntimeError(f"{label} must be a positive integer")
    return value


def normalize_positive_number(value: object, label: str) -> float:
    """
    功能：校验取值为正数并四舍五入到三位小数返回，非法时抛出异常
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise RuntimeError(f"{label} must be a positive number")
    return round(float(value), 3)


def probe_media(path: Path) -> dict:
    """
    功能：调用 ffprobe 获取媒体文件的格式与流信息字典
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "ffprobe failed")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"ffprobe returned invalid JSON: {exc}") from exc


def probe_video(path: Path) -> dict:
    """
    功能：探测视频文件的媒体信息
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    return probe_media(path)


def has_audio_stream(path: Path) -> bool:
    """
    功能：判断媒体文件是否包含时长为正的音频流
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    probe = probe_media(path)
    streams = probe.get("streams")
    if not isinstance(streams, list):
        return False
    audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if not audio_stream:
        return False
    return parse_probe_duration(probe, audio_stream) > 0


def has_video_stream(path: Path) -> bool:
    """
    功能：判断媒体文件是否包含时长为正的视频流
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    probe = probe_media(path)
    streams = probe.get("streams")
    if not isinstance(streams, list):
        return False
    video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if not video_stream:
        return False
    return parse_probe_duration(probe, video_stream) > 0


def validate_output_video(path: Path, width: int, height: int) -> None:
    """
    功能：校验渲染产出的视频存在、含视频流、分辨率匹配且时长为正
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    if not path.exists() or path.stat().st_size <= 0:
        raise RuntimeError(f"Rendered video is missing or empty: {path}")
    probe = probe_video(path)
    streams = probe.get("streams")
    if not isinstance(streams, list):
        raise RuntimeError("Rendered video has no readable streams")
    video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if not video_stream:
        raise RuntimeError("Rendered video has no video stream")
    if video_stream.get("width") != width or video_stream.get("height") != height:
        raise RuntimeError(
            f"Rendered video resolution mismatch: expected {width}x{height}, got {video_stream.get('width')}x{video_stream.get('height')}"
        )
    duration = parse_probe_duration(probe, video_stream)
    if duration <= 0:
        raise RuntimeError("Rendered video duration is zero")


def parse_probe_duration(probe: dict, video_stream: dict) -> float:
    """
    功能：从 ffprobe 结果中解析时长秒数，优先 format 再回退到流字段
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    for value in (probe.get("format", {}).get("duration"), video_stream.get("duration")):
        try:
            duration = float(value)
        except (TypeError, ValueError):
            continue
        if duration > 0:
            return duration
    return 0.0


def validate_manifest_paths(project_dir: Path, manifest: dict) -> Path:
    """Resolve every manifest-declared file, rejecting paths outside the project.

    Video assets are pipeline-generated files that must live under the project;
    reference images (assetKind "image") may legitimately be user-supplied
    paths outside it, so only video is gated here.

    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    output_path = resolve_project_path(project_dir, manifest["outputFile"], "Output file")
    resolve_project_path(project_dir, manifest["captionsFile"], "Captions file")
    for shot in manifest["shots"]:
        audio_path = shot.get("audioPath")
        if audio_path:
            resolve_project_path(project_dir, audio_path, "Audio file")
        if shot.get("assetKind") == "video" and shot.get("assetPath"):
            resolve_project_path(project_dir, shot["assetPath"], "Video asset")
    return output_path


def render(project_dir: Path, manifest_path: Path, gpu: bool = False) -> Path:
    """
    功能：完整渲染流程——并行生成各分镜片段、拼接、烧录字幕、混入 BGM 并最终校验
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    ensure_binary("ffmpeg")
    ensure_binary("ffprobe")

    video_encoder = resolve_video_encoder(gpu)
    manifest = json.loads(manifest_path.read_text())
    validate_manifest(manifest)
    work_dir = project_dir / ".render_tmp"
    work_dir.mkdir(parents=True, exist_ok=True)

    output_path = validate_manifest_paths(project_dir, manifest)
    captions = resolve_project_path(project_dir, manifest["captionsFile"], "Captions file")
    prepare_manifest_media(project_dir, work_dir, manifest)

    total_shots = len(manifest["shots"])
    clips: list[Path | None] = [None] * total_shots
    max_workers = min(4, total_shots) if total_shots > 1 else 1
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(
                make_clip, project_dir, work_dir, shot, manifest["width"], manifest["height"], index, video_encoder
            ): index
            for index, shot in enumerate(manifest["shots"])
        }
        for future in as_completed(futures):
            idx = futures[future]
            clips[idx] = future.result()
            print(f"Clip {idx + 1}/{total_shots} rendered", flush=True)

    concat_file = work_dir / "concat.txt"
    concat_file.write_text(
        "".join(
            f"file '{clip.as_posix().replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'\n"
            for clip in clips
        )
    )
    merged = work_dir / "merged.mp4"
    try:
        run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(merged)])
    except RuntimeError:
        warn("stream-copy concat failed; retrying with re-encode")
        run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_file),
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                "-pix_fmt",
                "yuv420p",
                str(merged),
            ]
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if captions.exists():
        try:
            run(build_subtitle_burn_command(merged, captions, output_path))
        except RuntimeError as exc:
            warn(f"subtitle burn-in failed; continuing without subtitles: {exc}")
            shutil.copyfile(merged, output_path)
    else:
        shutil.copyfile(merged, output_path)

    bgm = find_bgm(project_dir)
    if bgm:
        print(f"Mixing BGM: {bgm.name}", flush=True)
        with_bgm = work_dir / "with_bgm.mp4"
        try:
            run(build_bgm_mix_command(output_path, bgm, with_bgm))
            shutil.move(str(with_bgm), str(output_path))
        except RuntimeError as exc:
            warn(f"BGM mix failed; keeping video without BGM: {exc}")

    validate_output_video(output_path, manifest["width"], manifest["height"])

    return output_path


def find_bgm(project_dir: Path) -> Path | None:
    """
    功能：在项目 audio 目录下按支持的扩展名查找 BGM 音频文件
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    for ext in ("mp3", "wav", "aac", "m4a", "ogg"):
        candidate = project_dir / "audio" / f"bgm.{ext}"
        if candidate.exists():
            return candidate
    return None


def main() -> int:
    """
    功能：命令行入口，解析参数并执行渲染，失败时输出错误并返回非零退出码
    @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--gpu", action="store_true", default=False, help="Enable GPU-accelerated encoding")
    args = parser.parse_args()

    project_dir = Path(args.project_dir).resolve()
    manifest_path = Path(args.manifest).resolve()

    try:
        output = render(project_dir, manifest_path, gpu=args.gpu)
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        return 1

    print(str(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
