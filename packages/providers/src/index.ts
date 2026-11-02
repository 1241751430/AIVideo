/**
 * @file index.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description AI 视频生成各类模型提供者（文案/图片/视频/语音/音乐）的实现与注册装配入口
 * @see https://github.com/1241751430/AIVideo.git
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, basename } from "node:path";
import {
  AppConfig,
  execFileAsync,
  ImageGenerationRequest,
  ImageModelProvider,
  MusicGenerationRequest,
  MusicProvider,
  PROJECT_BGM_EXTS,
  ProviderCapability,
  ProviderConfig,
  ProviderHealth,
  ProviderSelection,
  SpeechGenerationRequest,
  SpeechProvider,
  TextGenerationRequest,
  TextModelProvider,
  validateLocalImageFile,
  VideoGenerationRequest,
  VideoModelProvider,
  resolveProfile
} from "@aivideo/core";

const LIVE_TEST_TIMEOUT_MS = 10_000;
const MODEL_REQUEST_TIMEOUT_MS = 45_000;
const IMAGE_REQUEST_TIMEOUT_MS = 120_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_IMAGE_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const VIDEO_REQUEST_TIMEOUT_MS = 30_000;
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_POLL_TIMEOUT_MS = 10 * 60_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 180_000;
const MAX_VIDEO_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const SPEECH_REQUEST_TIMEOUT_MS = 30_000;
const MAX_SPEECH_BYTES = 20 * 1024 * 1024;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const SAFE_PROVIDER_HOSTS = [
  "api.openai.com",
  "dashscope.aliyuncs.com",
  "ark.cn-beijing.volces.com",
  "openspeech.bytedance.com"
];
// Hosts allowed to serve generated image payloads returned by provider APIs.
const TRUSTED_IMAGE_DOWNLOAD_HOSTS = ["files.oaiusercontent.com"];
const TRUSTED_IMAGE_DOWNLOAD_SUFFIXES = [
  ".volces.com",
  ".aliyuncs.com",
  ".blob.core.windows.net",
  ".openai.com"
];

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：以指数退避重试包裹异步调用，全部尝试失败后抛出最后一次错误
 * @param fn 可能失败并需要重试的异步任务
 * @param attempts 最大尝试次数（默认 RETRY_ATTEMPTS）
 * @param baseMs 首次退避基数毫秒，第 n 次等待 baseMs×2^n
 * @returns 任务成功的返回值
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = RETRY_ATTEMPTS, baseMs = RETRY_BASE_MS): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < attempts - 1) {
        const delay = baseMs * Math.pow(2, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Shared scaffolding for remote providers that authenticate with a single API
 * key against an OpenAI-style endpoint layout: assert the configured baseURL
 * is trusted, check the key env, and (on `--live`) probe `GET /models`.
 * Vendors whose health check differs (e.g. the speech console) implement
 * `test()` themselves.
 */
abstract class RemoteApiKeyProvider {
  abstract readonly capability: ProviderCapability;

