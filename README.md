# AI Video Agent CLI

[English](./README.md) | [简体中文](./README.zh-CN.md)

AI Video Agent CLI is a local AI-powered video production tool. Provide a topic, key content, or reference images — the agent picks a content skill, generates copy & storyboard, prepares render assets, and exports a video when `ffmpeg` is available.

## 30-Second Quick Start

```bash
# Clone, then run one command
./aivideo create
```

The launcher script handles everything automatically:

- First run: creates `.env`, builds the Docker image (if Docker is available) or runs `pnpm install && pnpm build`
- First `create`/`generate`: auto-runs `init` to generate `aivideo.config.yaml`
- Enters interactive mode — just describe the video you want

> To use remote models (OpenAI / Qwen / Doubao etc.), add API keys to `.env` first.

Non-interactive example:

```bash
./aivideo generate --brief "Theme: Summer sunscreen spray; Content: lightweight; Duration: 30s"
```

## Requirements

**Recommended: Docker + Docker Compose** (no host-level Node.js / Python / ffmpeg needed)

Alternative host-level: Node.js 20+ · pnpm 10+ · Python 3.10+ · ffmpeg/ffprobe

> Without `ffmpeg` you can still generate scripts, storyboards, and subtitles, but cannot export the final video.

<details>
<summary>Installing ffmpeg (host-level only)</summary>

**macOS**: `brew install ffmpeg`

**Ubuntu / Debian**: `sudo apt update && sudo apt install -y ffmpeg`

**CentOS / Rocky**: install from your distro's package source; ensure both `ffmpeg` and `ffprobe` are in `PATH`.

Verify: `ffmpeg -version && ffprobe -version`
</details>

## Commands

| Command | Description |
|---------|-------------|
| `./aivideo create` | Interactive quick-create (recommended) |
| `./aivideo generate --brief "..."` | One-line non-interactive generation |
| `./aivideo generate --brief-file ./brief.txt` | Generate from a brief file |
| `./aivideo skills list` | Show built-in skills |
| `./aivideo providers test [--live]` | Validate provider config |
| `./aivideo render --project <id\|path>` | Re-render an existing project |
| `./aivideo cleanup --keep-days 7` | Remove expired projects |
| `./aivideo init` | Manually initialize config (usually automatic) |

`create` interactive commands: `/more` advanced step-by-step · `/back` · `/skip` · `/cancel` · `/help`

## Structured Brief Input

`--brief` and `create` both accept structured briefs (Chinese & English keys):

```
Theme: Summer sunscreen spray; Content: lightweight, non-greasy; Aspect: 9:16; Duration: 30s
```

Free-form descriptions also work. Images can be passed via `--images` or uploaded during `create`.

## Deployment

<details>
<summary>Option 1: Docker (recommended)</summary>

```bash
# Edit .env with API keys if needed
./aivideo create
```

The launcher auto-builds on first run or when `Dockerfile` changes.

- Container includes ffmpeg / Node.js / Python
- `projects/` mounted from host
- `aivideo.config.yaml` mounted read-only

</details>

<details>
<summary>Option 2: Host-level</summary>

Ensure Node.js 20+, pnpm, Python 3, and ffmpeg are installed, then:

```bash
./aivideo create
```

The script auto-runs `pnpm install && pnpm build` on first use and auto-runs `init`.

Manual alternative:

```bash
pnpm install && pnpm build
pnpm cli create
```

</details>

<details>
<summary>Option 3: Single Linux server</summary>

Recommended: 4 vCPU / 8 GB RAM / SSD / stable outbound network.

```bash
# Clone repo, edit .env
./aivideo providers test --live
./aivideo generate --brief "Theme: AI office assistant; Duration: 30s"
```

Schedule via cron or CI.

</details>

<details>
<summary>Advanced flags</summary>

- `--no-persist-artifacts`: remove brief.json / script.md / storyboard.json after generation
- `--cleanup-after-render`: remove audio, captions, and temp render files after export
- `--dry-run`: generate script and storyboard without rendering the final video
- `--gpu`: enable GPU-accelerated video encoding (auto-detects hardware encoder)
- `--provider-profile <name>`: select a provider profile
- Env var `AIVIDEO_MODE=docker|host` forces the launcher's runtime mode

</details>

## GPU Acceleration

The render pipeline supports GPU-accelerated video encoding via ffmpeg hardware encoders. When enabled, the system auto-detects the best available encoder for your platform:

| Platform | Encoder | Requirement |
|----------|---------|-------------|
| macOS | `h264_videotoolbox` | Apple Silicon or Intel with VideoToolbox |
| Linux (NVIDIA) | `h264_nvenc` | NVIDIA GPU + CUDA drivers |
| Linux (Intel/AMD) | `h264_vaapi` | VA-API compatible GPU + drivers |
| Windows | `h264_nvenc` / `h264_amf` | NVIDIA or AMD GPU + drivers |

**Enable GPU per command:**

```bash
./aivideo generate --brief "Theme: Summer sunscreen spray" --gpu
./aivideo render --project <id> --gpu
```

**Enable GPU by default** in `aivideo.config.yaml`:

```yaml
defaults:
  gpu: true
```

> If `--gpu` is enabled but no hardware encoder is detected, the system falls back to `libx264` (CPU) automatically with a warning.

## Security Notes

- API keys are read from `.env` only — never commit them
- Remote provider `baseURL` values are restricted to trusted hosts by default; custom gateways require `allowCustomBaseURL: true` in `aivideo.config.yaml`
- Input images: png / jpg / jpeg / webp, max 10 MB each
- Default workload limits on duration and image count

## Runtime Boundaries

- Optimized for short-form video and image-based assembly
- Long videos follow `script → storyboard → segmented assets → local composition`
- Without remote models, the system still produces copy, storyboard, subtitles, and render structure
- No automatic publishing to Douyin, WeChat Channels, Bilibili, or other platforms
