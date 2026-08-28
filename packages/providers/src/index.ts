import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import {
  AppConfig,
  ImageGenerationRequest,
  ImageModelProvider,
  ProviderConfig,
  ProviderHealth,
  ProviderSelection,
  SpeechGenerationRequest,
  SpeechProvider,
  TextGenerationRequest,
  TextModelProvider,
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

class LocalRuleTextProvider implements TextModelProvider {
  readonly id = "local-rule-text";
  readonly capability = "text" as const;
  readonly isRemote = false;

  async test(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      capability: this.capability,
      ok: true,
      message: "Built-in offline text provider is available.",
      liveChecked: false
    };
  }

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

class OpenAICompatibleTextProvider implements TextModelProvider {
  readonly capability = "text" as const;
  readonly isRemote = true;

  constructor(
    readonly id: string,
    private readonly config: ProviderConfig
  ) {}

  async test(options?: { live?: boolean }): Promise<ProviderHealth> {
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
        message: "Configured and ready for remote calls.",
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

  private getApiKey(): string | undefined {
    return this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
  }
}

class NoopImageProvider implements ImageModelProvider {
  readonly capability = "image" as const;
  readonly isRemote = false;

  constructor(readonly id: string) {}

  async test(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      capability: this.capability,
      ok: true,
      message: "Image generation disabled; renderer will use reference images or title cards.",
      liveChecked: false
    };
  }

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
class OpenAICompatibleImageProvider implements ImageModelProvider {
  readonly capability = "image" as const;
  readonly isRemote = true;

  constructor(
    readonly id: string,
    private readonly config: ProviderConfig
  ) {}

  async test(options?: { live?: boolean }): Promise<ProviderHealth> {
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
        message: "Configured and ready for remote image generation.",
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

  private resolveSize(request: ImageGenerationRequest): string | undefined {
    if (request.aspectRatio && this.config.sizeMap?.[request.aspectRatio]) {
      return this.config.sizeMap[request.aspectRatio];
    }
    if (request.width && request.height) {
      return `${request.width}x${request.height}`;
    }
    return this.config.sizeMap?.["default"];
  }

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

  private getApiKey(): string | undefined {
    return this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
  }
}

class NoopVideoProvider implements VideoModelProvider {
  readonly capability = "video" as const;
  readonly isRemote = false;

  constructor(readonly id: string) {}

  async test(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      capability: this.capability,
      ok: true,
      message: "Video model not configured; final video will be composed locally.",
      liveChecked: false
    };
  }

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
class ArkSeedanceVideoProvider implements VideoModelProvider {
  readonly capability = "video" as const;
  readonly isRemote = true;

  constructor(
    readonly id: string,
    private readonly config: ProviderConfig
  ) {}

  async test(options?: { live?: boolean }): Promise<ProviderHealth> {
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
        message: "Configured and ready for remote video generation.",
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

  private getApiKey(): string | undefined {
    return this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
  }
}

class LocalSpeechProvider implements SpeechProvider {
  readonly capability = "speech" as const;
  readonly isRemote = false;

  constructor(readonly id: string) {}

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

  constructor(
    readonly id: string,
    private readonly config: ProviderConfig
  ) {}

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

  private getAppId(): string | undefined {
    return this.config.appIdEnv ? process.env[this.config.appIdEnv] : undefined;
  }

  private getAccessToken(): string | undefined {
    return this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
  }

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

textProviderRegistry.set("local-rule-text", () => new LocalRuleTextProvider());
textProviderRegistry.set("openai-compatible", (id, cfg) => new OpenAICompatibleTextProvider(id, cfg));
imageProviderRegistry.set("noop-image", (id) => new NoopImageProvider(id));
imageProviderRegistry.set("openai-compatible-image", (id, cfg) => new OpenAICompatibleImageProvider(id, cfg));
videoProviderRegistry.set("noop-video", (id) => new NoopVideoProvider(id));
videoProviderRegistry.set("ark-seedance-video", (id, cfg) => new ArkSeedanceVideoProvider(id, cfg));
speechProviderRegistry.set("local-say", (id) => new LocalSpeechProvider(id));
speechProviderRegistry.set("ark-tts-speech", (id, cfg) => new ArkTTSSpeechProvider(id, cfg));

export function registerTextProvider(type: string, factory: ProviderFactory<TextModelProvider>): void {
  textProviderRegistry.set(type, factory);
}

export function registerImageProvider(type: string, factory: ProviderFactory<ImageModelProvider>): void {
  imageProviderRegistry.set(type, factory);
}

export function registerVideoProvider(type: string, factory: ProviderFactory<VideoModelProvider>): void {
  videoProviderRegistry.set(type, factory);
}

export function registerSpeechProvider(type: string, factory: ProviderFactory<SpeechProvider>): void {
  speechProviderRegistry.set(type, factory);
}

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

export function createProviderSelection(config: AppConfig, profileName?: string): ProviderSelection {
  const profile = resolveProfile(config, profileName);

  return {
    text: instantiateFromRegistry(textProviderRegistry, config, profile.text, "text"),
    image: instantiateFromRegistry(imageProviderRegistry, config, profile.image, "image"),
    video: instantiateFromRegistry(videoProviderRegistry, config, profile.video, "video"),
    speech: instantiateFromRegistry(speechProviderRegistry, config, profile.speech, "speech")
  };
}

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
    instantiateFromRegistry(speechProviderRegistry, config, profile.speech, "speech")
  ].filter(Boolean);

  return Promise.all(checks.map((provider) => provider!.test({ live })));
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

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

function isTrustedImageHost(hostname: string): boolean {
  if (TRUSTED_IMAGE_DOWNLOAD_HOSTS.includes(hostname)) {
    return true;
  }
  return TRUSTED_IMAGE_DOWNLOAD_SUFFIXES.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix)
  );
}

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

// Reference images sent to video models as base64 data URIs. Ark accepts
// roughly this size, and larger payloads are rejected by the API — fail early
// with a clear local error instead of a billed 4xx.
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const REFERENCE_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function imageToDataURI(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Reference image not found: ${filePath}`);
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Reference image is not a regular file: ${filePath}`);
  }
  if (stat.size === 0) {
    throw new Error(`Reference image is empty: ${filePath}`);
  }
  if (stat.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`Reference image exceeds ${MAX_REFERENCE_IMAGE_BYTES} bytes: ${filePath}`);
  }
  const mime = REFERENCE_IMAGE_MIME[extname(filePath).toLowerCase()];
  if (!mime) {
    throw new Error(
      `Unsupported reference image format: ${filePath} (use png, jpg, jpeg or webp)`
    );
  }
  const buffer = readFileSync(filePath);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}