  readonly isRemote = true;

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：保存远程提供者的 id 与配置，供子类鉴权与健康检查使用
   */
  constructor(
    readonly id: string,
    protected readonly config: ProviderConfig
  ) {}

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：按配置的 apiKeyEnv 从环境变量读取远程 API 密钥
   * @returns 密钥字符串；未配置或环境变量缺失时返回 undefined
   */
  protected getApiKey(): string | undefined {
    return this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：远程提供者通用健康检查——先校验 baseURL 可信与密钥存在，live 模式再真实探测 GET /models
   * @param options 检查选项，live=true 时才发起真实网络探测
   * @param readyMessage 非 live 模式下配置就绪时的提示文案
   * @returns 该提供者的健康检查结果
   */
  protected async probe(
    options?: { live?: boolean },
    readyMessage = "Configured and ready for remote calls."
  ): Promise<ProviderHealth> {
    assertSafeBaseURL(this.config);
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return {
        providerId: this.id,
        capability: this.capability,
        ok: false,
        message: `Missing API key env: ${this.config.apiKeyEnv}`,
        liveChecked: false
      };
    }

    if (!options?.live) {
      return {
        providerId: this.id,
        capability: this.capability,
        ok: true,
        message: readyMessage,
        liveChecked: false
      };
    }

    const response = await fetchWithTimeout(
      `${this.config.baseURL}/models`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`
        }
      },
      LIVE_TEST_TIMEOUT_MS
    );

    return {
      providerId: this.id,
      capability: this.capability,
      ok: response.ok,
      message: response.ok ? "Remote endpoint reachable." : `HTTP ${response.status}`,
      liveChecked: true
    };
  }
}

class LocalRuleTextProvider implements TextModelProvider {
  readonly id = "local-rule-text";
  readonly capability = "text" as const;
  readonly isRemote = false;

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：报告内置离线文案提供者始终可用
   * @returns 恒为 ok 的健康状态
   */
  async test(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      capability: this.capability,
      ok: true,
      message: "Built-in offline text provider is available.",
      liveChecked: false
    };
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：不调用远程模型，用本地规则产出一份含单场景分镜的 JSON 文案
   * @returns JSON 字符串形式的脚本文案
   */
  async generateText(request: TextGenerationRequest): Promise<string> {
    return JSON.stringify({
      title: "本地规则生成文案",
      summary: "未配置远程文案模型，已使用本地规则引擎。",
      openingHook: "先把最关键的信息讲清楚。",
      voiceover: `${request.userPrompt.slice(0, 120)}`,
      scenes: [
        {
          id: "scene-1",
          heading: "开场钩子",
          narration: "先用一句话讲清价值和场景。",
          visualPrompt: "高对比度标题卡片，突出核心主题",
          shotType: "medium",
          durationSeconds: 6,
          caption: "核心价值"
        }
      ],
      bgmStyle: "轻节奏电子氛围",
      cta: "如需更丰富的效果，请配置远程模型。",
      hashtags: ["local", "fallback", "AI视频"]
    });
  }
}

class OpenAICompatibleTextProvider extends RemoteApiKeyProvider implements TextModelProvider {
  readonly capability = "text" as const;

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：复用 probe 完成 OpenAI 兼容文本提供者的健康检查
   */
  async test(options?: { live?: boolean }): Promise<ProviderHealth> {
    return this.probe(options);
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：调用 OpenAI 兼容 /chat/completions 接口生成文案，失败按退避策略重试
   * @returns 模型返回的消息内容字符串
   */
  async generateText(request: TextGenerationRequest): Promise<string> {
    assertSafeBaseURL(this.config);
    const apiKey = this.getApiKey();
    if (!apiKey || !this.config.baseURL || !this.config.model) {
      throw new Error(`Provider ${this.id} is missing baseURL, model, or API key.`);
    }

    return withRetry(async () => {
      const response = await fetchWithTimeout(
        `${this.config.baseURL}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: this.config.model,
            temperature: 0.7,
            messages: [
              { role: "system", content: request.systemPrompt },
              { role: "user", content: request.userPrompt }
            ]
          })
        },
        MODEL_REQUEST_TIMEOUT_MS
      );

      if (!response.ok) {
        throw new Error(`Provider ${this.id} failed with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(`Provider ${this.id} returned an empty response.`);
      }
      return content;
    });
  }
}

class NoopImageProvider implements ImageModelProvider {
  readonly capability = "image" as const;
  readonly isRemote = false;

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：记录该 noop 图片提供者的 id
   */
  constructor(readonly id: string) {}

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：报告图片生成未启用，渲染端将回退到参考图或标题卡
   * @returns 恒为 ok 的健康状态
   */
  async test(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      capability: this.capability,
      ok: true,
      message: "Image generation disabled; renderer will use reference images or title cards.",
      liveChecked: false
    };
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：不生成任何图片，仅原样回显请求的输出路径
   */
  async generateImage(request: ImageGenerationRequest): Promise<{ outputPath: string }> {
    return { outputPath: request.outputPath };
  }
}

/**
 * Generic image provider for OpenAI-compatible `/images/generations` endpoints.
 *
 * Works with Volcengine Ark (Seedream), OpenAI (gpt-image-1) and DashScope
 * compatible-mode image APIs. Vendor quirks are handled through config:
 * - `sizeMap`: per-aspect-ratio size strings (e.g. Ark presets like "2K",
 *   OpenAI sizes like "1024x1536"), falling back to `${width}x${height}`.
 * - `extraBody`: extra JSON body fields (e.g. Ark's `{"watermark": false}`).
 * Responses are accepted either as `data[0].url` (downloaded, HTTPS-only,
 * size-capped) or `data[0].b64_json` (decoded). The image bytes are always
 * written to `request.outputPath`, unlike the noop provider which only echoes
 * the path without creating a file.
 */
class OpenAICompatibleImageProvider extends RemoteApiKeyProvider implements ImageModelProvider {
  readonly capability = "image" as const;

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：复用 probe 完成远程图片生成端点的健康检查
   */
  async test(options?: { live?: boolean }): Promise<ProviderHealth> {
    return this.probe(options, "Configured and ready for remote image generation.");
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：调用 OpenAI 兼容 /images/generations 生成图片，解析 b64_json 或下载 url 后写入 outputPath
   * @returns 写盘后的图片输出路径
   */
  async generateImage(request: ImageGenerationRequest): Promise<{ outputPath: string }> {
    assertSafeBaseURL(this.config);
    const apiKey = this.getApiKey();
    if (!apiKey || !this.config.baseURL || !this.config.model) {
      throw new Error(`Provider ${this.id} is missing baseURL, model, or API key.`);
    }

    const size = this.resolveSize(request);
    // The retry budget stays scoped to the billed generation call itself.
    // Payload-shape problems and download guards are deterministic, so they are
    // resolved outside withRetry — retrying them would re-bill the same failure.
    const item = await withRetry(async () => {
      const response = await fetchWithTimeout(
        `${this.config.baseURL}/images/generations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: this.config.model,
            prompt: request.prompt,
            ...(size ? { size } : {}),
            ...(this.config.extraBody ?? {})
          })
        },
        IMAGE_REQUEST_TIMEOUT_MS
      );

      if (!response.ok) {
        const detail = await safeReadErrorBody(response);
        throw new Error(
          `Provider ${this.id} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`
        );
      }

      const payload = (await response.json()) as {
        data?: Array<{ url?: string; b64_json?: string }>;
      };
      return payload.data?.[0];
    });

    if (!item) {
      throw new Error(`Provider ${this.id} returned an empty image response.`);
    }
    let imageBuffer: Buffer;
    if (item.b64_json) {
      imageBuffer = Buffer.from(item.b64_json, "base64");
      if (imageBuffer.length === 0) {
        throw new Error(`Provider ${this.id} returned an empty base64 image payload.`);
      }
    } else if (item.url) {
      imageBuffer = await this.downloadImage(item.url);
    } else {
      throw new Error(`Provider ${this.id} returned neither an image URL nor a base64 payload.`);
    }

    mkdirSync(dirname(request.outputPath), { recursive: true });
    writeFileSync(request.outputPath, imageBuffer);
    return { outputPath: request.outputPath };
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：解析本次生图请求应传给接口的 size：优先按宽高比查 sizeMap，其次 width×height，最后回退 default 映射
   * @returns size 字符串；无法确定时返回 undefined（请求体不带 size）
   */
  private resolveSize(request: ImageGenerationRequest): string | undefined {
    if (request.aspectRatio && this.config.sizeMap?.[request.aspectRatio]) {
      return this.config.sizeMap[request.aspectRatio];
    }
    if (request.width && request.height) {
      return `${request.width}x${request.height}`;
    }
    return this.config.sizeMap?.["default"];
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：下载图片响应字节，强制 HTTPS、校验受信主机并限制大小与非空响应
   * @param url 接口返回的图片下载地址
   * @returns 图片文件的完整字节内容
   */
  private async downloadImage(url: string): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error(`Image download must use HTTPS to avoid tampered payloads, got: ${parsed.protocol}`);
    }
    if (this.config.allowCustomBaseURL !== true && !isTrustedImageHost(parsed.hostname)) {
      throw new Error(
        `Image download host ${parsed.hostname} is not trusted. Set allowCustomBaseURL=true on the provider only if you explicitly trust its responses.`
      );
    }

    const response = await fetchWithTimeout(url, {}, IMAGE_DOWNLOAD_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Image download failed with HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_IMAGE_DOWNLOAD_BYTES) {
      throw new Error(`Image download exceeds ${MAX_IMAGE_DOWNLOAD_BYTES} bytes.`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error("Image download returned an empty body.");
    }
    if (buffer.length > MAX_IMAGE_DOWNLOAD_BYTES) {
      throw new Error(`Image download exceeds ${MAX_IMAGE_DOWNLOAD_BYTES} bytes.`);
    }
    return buffer;
  }
}

