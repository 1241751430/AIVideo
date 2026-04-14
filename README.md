# AI Video Agent CLI

[English](./README.md) | [简体中文](./README.zh-CN.md)

AI Video Agent CLI is a local AI-powered video production tool. Users only need to provide a topic, key content, or reference images. The agent can then choose a suitable content skill, generate copy, build a storyboard, prepare render assets, and export a video when `ffmpeg` is available.

Recommended runtime mode: Docker first. Host-level execution remains available, but containerized runtime is the preferred path for both local usage and deployment because it provides a stable Node.js, Python, and `ffmpeg` environment.

## Features

- `aivideo init`
  - Initialize project config and sample environment files
- `aivideo skills list`
  - Show built-in content skills
- `aivideo providers test`
  - Validate provider configuration
- `aivideo generate`
  - Generate scripts, storyboards, and optionally render a video from structured brief text or explicit flags
- `aivideo render`
  - Re-render an existing project
- `aivideo cleanup`
  - Remove expired project artifacts from `projects/`

## Requirements

Recommended:

- Docker
- Docker Compose

Alternative host-level runtime:

- Node.js 20+
- pnpm 10+
- Python 3.10+
- `ffmpeg` and `ffprobe`

In Docker mode, you do not need to install `ffmpeg` on the host machine, and you do not need to create a local Python virtual environment.

If `ffmpeg` is not installed, the project can still generate intermediate assets such as copy, storyboard, subtitles, and render manifests, but it cannot export the final video file.

## Hardware Requirements

The current version mainly relies on cloud AI models, local orchestration, and local `ffmpeg` rendering, so a local GPU is not required.

Minimum recommended:

- CPU: 4 cores
- RAM: 8 GB
- Free disk space: 10 GB
- Storage: SSD

Recommended:

- CPU: 8 cores or more
- RAM: 16 GB or more
- Free disk space: 20 GB+
- Storage: SSD

Notes:

- Copy, script, and storyboard generation have very low hardware pressure
- Image-based video assembly depends more on CPU, memory, and disk IO
- The current version does not depend on local GPU inference; if local open-source image or video models are added later, GPU requirements should be raised separately

## Install ffmpeg

You must install both `ffmpeg` and `ffprobe` to use `video` mode and export final videos.

### macOS

If you use Homebrew:

```bash
brew install ffmpeg
```

Verify installation:

