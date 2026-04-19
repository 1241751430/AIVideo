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
const SAFE_PROVIDER_HOSTS = [
  "api.openai.com",
  "dashscope.aliyuncs.com",
  "ark.cn-beijing.volces.com"
];

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

class LocalSaySpeechProvider implements SpeechProvider {
  readonly capability = "speech" as const;
  readonly isRemote = false;

  constructor(readonly id: string) {}

  async test(): Promise<ProviderHealth> {
    try {
      await execFileAsync("say", ["-v", "?"]);
      return {
        providerId: this.id,
        capability: this.capability,
        ok: true,
        message: "macOS say is available.",
        liveChecked: false
      };
    } catch {
      return {
        providerId: this.id,
        capability: this.capability,
        ok: false,
        message: "macOS say command not found.",
        liveChecked: false
      };
    }
  }

  async synthesizeSpeech(request: SpeechGenerationRequest): Promise<{ outputPath: string }> {
    mkdirSync(dirname(request.outputPath), { recursive: true });
    const voice = request.voice ?? "Tingting";
    await execFileAsync("say", ["-v", voice, "-o", request.outputPath, request.text]);
    return { outputPath: request.outputPath };
  }
}

export function createProviderSelection(config: AppConfig, profileName?: string): ProviderSelection {
  const profile = resolveProfile(config, profileName);

  return {
    text: instantiateTextProvider(config, profile.text),
    image: instantiateImageProvider(config, profile.image),
    video: instantiateVideoProvider(config, profile.video),
    speech: instantiateSpeechProvider(config, profile.speech)
  };
}

export async function testProviders(
  config: AppConfig,
  profileName?: string,
  live = false
): Promise<ProviderHealth[]> {
  const profile = resolveProfile(config, profileName);

  const checks = [
    instantiateTextProvider(config, profile.text),
    instantiateImageProvider(config, profile.image),
    instantiateVideoProvider(config, profile.video),
    instantiateSpeechProvider(config, profile.speech)
  ].filter(Boolean);

  return Promise.all(checks.map((provider) => provider!.test({ live })));
}

function instantiateTextProvider(config: AppConfig, providerId?: string): TextModelProvider | undefined {
  if (!providerId) {
    return undefined;
  }
  const provider = config.providers[providerId];
  if (!provider || provider.enabled === false) {
    return undefined;
  }
  switch (provider.type) {
    case "local-rule-text":
      return new LocalRuleTextProvider();
    case "openai-compatible":
      return new OpenAICompatibleTextProvider(providerId, provider);
    default:
      throw new Error(`Unsupported text provider type: ${provider.type}`);
  }
}

function instantiateImageProvider(config: AppConfig, providerId?: string): ImageModelProvider | undefined {
  if (!providerId) {
    return undefined;
  }
  const provider = config.providers[providerId];
  if (!provider || provider.enabled === false) {
    return undefined;
  }
  if (provider.type === "noop-image") {
    return new NoopImageProvider(providerId);
  }
  throw new Error(`Unsupported image provider type: ${provider.type}`);
}

function instantiateVideoProvider(config: AppConfig, providerId?: string): VideoModelProvider | undefined {
  if (!providerId) {
    return undefined;
  }
  const provider = config.providers[providerId];
  if (!provider || provider.enabled === false) {
    return undefined;
  }
  if (provider.type === "noop-video") {
    return new NoopVideoProvider(providerId);
  }
  throw new Error(`Unsupported video provider type: ${provider.type}`);
}

function instantiateSpeechProvider(config: AppConfig, providerId?: string): SpeechProvider | undefined {
  if (!providerId) {
    return undefined;
  }
  const provider = config.providers[providerId];
  if (!provider || provider.enabled === false) {
    return undefined;
  }
  if (provider.type === "local-say") {
    return new LocalSaySpeechProvider(providerId);
  }
  throw new Error(`Unsupported speech provider type: ${provider.type}`);
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