class NoopVideoProvider implements VideoModelProvider {
  readonly capability = "video" as const;
  readonly isRemote = false;

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：记录该 noop 视频提供者的 id
   */
  constructor(readonly id: string) {}

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：报告视频模型未配置，成片将由本地合成渲染
   * @returns 恒为 ok 的健康状态
   */
  async test(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      capability: this.capability,
      ok: true,
      message: "Video model not configured; final video will be composed locally.",
      liveChecked: false
    };
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：不生成任何视频，仅原样回显请求的输出路径
   */
  async generateVideo(request: VideoGenerationRequest): Promise<{ outputPath: string }> {
    return { outputPath: request.outputPath };
  }
}

/**
 * Volcengine Ark Seedance text-to-video provider.
 *
 * Unlike the image endpoints, Ark video generation is an async task API:
 * 1. POST {baseURL}/contents/generations/tasks  -> { id }
 * 2. GET  {baseURL}/contents/generations/tasks/{id} until status is
 *    "succeeded" (or a terminal failure), polling every VIDEO_POLL_INTERVAL_MS
 *    within an overall VIDEO_POLL_TIMEOUT_MS budget.
 * 3. Download the returned content.video_url (HTTPS-only, trusted host,
 *    size-capped) and write it to request.outputPath.
 *
 * Vendor quirks are config-driven: `extraBody` is merged into the create-task
 * body (e.g. resolution/fps overrides), so new Seedance parameters do not
 * require a code change.
 */
