import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const SAFE_PROVIDER_HOSTS = [
  "api.openai.com",
  "dashscope.aliyuncs.com",
  "ark.cn-beijing.volces.com"
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
      await execFileAsync("say", ["-v", voice, "-o", request.outputPath, request.text]);
    } else if (engine === "espeak-ng") {
      const voice = request.voice ?? "zh";
      await execFileAsync("espeak-ng", ["-v", voice, "-w", request.outputPath, request.text]);
    } else {
      throw new Error("No speech engine available (requires macOS say or espeak-ng).");
    }
    return { outputPath: request.outputPath };
  }
}

type ProviderFactory<T> = (id: string, config: ProviderConfig) => T;

const textProviderRegistry = new Map<string, ProviderFactory<TextModelProvider>>();
const imageProviderRegistry = new Map<string, ProviderFactory<ImageModelProvider>>();
const videoProviderRegistry = new Map<string, ProviderFactory<VideoModelProvider>>();
const speechProviderRegistry = new Map<string, ProviderFactory<SpeechProvider>>();

textProviderRegistry.set("local-rule-text", () => new LocalRuleTextProvider());
textProviderRegistry.set("openai-compatible", (id, cfg) => new OpenAICompatibleTextProvider(id, cfg));
imageProviderRegistry.set("noop-image", (id) => new NoopImageProvider(id));
videoProviderRegistry.set("noop-video", (id) => new NoopVideoProvider(id));
speechProviderRegistry.set("local-say", (id) => new LocalSpeechProvider(id));

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