```bash
ffmpeg -version
ffprobe -version
```

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install -y ffmpeg
```

### CentOS / Rocky / AlmaLinux

Install `ffmpeg` from the appropriate package source for your distribution and make sure both `ffmpeg` and `ffprobe` are available in `PATH`.

### Common Issues

- If `aivideo generate --mode video` or `aivideo render` reports `ffmpeg is required`, then `ffmpeg` is either not installed or not visible in `PATH`
- If the shell still cannot find it after installation, restart the terminal and check `which ffmpeg` and `which ffprobe`

## Quick Start

### Recommended: Docker

```bash
cp .env.example .env
docker compose build
docker compose run --rm aivideo skills list
docker compose run --rm aivideo providers test
docker compose run --rm aivideo generate --brief "Theme: Summer sunscreen spray; Content: lightweight, non-greasy; Mode: script; Aspect: 9:16; Duration: 30s"
docker compose run --rm aivideo cleanup --keep-days 7
```

In this mode:

- `ffmpeg` is provided inside the container
- Python runs inside the container
- The host machine only needs Docker and Docker Compose
- Generated assets are still written to the local `projects/` directory through the mounted volume

### Alternative: Run On Host

```bash
pnpm install
pnpm build
pnpm cli init
pnpm cli skills list
pnpm cli generate --brief "Theme: Summer sunscreen spray; Content: lightweight, non-greasy; Mode: script; Aspect: 9:16; Duration: 30s"
pnpm cli cleanup --keep-days 7
```

After running `init`, the current directory will contain:

- `aivideo.config.yaml`
- `.env.example`

Add API keys to `.env` to enable remote models. If no remote provider is configured, the CLI falls back to built-in local behavior.

## Natural Language Input

The recommended way to use the CLI is now a structured brief instead of many flags.

Example:

```text
Theme: Summer sunscreen spray; Content: lightweight, non-greasy; Mode: video; Aspect: 9:16; Duration: 30s; Language: zh-CN; Platform: douyin
```

Chinese format also works:

```text
主题：夏季防晒喷雾；主要内容：清爽不油腻；输出模式：video；视频比例：9:16；视频时长：30s；语言：zh-CN；平台：douyin
```

CLI usage:

```bash
pnpm cli generate --brief "主题：夏季防晒喷雾；主要内容：清爽不油腻；输出模式：video；视频比例：9:16；视频时长：30s"
pnpm cli generate --brief-file ./brief.txt --images ./assets/ref1.png,./assets/ref2.jpg
pnpm cli create
```

Notes:

- `create` supports pasting a structured brief directly, or you can press Enter to switch into step-by-step mode
- `create` now defaults to `video` mode, so users do not need to provide an output mode during the guided flow
- After the text questions, `create` will ask whether to upload reference images and will keep asking if more images should be added
- If `language` is explicitly provided, the CLI uses that value; otherwise it auto-detects the language from user input and only falls back to the config default when detection is inconclusive
- `--brief` and `--brief-file` support both Chinese and English keys
- Images can still be provided separately through `--images`

## Deployment Options

The current project is CLI-first. Recommended deployment modes:

- Docker deployment
- Local workstation deployment
- Single Linux server deployment

The repository now includes:

- [Dockerfile](./Dockerfile)
- [docker-compose.yml](./docker-compose.yml)
- [.dockerignore](./.dockerignore)

## Deployment Steps

### Option 1: Docker Deployment

Use this when you want a reproducible runtime and do not want to install Node.js, Python, or `ffmpeg` on the host system. This is the recommended option for both local usage and deployment.

Requirements:

- Docker
- Docker Compose

Steps:

1. Prepare the environment file:

```bash
cp .env.example .env
```

2. Edit `.env` and add provider API keys if remote models are needed.

3. Build the image:

```bash
docker compose build
```

4. Verify the container runtime:

```bash
docker compose run --rm aivideo skills list
docker compose run --rm aivideo providers test
```

5. Run a generation task:

```bash
docker compose run --rm aivideo generate --brief "Theme: Your topic; Mode: script; Duration: 30s"
```

6. To export a final video:

```bash
docker compose run --rm aivideo generate --brief "Theme: Your topic; Mode: video; Duration: 30s"
```

Notes:

- The container already includes `ffmpeg`, `ffprobe`, Node.js, pnpm, and Python
- You do not need a host-level Python virtual environment in this mode
- `projects/` is mounted from the host, so generated assets remain available outside the container
- `aivideo.config.yaml` is mounted read-only into the container
- If you do not want to persist script/storyboard artifacts, add `--no-persist-artifacts`
- If you want temporary render files removed after video export, add `--cleanup-after-render`
- You can remove expired projects with:

```bash
docker compose run --rm aivideo cleanup --keep-days 7
```

### Option 2: Local Deployment

Use this when the operator generates content on the same machine.

1. Install runtime dependencies and verify versions:

```bash
node -v
pnpm -v
python3 --version
ffmpeg -version
ffprobe -version
```

2. Clone the repository or copy the project directory to the local machine.

3. Install dependencies:

```bash
pnpm install
```

4. Build the project:

```bash
pnpm build
```

5. Initialize runtime files:

```bash
pnpm cli init
```

6. Edit `.env` and add provider API keys if remote model access is needed.

7. Verify providers:

```bash
pnpm cli providers test
```

8. Run a generation task:

```bash
pnpm cli generate --brief "Theme: Your topic; Mode: script; Duration: 30s"
```

9. To export a final video, use `video` mode or re-render an existing project:

```bash
pnpm cli generate --brief "Theme: Your topic; Mode: video; Duration: 30s"
pnpm cli render --project <project-id>
```

Useful safety flags:

- `--no-persist-artifacts`
  - Remove script-oriented artifacts such as `brief.json`, `script.md`, and `storyboard.json` after generation
- `--cleanup-after-render`
  - Remove temporary render files such as audio, captions, and temporary render workspace after video export

Cleanup expired projects:

```bash
pnpm cli cleanup --keep-days 7
```

### Option 3: Single Server Deployment

Use this when a dedicated Linux server handles centralized generation or scheduled tasks.

Recommended server baseline:

- 4 vCPU minimum
- 8 GB RAM minimum
- SSD storage
- Stable outbound network access to external model APIs

Deployment steps:

1. Prepare the server and install Node.js 20+, pnpm, Python 3, and `ffmpeg`.

2. Upload or clone the repository to the server.

3. Install dependencies:

```bash
pnpm install
```

4. Build the project:

```bash
pnpm build
```

5. Initialize configuration files:

```bash
pnpm cli init
```

6. Edit `.env` and `aivideo.config.yaml` for the server environment.

7. Verify providers and runtime readiness:

```bash
pnpm cli providers test
```

8. Run generation commands directly, or trigger them through cron, a scheduler, or a CI workflow.

Example:

```bash
pnpm cli generate --brief "Theme: AI office assistant; Skill: knowledge; Mode: video; Duration: 30s"
```

### Deployment Notes

- The current project does not expose an HTTP API by default
- The current deployment model is command-driven, so scheduling is usually handled by cron, CI, or an external workflow system
- Docker is the recommended default runtime for day-to-day usage and deployment
- Generated assets are written under `projects/`, so the deployment user must have write permission there
- In production-like environments, keep API keys only in `.env` or a server-side secret manager, not in committed files
- In Docker mode, the host machine does not need a local Python virtual environment or host-level `ffmpeg`

## Security Notes

- Provider API keys are read from `.env`
- By default, remote provider `baseURL` values are restricted to trusted hosts
- If you need a custom provider gateway, you must explicitly set `allowCustomBaseURL: true` for that provider in `aivideo.config.yaml`
- Input images are restricted to `png`, `jpg`, `jpeg`, and `webp`
- Input images larger than 10 MB are rejected
- Default workload limits are enforced for duration and image count

## Runtime Boundaries

- The current version is optimized for short-form video and image-based assembly
- Long videos are not assumed to be generated in one pass by a single model; instead, the intended workflow is `script -> storyboard -> segmented assets -> local composition`
- If remote image or video models are not configured, the system can still produce copy, storyboard, subtitles, and a base render structure
- Automatic publishing to Douyin, WeChat Channels, Bilibili, or other platforms is not included in the current version