class ArkSeedanceVideoProvider extends RemoteApiKeyProvider implements VideoModelProvider {
  readonly capability = "video" as const;

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：复用 probe 完成远程视频生成端点的健康检查
   */
  async test(options?: { live?: boolean }): Promise<ProviderHealth> {
    return this.probe(options, "Configured and ready for remote video generation.");
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：按「建任务→轮询→下载」流程生成视频并写入 outputPath；整链不重试以避免重复计费
   * @returns 写盘后的视频输出路径
   */
  async generateVideo(request: VideoGenerationRequest): Promise<{ outputPath: string }> {
    assertSafeBaseURL(this.config);
    const apiKey = this.getApiKey();
    if (!apiKey || !this.config.baseURL || !this.config.model) {
      throw new Error(`Provider ${this.id} is missing baseURL, model, or API key.`);
    }

    const videoBuffer = await withRetry(async () => {
      const taskId = await this.createTask(request, apiKey);
      const videoUrl = await this.pollTask(taskId, apiKey);
      return this.downloadVideo(videoUrl);
    }, 1); // retrying the whole create+poll cycle would double-bill; rely on per-shot title-card fallback instead

    mkdirSync(dirname(request.outputPath), { recursive: true });
    writeFileSync(request.outputPath, videoBuffer);
    return { outputPath: request.outputPath };
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：调用 Ark 任务接口创建文生/图生（首帧）视频任务并返回任务 id
   * @param request 视频生成请求（提示词、时长、比例、可选参考图）
   * @param apiKey 远程接口鉴权密钥
   * @returns 新建任务的 id
   */
  private async createTask(request: VideoGenerationRequest, apiKey: string): Promise<string> {
    const duration = Math.max(2, Math.min(12, Math.round(request.durationSeconds)));
    const content: Array<Record<string, unknown>> = [{ type: "text", text: request.prompt }];
    // Image-to-video: Seedance accepts a first-frame image and animates from
    // it, which keeps the clip visually consistent with the shot's scene
    // image. Only the first reference is used (Seedance takes one frame).
    const reference = request.referenceImagePaths?.[0];
    if (reference) {
      content.unshift({
        type: "image_url",
        image_url: { url: imageToDataURI(reference) },
        role: "first_frame"
      });
    }
    const body: Record<string, unknown> = {
      model: this.config.model,
      content,
      duration,
      ...(request.aspectRatio ? { ratio: request.aspectRatio } : {}),
      ...(this.config.extraBody ?? {})
    };

    const response = await fetchWithTimeout(
      `${this.config.baseURL}/contents/generations/tasks`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      },
      VIDEO_REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
      const detail = await safeReadErrorBody(response);
      throw new Error(
        `Provider ${this.id} video task creation failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`
      );
    }

    const payload = (await response.json()) as { id?: string };
    if (!payload.id) {
      throw new Error(`Provider ${this.id} video task creation returned no task id.`);
    }
    return payload.id;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：按固定间隔轮询视频任务状态直至成功、终态失败或整体超时
   * @param taskId createTask 返回的任务 id
   * @param apiKey 远程接口鉴权密钥
   * @returns 任务成功后返回的视频下载地址
   */
  private async pollTask(taskId: string, apiKey: string): Promise<string> {
    const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
    const headers = { Authorization: `Bearer ${apiKey}` };

    while (Date.now() < deadline) {
      const response = await fetchWithTimeout(
        `${this.config.baseURL}/contents/generations/tasks/${taskId}`,
        { headers },
        VIDEO_REQUEST_TIMEOUT_MS
      );
      if (!response.ok) {
        const detail = await safeReadErrorBody(response);
        throw new Error(
          `Provider ${this.id} video task poll failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`
        );
      }

      const payload = (await response.json()) as {
        status?: string;
        content?: { video_url?: string; url?: string };
        error?: { code?: string; message?: string };
      };
      const status = (payload.status ?? "").toLowerCase();

      if (status === "succeeded" || status === "success") {
        const videoUrl = payload.content?.video_url ?? payload.content?.url;
        if (!videoUrl) {
          throw new Error(`Provider ${this.id} video task succeeded but returned no video URL.`);
        }
        return videoUrl;
      }
      if (status === "failed" || status === "cancelled" || status === "canceled" || status === "expired") {
        const reason = payload.error?.message ?? payload.error?.code ?? "unknown reason";
        throw new Error(`Provider ${this.id} video task ${status}: ${reason}`);
      }
      // queued / running / anything else non-terminal: keep polling
      await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
    }

    throw new Error(`Provider ${this.id} video task ${taskId} timed out after ${VIDEO_POLL_TIMEOUT_MS}ms.`);
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：下载视频响应字节，强制 HTTPS、校验受信主机并限制大小与非空响应
   * @param url 任务成功后返回的视频下载地址
   * @returns 视频文件的完整字节内容
   */
  private async downloadVideo(url: string): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error(`Video download must use HTTPS to avoid tampered payloads, got: ${parsed.protocol}`);
    }
    if (this.config.allowCustomBaseURL !== true && !isTrustedImageHost(parsed.hostname)) {
      throw new Error(
        `Video download host ${parsed.hostname} is not trusted. Set allowCustomBaseURL=true on the provider only if you explicitly trust its responses.`
      );
    }

    const response = await fetchWithTimeout(url, {}, VIDEO_DOWNLOAD_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Video download failed with HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_VIDEO_DOWNLOAD_BYTES) {
      throw new Error(`Video download exceeds ${MAX_VIDEO_DOWNLOAD_BYTES} bytes.`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error("Video download returned an empty body.");
    }
    if (buffer.length > MAX_VIDEO_DOWNLOAD_BYTES) {
      throw new Error(`Video download exceeds ${MAX_VIDEO_DOWNLOAD_BYTES} bytes.`);
    }
    return buffer;
  }
}

class LocalSpeechProvider implements SpeechProvider {
  readonly capability = "speech" as const;
  readonly isRemote = false;

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：记录本地语音提供者的 id
   */
  constructor(readonly id: string) {}

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：探测本机可用的语音合成引擎（macOS say 优先，其次 espeak-ng）
   * @returns 可用引擎名；两者皆不可用时返回 null
   */
  private async detectEngine(): Promise<"say" | "espeak-ng" | null> {
    try {
      await execFileAsync("say", ["-v", "?"]);
      return "say";
    } catch {
      // not macOS or say unavailable
    }
    try {
      await execFileAsync("espeak-ng", ["--version"]);
      return "espeak-ng";
    } catch {
      // espeak-ng unavailable
    }
    return null;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：报告本地语音引擎是否可用
   * @returns 探测到引擎时为 ok，否则附带缺失引擎说明
   */
  async test(): Promise<ProviderHealth> {
    const engine = await this.detectEngine();
    if (engine) {
      return {
        providerId: this.id,
        capability: this.capability,
        ok: true,
        message: `Local speech engine available: ${engine}.`,
        liveChecked: false
      };
    }
    return {
      providerId: this.id,
      capability: this.capability,
      ok: false,
      message: "No speech engine found (requires macOS say or espeak-ng).",
      liveChecked: false
    };
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：用本地引擎（say/espeak-ng）把文本合成为语音文件
   * @returns 语音文件的输出路径
   */
  async synthesizeSpeech(request: SpeechGenerationRequest): Promise<{ outputPath: string }> {
    mkdirSync(dirname(request.outputPath), { recursive: true });
    const engine = await this.detectEngine();
    if (engine === "say") {
      const voice = request.voice ?? "Tingting";
      // macOS say refuses to write a .wav container with its default AIFF
      // encoding ("Opening output file failed: fmt?"); the sample format must
      // be stated explicitly for the extension we store narration under.
      const args = ["-v", voice];
      if (request.outputPath.toLowerCase().endsWith(".wav")) {
        args.push("--data-format=LEI16@22050");
      }
      args.push("-o", request.outputPath, request.text);
      await execFileAsync("say", args);
    } else if (engine === "espeak-ng") {
      const voice = request.voice ?? "zh";
      await execFileAsync("espeak-ng", ["-v", voice, "-w", request.outputPath, request.text]);
    } else {
      throw new Error("No speech engine available (requires macOS say or espeak-ng).");
    }
    return { outputPath: request.outputPath };
  }
}

/**
 * Local BGM library: picks a track from `assets/bgm-library/` whose file name
 * matches the script's `bgmStyle` keywords and copies it to the requested path.
 *
 * It is strictly "use it if there is one": no match means `null`, never an
 * exception — a missing song must degrade to a video without music, not fail the
 * audio stage. Files are matched by their *content* extension, so a `.wav` track
 * is copied as `.wav` even when the caller asked for `.mp3`: a copied MP3-named
 * WAV would still decode via ffmpeg but lie about what is on disk.
 */
class LocalLibraryMusicProvider implements MusicProvider {
  readonly capability = "music" as const;
  readonly isRemote = false;
  /**
   * 曲目是从 `assets/bgm-library` 复制来的，不是模型现生成的：溯源必须记 `library`。
   * 记成 `ai_generated` 会让「这首曲子由 AI 生成」成为一句假话，而曲库里的曲子另有许可，
   * 用户据此判断能不能商用时会得到相反结论。
   */
  readonly provenanceKind = "library" as const;

  /**
   * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
   * 功能：记录该素材库音乐提供者的 id，并确定素材库根目录（baseURL 可覆盖，便于测试与部署）
   */
  constructor(
    readonly id: string,
    private readonly config: ProviderConfig
  ) {}

  /**
   * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
   * 功能：给出素材库根目录：config.baseURL 优先，否则取工作目录下的 assets/bgm-library
   */
  private libraryRoot(): string {
    const configured = this.config.baseURL?.trim();
    return configured ? configured : join(process.cwd(), "assets", "bgm-library");
  }

  /**
   * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
   * 功能：列出素材库里可用的曲目（只认 render.py 能消费的扩展名），目录不存在时返回空数组
   * @returns 绝对路径列表（按文件名排序，保证同一风格每次都挑到同一首）
   */
  private listTracks(): string[] {
    try {
      return readdirSync(this.libraryRoot(), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => (PROJECT_BGM_EXTS as readonly string[]).includes(extname(name).slice(1).toLowerCase()))
        .sort()
        .map((name) => join(this.libraryRoot(), name));
    } catch {
      // 目录不存在或不可读：等价于「库里没有曲子」，交给上层明示「无 BGM」。
      return [];
    }
  }

  /**
   * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
   * 功能：报告素材库是否可用及其中的曲目数量
   * @returns 目录存在且有曲目时为 ok；否则说明没有可用素材（不是故障，是本机没放曲子）
   */
  async test(): Promise<ProviderHealth> {
    const tracks = this.listTracks();
    return {
      providerId: this.id,
      capability: this.capability,
      ok: true,
      message: tracks.length > 0
        ? `Local BGM library has ${tracks.length} track(s).`
        : `Local BGM library is empty (${this.libraryRoot()}); videos will be rendered without music.`,
      liveChecked: false
    };
  }

  /**
   * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
   * 功能：按 style 关键词从素材库挑一首曲目复制到目标路径；没有匹配项时返回 null 让上层跳过 BGM
   * @returns 实际落盘路径（可能与请求路径扩展名不同，以素材原格式为准）；无匹配时为 null
   */
  async synthesizeMusic(request: MusicGenerationRequest): Promise<{ outputPath: string } | null> {
    const tracks = this.listTracks();
    if (tracks.length === 0) {
      return null;
    }
    const style = (request.style ?? request.prompt ?? "").trim();
    const best = style ? pickLibraryTrack(tracks, style) : tracks[0];
    if (!best) {
      return null;
    }
    // 保留素材自身扩展名：把 wav 写成 bgm.mp3 会让磁盘上的文件与实际编码不符。
    const target = join(
      dirname(request.outputPath),
      `${basename(request.outputPath, extname(request.outputPath))}${extname(best)}`
    );
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(best, target);
    return { outputPath: target };
  }
}

/**
 * Placeholder music provider: reports a successful synthesis without writing a
 * file, mirroring `NoopImageProvider`. It exists so a profile can *declare* a
 * music slot that is not actually configured yet; consumers must verify the
 * returned path is on disk before claiming the video has music.
 */
class NoopMusicProvider implements MusicProvider {
  readonly capability = "music" as const;
  readonly isRemote = false;

  /**
   * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
   * 功能：记录该 noop 音乐提供者的 id
   */
  constructor(readonly id: string) {}

  /**
   * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
   * 功能：报告音乐生成未启用，成片将不带背景音乐
   * @returns 恒为 ok 的健康状态（未配置不是故障）
   */
  async test(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      capability: this.capability,
      ok: true,
      message: "Music generation disabled; videos will be rendered without background music.",
      liveChecked: false
    };
  }

  /**
   * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
   * 功能：不产出任何音频，仅原样回显请求的输出路径（调用方需自行确认文件是否落盘）
   */
  async synthesizeMusic(request: MusicGenerationRequest): Promise<{ outputPath: string }> {
    return { outputPath: request.outputPath };
  }
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：从素材库曲目里按 style 关键词挑最贴近的一首：整名命中优先，其次整名包含于 style，最后是文件名里某个关键词出现在 style 中
 * @param tracks 素材库曲目绝对路径（已排序）
 * @param style 风格描述（来自 script.bgmStyle），中英文混排都要能切词
 * @returns 最匹配的曲目绝对路径；全无命中时返回 null
 */
function pickLibraryTrack(tracks: string[], style: string): string | null {
  const styleFlat = flattenForMatch(style);
  if (!styleFlat) {
    return null;
  }
  let best: { path: string; rank: number } | null = null;
  for (const track of tracks) {
    const base = basename(track, extname(track));
    const nameFlat = flattenForMatch(base);
    if (!nameFlat) {
      continue;
    }
    let rank = Number.POSITIVE_INFINITY;
    if (nameFlat === styleFlat) {
      rank = 0;
    } else if (nameFlat.length >= 2 && styleFlat.includes(nameFlat)) {
      rank = 1;
    } else {
      // 文件名可以带分隔符（`epic-trailer`），任一段（≥2 字符）出现在风格描述里就算弱命中。
      const tokens = base
        .toLowerCase()
        .split(/[^a-z0-9一-鿿]+/)
        .filter((token) => token.length >= 2);
      if (tokens.some((token) => styleFlat.includes(token))) {
        rank = 2;
      }
    }
    // tracks 已排序，同分时保留先出现的那个，保证选曲稳定可复现。
    if (rank !== Number.POSITIVE_INFINITY && (!best || rank < best.rank)) {
      best = { path: track, rank };
    }
  }
  return best?.path ?? null;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把风格描述/文件名压成只含小写字母数字与汉字的串，去掉空格标点，让中英文混排的粗匹配不受排版影响
 * @param value 原始文本
 * @returns 归一化后的匹配串
 */
function flattenForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "");
}

/**
 * Volcengine (语音技术) text-to-speech via the openspeech JSON API.
 *
 * Auth uses a separate appid + access token from the 语音技术 console — it is
 * NOT the Ark API key. Vendor tuning (sample rate, speed, silence expansion)
 * is config-driven: `extraBody` is merged into the `audio` section so new
 * parameters do not require a code change. `model` carries the default voice
 * (voice_type), which `request.voice` overrides.
 */
class ArkTTSSpeechProvider implements SpeechProvider {
  readonly capability = "speech" as const;
  readonly isRemote = true;

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：保存远程语音提供者的 id 与配置
   */
  constructor(
    readonly id: string,
    private readonly config: ProviderConfig
  ) {}

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：校验 baseURL 与语音控制台凭据环境变量；接口按次计费，故 live 模式也不发真实请求
   * @param options 检查选项（语音提供者不做真实探测，保留以对齐接口签名）
   * @returns 凭据齐全即 ok，缺失时列出未配置的环境变量名
   */
  async test(options?: { live?: boolean }): Promise<ProviderHealth> {
    assertSafeBaseURL(this.config);
    const missing = this.getMissingCredentials();
    if (missing.length > 0) {
      return {
        providerId: this.id,
        capability: this.capability,
        ok: false,
        message: `Missing speech credential env: ${missing.join(", ")} (generation falls back to the local engine).`,
        liveChecked: false
      };
    }

    // The speech API has no free health endpoint and every synthesis is
    // billed, so even --live stops at configuration checks.
    return {
      providerId: this.id,
      capability: this.capability,
      ok: true,
      message: "Configured and ready for remote speech synthesis.",
      liveChecked: false
    };
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：远程合成语音并写入 outputPath；缺凭据时静默降级到本地引擎
   * @returns 语音文件的输出路径
   */
  async synthesizeSpeech(request: SpeechGenerationRequest): Promise<{ outputPath: string }> {
    assertSafeBaseURL(this.config);
    // Without the speech-console credentials there is nothing to bill: degrade
    // to the local engine so narration stays audible instead of silent.
    if (this.getMissingCredentials().length > 0) {
      return new LocalSpeechProvider(this.id).synthesizeSpeech(request);
    }
    if (!this.config.baseURL || !this.config.model) {
      throw new Error(`Provider ${this.id} is missing baseURL or model (voice).`);
    }

    const audioBuffer = await withRetry(() => this.synthesize(request), 1); // no retry: each call is billed; the shot degrades to silent narration instead
    mkdirSync(dirname(request.outputPath), { recursive: true });
    writeFileSync(request.outputPath, audioBuffer);
    return { outputPath: request.outputPath };
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：调用火山引擎 openspeech TTS 接口合成一次语音，校验返回码并解码音频
   * @param request 语音合成请求（文本、音色覆盖、输出路径等）
   * @returns 解码后的 wav 音频字节
   */
  private async synthesize(request: SpeechGenerationRequest): Promise<Buffer> {
    const appId = this.getAppId();
    const accessToken = this.getAccessToken();
    const requestId = `${this.id}-${Date.now()}`;
    const body = {
      app: {
        appid: appId,
        token: accessToken,
        ...(typeof this.config.extraBody?.cluster === "string" ? { cluster: this.config.extraBody.cluster } : {})
      },
      user: { uid: "aivideo-cli" },
      audio: {
        voice_type: request.voice ?? this.config.model,
        encoding: "wav",
        sample_rate: 24000,
        ...(typeof this.config.extraBody === "object" && this.config.extraBody !== null ? stripCluster(this.config.extraBody) : {})
      },
      request_id: requestId,
      text: request.text
    };

    const response = await fetchWithTimeout(
      this.config.baseURL!,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The speech API expects "Bearer; <token>" — the semicolon is literal.
          Authorization: `Bearer; ${accessToken}`,
          "X-Api-App-Key": appId ?? "",
          "X-Api-Access-Key": accessToken ?? "",
          "X-Api-Request-Id": requestId
        },
        body: JSON.stringify(body)
      },
      SPEECH_REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
      const detail = await safeReadErrorBody(response);
      throw new Error(
        `Provider ${this.id} speech request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`
      );
    }

    const payload = (await response.json()) as {
      code?: number | string;
      message?: string;
      audio?: string;
      data?: string;
    };
    // The v1 API signals success with code 3004; treat any other numeric code
    // as a failure so a silent error envelope never becomes empty narration.
    const code = Number(payload.code);
    if (Number.isFinite(code) && code !== 3004 && code !== 0) {
      throw new Error(
        `Provider ${this.id} speech synthesis failed: code ${payload.code}${payload.message ? ` (${payload.message})` : ""}`
      );
    }

    const base64Audio = payload.audio ?? payload.data;
    if (!base64Audio) {
      throw new Error(`Provider ${this.id} speech response contained no audio payload.`);
    }
    const audioBuffer = Buffer.from(base64Audio, "base64");
    if (audioBuffer.length === 0) {
      throw new Error(`Provider ${this.id} speech response decoded to an empty payload.`);
    }
    if (audioBuffer.length > MAX_SPEECH_BYTES) {
      throw new Error(`Speech audio exceeds ${MAX_SPEECH_BYTES} bytes.`);
    }
    return audioBuffer;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：从 appIdEnv 指定的环境变量读取语音应用 appid
   */
  private getAppId(): string | undefined {
    return this.config.appIdEnv ? process.env[this.config.appIdEnv] : undefined;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：从 apiKeyEnv 指定的环境变量读取语音访问令牌
   */
  private getAccessToken(): string | undefined {
    return this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：列出尚未配置的语音凭据环境变量名，供健康检查与降级判断
   */
  private getMissingCredentials(): string[] {
    const missing: string[] = [];
    if (!this.config.appIdEnv || !process.env[this.config.appIdEnv]) {
      missing.push(this.config.appIdEnv ?? "appIdEnv (not configured)");
    }
    if (!this.config.apiKeyEnv || !process.env[this.config.apiKeyEnv]) {
      missing.push(this.config.apiKeyEnv ?? "apiKeyEnv (not configured)");
    }
    return missing;
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：从 extraBody 中剔除属于 app 段的 cluster 字段，剩余键并入 audio 段
 */
// `cluster` belongs to the `app` section; keep it out of the `audio` merge.
function stripCluster(extraBody: Record<string, unknown>): Record<string, unknown> {
  const { cluster: _cluster, ...rest } = extraBody;
  return rest;
}

type ProviderFactory<T> = (id: string, config: ProviderConfig) => T;

const textProviderRegistry = new Map<string, ProviderFactory<TextModelProvider>>();
const imageProviderRegistry = new Map<string, ProviderFactory<ImageModelProvider>>();
const videoProviderRegistry = new Map<string, ProviderFactory<VideoModelProvider>>();
const speechProviderRegistry = new Map<string, ProviderFactory<SpeechProvider>>();
const musicProviderRegistry = new Map<string, ProviderFactory<MusicProvider>>();

textProviderRegistry.set("local-rule-text", () => new LocalRuleTextProvider());
textProviderRegistry.set("openai-compatible", (id, cfg) => new OpenAICompatibleTextProvider(id, cfg));
imageProviderRegistry.set("noop-image", (id) => new NoopImageProvider(id));
imageProviderRegistry.set("openai-compatible-image", (id, cfg) => new OpenAICompatibleImageProvider(id, cfg));
videoProviderRegistry.set("noop-video", (id) => new NoopVideoProvider(id));
videoProviderRegistry.set("ark-seedance-video", (id, cfg) => new ArkSeedanceVideoProvider(id, cfg));
speechProviderRegistry.set("local-say", (id) => new LocalSpeechProvider(id));
speechProviderRegistry.set("ark-tts-speech", (id, cfg) => new ArkTTSSpeechProvider(id, cfg));
musicProviderRegistry.set("local-library-music", (id, cfg) => new LocalLibraryMusicProvider(id, cfg));
musicProviderRegistry.set("noop-music", (id) => new NoopMusicProvider(id));

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：向文案提供者注册表登记一个 provider type 工厂
 */
export function registerTextProvider(type: string, factory: ProviderFactory<TextModelProvider>): void {
  textProviderRegistry.set(type, factory);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：向图片提供者注册表登记一个 provider type 工厂
 */
export function registerImageProvider(type: string, factory: ProviderFactory<ImageModelProvider>): void {
  imageProviderRegistry.set(type, factory);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：向视频提供者注册表登记一个 provider type 工厂
 */
export function registerVideoProvider(type: string, factory: ProviderFactory<VideoModelProvider>): void {
  videoProviderRegistry.set(type, factory);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：向语音提供者注册表登记一个 provider type 工厂
 */
export function registerSpeechProvider(type: string, factory: ProviderFactory<SpeechProvider>): void {
  speechProviderRegistry.set(type, factory);
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：向音乐提供者注册表登记一个 provider type 工厂
 */
export function registerMusicProvider(type: string, factory: ProviderFactory<MusicProvider>): void {
  musicProviderRegistry.set(type, factory);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：按配置从注册表实例化某能力的提供者；未指定或禁用返回 undefined，未知类型抛错
 * @param registry 该能力对应的 type→工厂注册表
 * @param config 全局应用配置（含各 provider 定义）
 * @param providerId 选中的 provider id；缺省表示该能力未配置
 * @param capabilityLabel 能力名，仅用于拼装错误信息
 */
function instantiateFromRegistry<T>(
  registry: Map<string, ProviderFactory<T>>,
  config: AppConfig,
  providerId: string | undefined,
  capabilityLabel: string
): T | undefined {
  if (!providerId) {
    return undefined;
  }
  const providerConfig = config.providers[providerId];
  if (!providerConfig || providerConfig.enabled === false) {
    return undefined;
  }
  const factory = registry.get(providerConfig.type);
  if (!factory) {
    throw new Error(`Unsupported ${capabilityLabel} provider type: ${providerConfig.type}`);
  }
  return factory(providerId, providerConfig);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：按 profile 装配文案/图片/视频/语音/音乐五类提供者的选择结果
 * @param config 全局应用配置
 * @param profileName 配置档名称；缺省使用默认档
 */
export function createProviderSelection(config: AppConfig, profileName?: string): ProviderSelection {
  const profile = resolveProfile(config, profileName);

  return {
    text: instantiateFromRegistry(textProviderRegistry, config, profile.text, "text"),
    image: instantiateFromRegistry(imageProviderRegistry, config, profile.image, "image"),
    video: instantiateFromRegistry(videoProviderRegistry, config, profile.video, "video"),
    speech: instantiateFromRegistry(speechProviderRegistry, config, profile.speech, "speech"),
    music: instantiateFromRegistry(musicProviderRegistry, config, profile.music, "music")
  };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：对 profile 选中的各能力提供者并发执行健康检查并汇总结果
 * @param config 全局应用配置
 * @param profileName 配置档名称；缺省使用默认档
 * @param live 是否发起真实网络探测
 */
export async function testProviders(
  config: AppConfig,
  profileName?: string,
  live = false
): Promise<ProviderHealth[]> {
  const profile = resolveProfile(config, profileName);

  const checks = [
    instantiateFromRegistry(textProviderRegistry, config, profile.text, "text"),
    instantiateFromRegistry(imageProviderRegistry, config, profile.image, "image"),
    instantiateFromRegistry(videoProviderRegistry, config, profile.video, "video"),
    instantiateFromRegistry(speechProviderRegistry, config, profile.speech, "speech"),
    instantiateFromRegistry(musicProviderRegistry, config, profile.music, "music")
  ].filter(Boolean);

  return Promise.all(checks.map((provider) => provider!.test({ live })));
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：带超时中止控制的 fetch 封装，超时后抛出含请求地址与毫秒数的错误
 * @param input 请求 URL
 * @param init fetch 请求初始化参数
 * @param timeoutMs 超时毫秒数
 */
async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`Request to ${input} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验 provider baseURL 为 HTTPS 且主机在受信名单（或已显式允许自定义）
 */
function assertSafeBaseURL(config: ProviderConfig): void {
  if (!config.baseURL) {
    throw new Error("Provider baseURL is missing.");
  }
  const parsed = new URL(config.baseURL);
  if (parsed.protocol !== "https:") {
    throw new Error(
      `Provider baseURL must use HTTPS to protect API keys in transit, got: ${parsed.protocol}`
    );
  }
  const hostAllowed = SAFE_PROVIDER_HOSTS.includes(parsed.hostname);
  if (!hostAllowed && config.allowCustomBaseURL !== true) {
    throw new Error(
      `Provider baseURL ${parsed.origin} is not in the trusted host list. Set allowCustomBaseURL=true only if you explicitly trust this endpoint.`
    );
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：判断下载主机是否命中受信图片主机名单或受信后缀
 */
function isTrustedImageHost(hostname: string): boolean {
  if (TRUSTED_IMAGE_DOWNLOAD_HOSTS.includes(hostname)) {
    return true;
  }
  return TRUSTED_IMAGE_DOWNLOAD_SUFFIXES.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix)
  );
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：尽力读取错误响应体并截断为不超过 300 字符，读取失败返回空串
 */
async function safeReadErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) {
      return "";
    }
    // Keep error messages bounded; provider bodies are untrusted and can be large.
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
  } catch {
    return "";
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把本地参考图片读取为 base64 data URI，发送前先做文件校验避免计费后失败
 * @param filePath 本地图片路径
 */
// Reference images sent to video models as base64 data URIs. Ark accepts
// roughly the 10MB cap enforced by validateLocalImageFile, and larger payloads
// are rejected by the API — fail early with a clear local error instead of a
// billed 4xx.
function imageToDataURI(filePath: string): string {
  const { mime } = validateLocalImageFile(filePath, "Reference image");
  const buffer = readFileSync(filePath);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}
