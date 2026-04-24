# AI Video Agent CLI

[English](./README.md) | [简体中文](./README.zh-CN.md)

本项目是一个本地 AI 自动制片工具。用户只需要提供主题、主要内容或参考图片，agent 就可以自动选择合适的内容 skill，生成文案、分镜、渲染素材，并在 `ffmpeg` 可用时导出最终视频。

## 30 秒上手

```bash
# 1. 克隆项目后，只需一行命令
./aivideo create
```

启动脚本会自动完成以下事情：

- 首次运行：创建 `.env`、构建 Docker 镜像（如有 Docker）或执行 `pnpm install && pnpm build`
- 首次 `create`/`generate`：自动执行 `init`，生成 `aivideo.config.yaml` 等配置文件
- 进入交互模式，只需描述你想做的视频，回车即可

> 如果需要远程模型能力（OpenAI / 通义千问 / 豆包等），请先在 `.env` 中填入对应 API Key。

非交互模式示例：

```bash
./aivideo generate --brief "主题：夏季防晒喷雾；主要内容：清爽不油腻；视频时长：30s"
```

## 环境要求

**推荐：Docker + Docker Compose**（宿主机无需安装 Node.js / Python / ffmpeg）

备选宿主机直跑：Node.js 20+ · pnpm 10+ · Python 3.10+ · ffmpeg/ffprobe

> 没有 `ffmpeg` 也能生成文案、分镜、字幕等中间产物，但无法导出最终视频。

<details>
<summary>安装 ffmpeg（宿主机直跑时需要）</summary>

**macOS**：`brew install ffmpeg`

**Ubuntu / Debian**：`sudo apt update && sudo apt install -y ffmpeg`

**CentOS / Rocky**：从对应软件源安装，确保 `ffmpeg` 和 `ffprobe` 在 `PATH`。

验证：`ffmpeg -version && ffprobe -version`
</details>

## 命令一览

| 命令 | 说明 |
|------|------|
| `./aivideo create` | 交互式快速创建视频（推荐） |
| `./aivideo generate --brief "..."` | 非交互一行生成 |
| `./aivideo generate --brief-file ./brief.txt` | 从文件读取 brief |
| `./aivideo skills list` | 查看内置 skills |
| `./aivideo providers test [--live]` | 校验 provider 配置 |
| `./aivideo render --project <id\|path>` | 重新渲染已有项目 |
| `./aivideo cleanup --keep-days 7` | 清理过期项目 |
| `./aivideo init` | 手动初始化配置（通常自动完成） |

`create` 交互模式命令：`/more` 进入高级逐项配置 · `/back` 上一步 · `/skip` 跳过 · `/cancel` 取消 · `/help` 帮助

## 自然语言输入

`--brief` 和 `create` 均支持结构化 brief（中英文 key 通用）：

```
主题：夏季防晒喷雾；主要内容：清爽不油腻；视频比例：9:16；视频时长：30s
```

也可以直接用自然语言描述，如："做一个 30 秒的夏季防晒产品视频"。图片通过 `--images` 传入，或在 `create` 交互中按提示上传。

## 部署

<details>
<summary>方式一：Docker 部署（推荐）</summary>

```bash
# 编辑 .env 填入 API Key（如需远程模型）
./aivideo create
```

`./aivideo` 脚本会自动 `docker compose build`（首次或 Dockerfile 变更时），后续直接执行。

- 容器内已包含 ffmpeg / Node.js / Python
- `projects/` 通过挂载卷保留在宿主机
- `aivideo.config.yaml` 只读挂载

</details>

<details>
<summary>方式二：宿主机直跑</summary>

确保已安装 Node.js 20+、pnpm、Python 3、ffmpeg，然后：

```bash
./aivideo create
```

脚本会自动 `pnpm install && pnpm build`（首次时），也会自动 `init`。

也可手动操作：

```bash
pnpm install && pnpm build
pnpm cli create
```

</details>

<details>
<summary>方式三：单机 Linux 服务器</summary>

建议配置：4 vCPU / 8 GB RAM / SSD / 稳定外网。

```bash
# 克隆仓库，编辑 .env
./aivideo providers test --live
./aivideo generate --brief "主题：AI 办公助手；视频时长：30s"
```

可配合 cron / CI 调度。

</details>

<details>
<summary>高级选项</summary>

- `--no-persist-artifacts`：生成后删除 brief.json / script.md / storyboard.json
- `--cleanup-after-render`：视频导出后删除音频、字幕、临时渲染文件
- `--dry-run`：仅生成文案和分镜，不执行视频渲染
- `--gpu`：启用 GPU 加速视频编码（自动检测硬件编码器）
- `--provider-profile <name>`：指定 provider 配置档
- 环境变量 `AIVIDEO_MODE=docker|host` 可强制指定 `./aivideo` 脚本的运行模式

</details>

## GPU 加速

渲染管线支持通过 ffmpeg 硬件编码器进行 GPU 加速视频编码。启用后，系统会自动检测当前平台可用的最佳编码器：

| 平台 | 编码器 | 要求 |
|------|--------|------|
| macOS | `h264_videotoolbox` | Apple Silicon 或支持 VideoToolbox 的 Intel Mac |
| Linux (NVIDIA) | `h264_nvenc` | NVIDIA GPU + CUDA 驱动 |
| Linux (Intel/AMD) | `h264_vaapi` | 支持 VA-API 的 GPU + 驱动 |
| Windows | `h264_nvenc` / `h264_amf` | NVIDIA 或 AMD GPU + 驱动 |

**按命令启用 GPU：**

```bash
./aivideo generate --brief "主题：夏季防晒喷雾" --gpu
./aivideo render --project <id> --gpu
```

**在配置中默认启用 GPU**（`aivideo.config.yaml`）：

```yaml
defaults:
  gpu: true
```

> 如果启用了 `--gpu` 但未检测到硬件编码器，系统会自动回退到 `libx264`（CPU 编码）并打印警告。

## 安全说明

- API Key 仅从 `.env` 读取，不要提交到版本库
- 远程 provider `baseURL` 默认限制为受信任域名；自定义网关需在 `aivideo.config.yaml` 中显式设置 `allowCustomBaseURL: true`
- 输入图片限 png / jpg / jpeg / webp，单张不超过 10 MB
- 任务时长和图片数量有默认上限

## 运行边界

- 当前版本优先适配短视频和图文拼装
- 长视频按 `脚本 → 分镜 → 分段素材 → 本地拼接` 流程完成
- 未配置远程模型时仍可生成文案、分镜、字幕和渲染结构
- 不包含自动发布到抖音、视频号、B 站等平台的能力
