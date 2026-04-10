# AI Video Agent CLI

[English](./README.md) | [简体中文](./README.zh-CN.md)

本项目是一个本地 AI 自动制片工具。用户只需要提供主题、主要内容或参考图片，agent 就可以自动选择合适的内容 skill，生成文案、分镜、渲染素材，并在安装好 `ffmpeg` 的情况下导出最终视频。

推荐运行方式：优先使用 Docker。宿主机直跑仍然支持，但无论是本地使用还是部署上线，容器方式都更稳，因为它可以统一 Node.js、Python 和 `ffmpeg` 环境。

## 功能特性

- `aivideo init`
  - 初始化项目配置和示例环境文件
- `aivideo skills list`
  - 查看内置内容 skills
- `aivideo providers test`
  - 校验模型 provider 配置
- `aivideo generate`
  - 生成文案、分镜，并可选输出视频
- `aivideo render`
  - 基于已有项目重新渲染

## 环境要求

推荐方式：

- Docker
- Docker Compose

备选宿主机运行方式：

- Node.js 20+
- pnpm 10+
- Python 3.10+
- `ffmpeg` 和 `ffprobe`

在 Docker 模式下，宿主机不需要单独安装 `ffmpeg`，也不需要额外创建本地 Python 虚拟环境。

如果没有安装 `ffmpeg`，项目仍然可以生成文案、分镜、字幕和渲染清单等中间产物，但无法导出最终视频文件。

## 硬件要求

当前版本主要依赖云端大模型、本地编排和本地 `ffmpeg` 渲染，因此不要求本地 GPU。

最低推荐：

- CPU：4 核
- 内存：8 GB
- 可用磁盘空间：10 GB
- 存储：SSD

推荐配置：

- CPU：8 核及以上
- 内存：16 GB 或更高
- 可用磁盘空间：20 GB+
- 存储：SSD

说明：

- 文案、脚本和分镜生成的硬件压力很低
- 图文视频拼接更依赖 CPU、内存和磁盘 IO
- 当前版本不依赖本地 GPU 推理；如果后续接入本地开源图像或视频模型，再单独提高 GPU 要求

## 安装 ffmpeg

必须同时安装 `ffmpeg` 和 `ffprobe`，才能使用 `video` 模式导出最终视频。

### macOS

如果使用 Homebrew：

```bash
brew install ffmpeg
```

安装完成后检查：

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

请根据发行版对应的软件源安装 `ffmpeg`，并确保 `ffmpeg` 和 `ffprobe` 都可以在 `PATH` 中找到。

### 常见问题

- 如果 `aivideo generate --mode video` 或 `aivideo render` 报 `ffmpeg is required`，说明 `ffmpeg` 没有安装，或者命令不在 `PATH`
- 安装后如果终端仍然找不到，请重新打开终端，并检查 `which ffmpeg` 和 `which ffprobe`

## 快速开始

### 推荐方式：Docker

```bash
cp .env.example .env
docker compose build
docker compose run --rm aivideo skills list
docker compose run --rm aivideo providers test
docker compose run --rm aivideo generate --theme "夏季防晒喷雾" --skill ecommerce --mode script
```

这种模式下：

- `ffmpeg` 由容器内部提供
- Python 在容器内部运行
- 宿主机只需要安装 Docker 和 Docker Compose
- 生成产物仍然会通过挂载卷写入本地 `projects/` 目录

### 备选方式：宿主机直跑

```bash
pnpm install
pnpm build
pnpm cli init
pnpm cli skills list
pnpm cli generate --theme "夏季防晒喷雾" --skill ecommerce --mode script
```

执行 `init` 后，当前目录会生成：

- `aivideo.config.yaml`
- `.env.example`

如果需要远程模型能力，请把 API Key 写入 `.env`。如果没有配置远程 provider，CLI 会自动回退到内置本地能力。

## 部署方式

当前项目是一个以 CLI 为核心的工具，推荐两种部署方式：

- Docker 部署
- 本地工作站部署
- 单机 Linux 服务器部署

仓库当前已经包含：

- [Dockerfile](./Dockerfile)
- [docker-compose.yml](./docker-compose.yml)
- [.dockerignore](./.dockerignore)

