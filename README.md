# AI Video Agent CLI

[English](./README.md) | [简体中文](./README.zh-CN.md)

AI Video Agent CLI is a local AI-powered video production tool. Users only need to provide a topic, key content, or reference images. The agent can then choose a suitable content skill, generate copy, build a storyboard, prepare render assets, and export a video when `ffmpeg` is available.

## Features

- `aivideo init`
  - Initialize project config and sample environment files
- `aivideo skills list`
  - Show built-in content skills
- `aivideo providers test`
  - Validate provider configuration
- `aivideo generate`
  - Generate scripts, storyboards, and optionally render a video
- `aivideo render`
  - Re-render an existing project

## Requirements

- Node.js 20+
- pnpm 10+
- Python 3.10+
- `ffmpeg` and `ffprobe`

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

```bash
pnpm install
pnpm build
pnpm cli init
pnpm cli skills list
pnpm cli generate --theme "Summer sunscreen spray" --skill ecommerce --mode script
```

After running `init`, the current directory will contain:

- `aivideo.config.yaml`
- `.env.example`

Add API keys to `.env` to enable remote models. If no remote provider is configured, the CLI falls back to built-in local behavior.

## Deployment Options

The current project is CLI-first. Recommended deployment modes:

- Local workstation deployment
- Single Linux server deployment

Docker packaging is not included yet. If containerized deployment is required later, it should be added as a separate deliverable.

## Deployment Steps

### Option 1: Local Deployment

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
pnpm cli generate --theme "Your topic" --skill auto --mode script --duration 30s
```

9. To export a final video, use `video` mode or re-render an existing project:

```bash
pnpm cli generate --theme "Your topic" --skill auto --mode video --duration 30s
pnpm cli render --project <project-id>
```

### Option 2: Single Server Deployment

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
pnpm cli generate --theme "AI office assistant" --skill knowledge --mode video --duration 30s
```

### Deployment Notes

- The current project does not expose an HTTP API by default
- The current deployment model is command-driven, so scheduling is usually handled by cron, CI, or an external workflow system
- Generated assets are written under `projects/`, so the deployment user must have write permission there
- In production-like environments, keep API keys only in `.env` or a server-side secret manager, not in committed files

## Runtime Boundaries

- The current version is optimized for short-form video and image-based assembly
- Long videos are not assumed to be generated in one pass by a single model; instead, the intended workflow is `script -> storyboard -> segmented assets -> local composition`
- If remote image or video models are not configured, the system can still produce copy, storyboard, subtitles, and a base render structure
- Automatic publishing to Douyin, WeChat Channels, Bilibili, or other platforms is not included in the current version
