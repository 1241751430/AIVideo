#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def run(command: list[str]) -> None:
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "command failed")


def ensure_binary(name: str) -> None:
    if shutil.which(name) is None:
        raise RuntimeError(f"{name} is required but not found in PATH")


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
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


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
) -> list[str]:
    has_image = bool(image_path and os.path.exists(image_path))
    has_audio = bool(audio_path and os.path.exists(audio_path))

    if has_image:
        command = [
            "ffmpeg",
            "-y",
            "-loop",
            "1",
            "-i",
            image_path,
        ]
    else:
        command = [
            "ffmpeg",
            "-y",
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
            "libx264",
            "-c:a",
            "aac",
            "-pix_fmt",
            "yuv420p",
            str(clip_path),
        ]
    )
    return command


def make_clip(project_dir: Path, work_dir: Path, shot: dict, width: int, height: int, index: int) -> Path:
    duration = str(shot["durationSeconds"])
    clip_path = work_dir / f"clip_{index:03d}.mp4"
    image_path = resolve_media_path(project_dir, shot.get("assetPath"))
    audio_path = resolve_media_path(project_dir, shot.get("audioPath"))
    title = escape_drawtext(shot.get("overlayText") or shot.get("title") or "AI Video")
    run(build_clip_command(clip_path, width, height, duration, title, image_path, audio_path))
    return clip_path


def render(project_dir: Path, manifest_path: Path) -> Path:
    ensure_binary("ffmpeg")
    ensure_binary("ffprobe")

    manifest = json.loads(manifest_path.read_text())
    work_dir = project_dir / ".render_tmp"
    work_dir.mkdir(parents=True, exist_ok=True)

    output_path = resolve_project_path(project_dir, manifest["outputFile"], "Output file")
    captions = resolve_project_path(project_dir, manifest["captionsFile"], "Captions file")
    for shot in manifest["shots"]:
        audio_path = shot.get("audioPath")
        if audio_path:
            resolve_project_path(project_dir, audio_path, "Audio file")

    clips: list[Path] = []
    for index, shot in enumerate(manifest["shots"]):
        clips.append(make_clip(project_dir, work_dir, shot, manifest["width"], manifest["height"], index))

    concat_file = work_dir / "concat.txt"
    concat_file.write_text("".join(f"file '{clip.as_posix()}'\n" for clip in clips))
    merged = work_dir / "merged.mp4"
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(merged)])

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if captions.exists():
        run(
            [
                "ffmpeg",
                "-y",
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

    return output_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()

    project_dir = Path(args.project_dir).resolve()
    manifest_path = Path(args.manifest).resolve()

    try:
        output = render(project_dir, manifest_path)
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        return 1

    print(str(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