## 部署步骤

### 方式一：Docker 部署

适用于希望获得统一运行环境，并且不想在宿主机安装 Node.js、Python 或 `ffmpeg` 的场景。这也是当前最推荐的运行和部署方式。

要求：

- Docker
- Docker Compose

部署步骤：

1. 准备环境变量文件：

```bash
cp .env.example .env
```

2. 如果需要远程模型能力，编辑 `.env` 并填入 provider API Key。

3. 构建镜像：

```bash
docker compose build
```

4. 验证容器运行环境：

```bash
docker compose run --rm aivideo skills list
docker compose run --rm aivideo providers test
```

5. 执行生成任务：

```bash
docker compose run --rm aivideo generate --theme "你的主题" --skill auto --mode script --duration 30s
```

6. 如果要导出最终视频：

```bash
docker compose run --rm aivideo generate --theme "你的主题" --skill auto --mode video --duration 30s
```

说明：

- 容器内已经包含 `ffmpeg`、`ffprobe`、Node.js、pnpm 和 Python
- 这种模式下不需要宿主机级别的 Python 虚拟环境
- `projects/` 会从宿主机挂载进去，生成结果会保留在本地目录
- `aivideo.config.yaml` 会以只读方式挂载到容器内部

### 方式二：本地部署

适用于操作者直接在本机生成内容。

1. 安装运行依赖并确认版本：

```bash
node -v
pnpm -v
python3 --version
ffmpeg -version
ffprobe -version
```

2. 克隆仓库，或将项目目录复制到本地机器。

3. 安装依赖：

```bash
pnpm install
```

4. 构建项目：

```bash
pnpm build
```

5. 初始化运行文件：

```bash
pnpm cli init
```

6. 如果需要远程模型能力，编辑 `.env` 并填入 provider API Key。

7. 校验 provider：

```bash
pnpm cli providers test
```

8. 执行生成任务：

```bash
pnpm cli generate --theme "你的主题" --skill auto --mode script --duration 30s
```

9. 如果要导出最终视频，使用 `video` 模式或对已有项目重新渲染：

```bash
pnpm cli generate --theme "你的主题" --skill auto --mode video --duration 30s
pnpm cli render --project <project-id>
```

### 方式三：单机服务器部署

适用于由一台专用 Linux 服务器统一生成内容，或配合定时任务使用。

建议服务器基础配置：

- 至少 4 vCPU
- 至少 8 GB 内存
- SSD 存储
- 可以稳定访问外部模型 API

部署步骤：

1. 准备服务器环境，安装 Node.js 20+、pnpm、Python 3 和 `ffmpeg`。

2. 将仓库上传或克隆到服务器。

3. 安装依赖：

```bash
pnpm install
```

4. 构建项目：

```bash
pnpm build
```

5. 初始化配置文件：

```bash
pnpm cli init
```

6. 根据服务器环境修改 `.env` 和 `aivideo.config.yaml`。

7. 检查 provider 和运行环境：

```bash
pnpm cli providers test
```

8. 直接执行生成命令，或者交给 cron、调度器、CI 工作流调用。

示例：

```bash
pnpm cli generate --theme "AI 办公助手" --skill knowledge --mode video --duration 30s
```

### 部署说明

- 当前项目默认不提供 HTTP API
- 当前部署形态是命令行驱动，更适合由 cron、CI 或外部工作流系统调度
- Docker 是当前默认推荐的运行和部署方式
- 所有生成产物默认写入 `projects/`，部署用户需要对该目录具备写权限
- 在生产环境中，请只在 `.env` 或服务器密钥管理系统中保存 API Key，不要写入版本库
- 如果使用 Docker 模式，宿主机不需要本地 Python 虚拟环境，也不需要宿主机级别的 `ffmpeg`

## 运行边界

- 当前版本优先适配短视频和图文拼装
- 长视频不假设由单个模型一次性生成整片，而是按照 `脚本 -> 分镜 -> 分段素材 -> 本地拼接` 的方式完成
- 如果没有配置远程图像或视频模型，系统仍然可以生成文案、分镜、字幕和基础渲染结构
- 当前版本不包含自动发布到抖音、视频号、B 站等平台的能力
