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
  - 通过结构化 brief 或显式参数生成文案、分镜，并可选输出视频
- `aivideo render`
  - 基于已有项目重新渲染
- `aivideo cleanup`
  - 清理 `projects/` 目录中过期的项目产物

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
docker compose run --rm aivideo generate --brief "主题：夏季防晒喷雾；主要内容：清爽不油腻；输出模式：script；视频比例：9:16；视频时长：30s"
docker compose run --rm aivideo cleanup --keep-days 7
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
pnpm cli generate --brief "主题：夏季防晒喷雾；主要内容：清爽不油腻；输出模式：script；视频比例：9:16；视频时长：30s"
pnpm cli cleanup --keep-days 7
```

执行 `init` 后，当前目录会生成：

- `aivideo.config.yaml`
- `.env.example`

如果需要远程模型能力，请把 API Key 写入 `.env`。如果没有配置远程 provider，CLI 会自动回退到内置本地能力。

## 自然语言输入

现在更推荐用结构化 brief，而不是一次记住很多命令参数。

示例：

```text
主题：夏季防晒喷雾；主要内容：清爽不油腻；视频比例：9:16；视频时长：30s；语言：zh-CN；平台：douyin
```

英文格式也支持：

```text
Theme: Summer sunscreen spray; Content: lightweight, non-greasy; Aspect: 9:16; Duration: 30s; Language: zh-CN; Platform: douyin
```

命令示例：

```bash
pnpm cli generate --brief "主题：夏季防晒喷雾；主要内容：清爽不油腻；视频比例：9:16；视频时长：30s"
pnpm cli generate --brief-file ./brief.txt --images ./assets/ref1.png,./assets/ref2.jpg
pnpm cli create
```

说明：

- `create` 支持直接粘贴结构化 brief，也可以回车切换到逐步模式
- `create` 现在默认直接生成视频，不再要求用户手动输入输出模式
- 文本问题问完后，`create` 会继续询问是否上传参考图片；每上传一张后，还会继续问是否继续上传
- 如果用户显式填写了 `language`，CLI 就按该值执行；如果没有填写，就会根据用户输入内容自动识别语言，只有识别不出来时才回退到配置默认值
- 视频生成完成后，CLI 会直接输出最终视频路径和可点击的 `file://` 链接，不需要再额外执行导出命令
- `--brief` 和 `--brief-file` 同时支持中英文 key
- 图片仍然建议通过 `--images` 单独传入

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
docker compose run --rm aivideo create
```

6. 或者直接执行一条非交互视频生成命令：

```bash
docker compose run --rm aivideo generate --brief "主题：你的主题；视频时长：30s"
```

说明：

- 容器内已经包含 `ffmpeg`、`ffprobe`、Node.js、pnpm 和 Python
- 这种模式下不需要宿主机级别的 Python 虚拟环境
- `projects/` 会从宿主机挂载进去，生成结果会保留在本地目录
- `aivideo.config.yaml` 会以只读方式挂载到容器内部
- 视频成功生成后，会立即输出最终视频路径和 `file://` 链接
- 如果不想保留文案和分镜类中间产物，可以加 `--no-persist-artifacts`
- 如果希望视频导出后自动清理临时渲染文件，可以加 `--cleanup-after-render`
- 可以通过下面的命令清理过期项目：

```bash
docker compose run --rm aivideo cleanup --keep-days 7
```

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
pnpm cli create
```

9. 或者直接执行一条非交互视频生成命令：

```bash
pnpm cli generate --brief "主题：你的主题；视频时长：30s"
```

常用安全选项：

- `--no-persist-artifacts`
  - 生成后删除 `brief.json`、`script.md`、`storyboard.json` 这类脚本与分镜产物
- `--cleanup-after-render`
  - 视频导出后删除音频、字幕和渲染临时目录

清理过期项目：

```bash
pnpm cli cleanup --keep-days 7
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
pnpm cli generate --brief "主题：AI 办公助手；skill：knowledge；视频时长：30s"
```

### 部署说明

- 当前项目默认不提供 HTTP API
- 当前部署形态是命令行驱动，更适合由 cron、CI 或外部工作流系统调度
- Docker 是当前默认推荐的运行和部署方式
- 所有生成产物默认写入 `projects/`，部署用户需要对该目录具备写权限
- 在生产环境中，请只在 `.env` 或服务器密钥管理系统中保存 API Key，不要写入版本库
- 如果使用 Docker 模式，宿主机不需要本地 Python 虚拟环境，也不需要宿主机级别的 `ffmpeg`

## 安全说明

- Provider API Key 从 `.env` 读取
- 默认情况下，远程 provider 的 `baseURL` 只允许使用受信任域名
- 如果确实需要接自定义网关，必须在 `aivideo.config.yaml` 中为对应 provider 显式设置 `allowCustomBaseURL: true`
- 输入图片只允许 `png`、`jpg`、`jpeg`、`webp`
- 超过 10 MB 的输入图片会被拒绝
- 默认会限制任务时长和图片数量，防止异常任务占满资源

## 运行边界

- 当前版本优先适配短视频和图文拼装
- 长视频不假设由单个模型一次性生成整片，而是按照 `脚本 -> 分镜 -> 分段素材 -> 本地拼接` 的方式完成
- 如果没有配置远程图像或视频模型，系统仍然可以生成文案、分镜、字幕和基础渲染结构
- 当前版本不包含自动发布到抖音、视频号、B 站等平台的能力
