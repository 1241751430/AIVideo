#!/usr/bin/env python3
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def run(command: list[str]) -> None:
    completed = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "command failed")


def ensure_binary(name: str) -> None:
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
    if not value:
        return None
    candidate = Path(value)
    if candidate.is_absolute():
        return str(candidate)
    return str(project_dir / candidate)


def resolve_project_path(project_dir: Path, value: str, label: str) -> Path:
    candidate = (project_dir / value).resolve()
    project_root = project_dir.resolve()
    if candidate != project_root and project_root not in candidate.parents:
        raise RuntimeError(f"{label} must stay within the project directory")
    return candidate


def escape_drawtext(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("%", "%%")
    )


def escape_filter_path(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("[", "\\[")
        .replace("]", "\\]")
        .replace(",", "\\,")
    )


def build_clip_command(
    clip_path: Path,
    width: int,
    height: int,
    duration: str,
    title: str,
    image_path: str | None,
    audio_path: str | None,
    video_encoder: str = "libx264",
) -> list[str]:
    has_image = bool(image_path and os.path.exists(image_path))
    has_audio = bool(audio_path and os.path.exists(audio_path))

    if has_image:
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

    if has_image:
        command.extend(
            [
                "-vf",
                f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
            ]
        )
    else:
        command.extend(
            [
                "-vf",
                f"drawtext=text='{title}':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=(h-text_h)/2,format=yuv420p",
            ]
        )

    command.extend(
        [
            "-shortest",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            video_encoder,
            "-c:a",
            "aac",
            "-pix_fmt",
            "yuv420p",
            str(clip_path),
        ]
    )
    return command


def make_clip(project_dir: Path, work_dir: Path, shot: dict, width: int, height: int, index: int, video_encoder: str = "libx264") -> Path:
    duration = str(shot["durationSeconds"])
    clip_path = work_dir / f"clip_{index:03d}.mp4"
    image_path = resolve_media_path(project_dir, shot.get("assetPath"))
    audio_path = resolve_media_path(project_dir, shot.get("audioPath"))
    title = escape_drawtext(shot.get("overlayText") or shot.get("title") or "AI Video")
    run(build_clip_command(clip_path, width, height, duration, title, image_path, audio_path, video_encoder))
    return clip_path


def render(project_dir: Path, manifest_path: Path, gpu: bool = False) -> Path:
    ensure_binary("ffmpeg")
    ensure_binary("ffprobe")

    video_encoder = resolve_video_encoder(gpu)
    manifest = json.loads(manifest_path.read_text())
    work_dir = project_dir / ".render_tmp"
    work_dir.mkdir(parents=True, exist_ok=True)

    output_path = resolve_project_path(project_dir, manifest["outputFile"], "Output file")
    captions = resolve_project_path(project_dir, manifest["captionsFile"], "Captions file")
    for shot in manifest["shots"]:
        audio_path = shot.get("audioPath")
        if audio_path:
            resolve_project_path(project_dir, audio_path, "Audio file")

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
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(merged)])

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if captions.exists():
        run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(merged),
                "-vf",
                f"subtitles='{escape_filter_path(captions.as_posix())}'",
                "-c:a",
                "copy",
                str(output_path),
            ]
        )
    else:
        shutil.copyfile(merged, output_path)

    bgm = find_bgm(project_dir)
    if bgm:
        print(f"Mixing BGM: {bgm.name}", flush=True)
        with_bgm = work_dir / "with_bgm.mp4"
        run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(output_path),
                "-i",
                str(bgm),
                "-filter_complex",
                "[1:a]volume=0.3[bgm];[0:a][bgm]amix=inputs=2:duration=first[aout]",
                "-map",
                "0:v",
                "-map",
                "[aout]",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                str(with_bgm),
            ]
        )
        shutil.move(str(with_bgm), str(output_path))

    return output_path


def find_bgm(project_dir: Path) -> Path | None:
    for ext in ("mp3", "wav", "aac", "m4a", "ogg"):
        candidate = project_dir / "audio" / f"bgm.{ext}"
        if candidate.exists():
            return candidate
    return None


def main() -> int:
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
