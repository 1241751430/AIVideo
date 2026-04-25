import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import YAML from "yaml";
import { AppConfig, ProviderProfileConfig } from "./types.js";

const ALLOWED_ENV_PREFIXES = [
  "OPENAI_",
  "DASHSCOPE_",
  "ARK_",
  "AIVIDEO_",
  "VOLCENGINE_",
  "ALIYUN_"
];

export const CONFIG_FILE = "aivideo.config.yaml";

const DEFAULT_CONFIG: AppConfig = {
  defaults: {
    profile: "default",
    aspectRatio: "9:16",
    durationSeconds: 30,
    language: "zh-CN",
    platform: "douyin",
    projectsDir: "project",
    gpu: false
  },
  providers: {
    "local-rule-text": {
      type: "local-rule-text",
      capability: "text",
      vendor: "builtin",
      enabled: true,
      description: "离线规则文案生成器"
    },
    "local-say": {
      type: "local-say",
      capability: "speech",
      vendor: "builtin",
      enabled: true,
      description: "macOS say 本地配音"
    },
    "noop-image": {
      type: "noop-image",
      capability: "image",
      vendor: "builtin",
      enabled: true,
      description: "没有图片模型时，用参考图或标题卡片出片"
    },
    "noop-video": {
      type: "noop-video",
      capability: "video",
      vendor: "builtin",
      enabled: true,
      description: "预留远程视频模型接口"
    },
    "openai-text": {
      type: "openai-compatible",
      capability: "text",
      vendor: "openai",
      enabled: true,
      baseURL: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      modelEnv: "OPENAI_MODEL",
      model: "gpt-4.1-mini",
      description: "OpenAI 文案模型"
    },
    "aliyun-text": {
      type: "openai-compatible",
      capability: "text",
      vendor: "aliyun",
      enabled: true,
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "DASHSCOPE_API_KEY",
      modelEnv: "DASHSCOPE_MODEL",
      model: "qwen-plus",
      description: "阿里 DashScope 兼容文案模型"
    },
    "volcengine-text": {
      type: "openai-compatible",
      capability: "text",
      vendor: "volcengine",
      enabled: true,
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyEnv: "ARK_API_KEY",
      modelEnv: "ARK_MODEL",
      model: "doubao-1.5-pro-32k-250115",
      description: "火山引擎 Ark 文案模型"
    }
  },
  profiles: {
    default: {
      text: "local-rule-text",
      image: "noop-image",
      video: "noop-video",
      speech: "local-say"
    },
    openai: {
      text: "openai-text",
      image: "noop-image",
      video: "noop-video",
      speech: "local-say"
    },
    china: {
      text: "aliyun-text",
      image: "noop-image",
      video: "noop-video",
      speech: "local-say"
    },
    volcengine: {
      text: "volcengine-text",
      image: "noop-image",
      video: "noop-video",
      speech: "local-say"
    }
  }
};

export function loadConfig(cwd: string): AppConfig {
  const configPath = resolve(cwd, CONFIG_FILE);
  if (!existsSync(configPath)) {
    const config = cloneDefaultConfig();
    applyProviderEnvOverrides(config);
    return config;
  }

  const loaded = YAML.parse(readFileSync(configPath, "utf8")) as Partial<AppConfig> | null;
  const config: AppConfig = {
    defaults: {
      ...DEFAULT_CONFIG.defaults,
      ...(loaded?.defaults ?? {})
    },
    providers: {
      ...DEFAULT_CONFIG.providers,
      ...(loaded?.providers ?? {})
    },
    profiles: {
      ...DEFAULT_CONFIG.profiles,
      ...(loaded?.profiles ?? {})
    }
  };
  applyProviderEnvOverrides(config);
  assertSafeProjectsDir(cwd, config.defaults.projectsDir);
  return config;
}

function cloneDefaultConfig(): AppConfig {
  return {
    defaults: { ...DEFAULT_CONFIG.defaults },
    providers: Object.fromEntries(
      Object.entries(DEFAULT_CONFIG.providers).map(([id, provider]) => [id, { ...provider }])
    ),
    profiles: Object.fromEntries(
      Object.entries(DEFAULT_CONFIG.profiles).map(([id, profile]) => [id, { ...profile }])
    )
  };
}

function applyProviderEnvOverrides(config: AppConfig): void {
  for (const provider of Object.values(config.providers)) {
    if (!provider.modelEnv) {
      continue;
    }
    const modelFromEnv = process.env[provider.modelEnv]?.trim();
    if (modelFromEnv) {
      provider.model = modelFromEnv;
    }
  }
}

function assertSafeProjectsDir(cwd: string, projectsDir: string): void {
  if (isAbsolute(projectsDir)) {
    throw new Error(`projectsDir must be a relative path, got: ${projectsDir}`);
  }
  const resolved = resolve(cwd, projectsDir);
  const rel = relative(resolve(cwd), resolved);
  if (rel.startsWith("..")) {
    throw new Error(`projectsDir must stay within the project root, got: ${projectsDir}`);
  }
}

export function resolveProfile(config: AppConfig, requestedProfile?: string): ProviderProfileConfig {
  const profileId = resolveProfileId(config, requestedProfile);
  const profile = config.profiles[profileId];
  if (!profile) {
    throw new Error(`Unknown provider profile: ${profileId}`);
  }
  return profile;
}

export function resolveProfileId(config: AppConfig, requestedProfile?: string): string {
  const explicitProfile = normalizeProfileValue(requestedProfile);
  if (explicitProfile) {
    return explicitProfile;
  }

  return inferProfileFromConfiguredKeys(config) ?? config.defaults.profile;
}

function normalizeProfileValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") {
    return undefined;
  }
  return trimmed;
}

function inferProfileFromConfiguredKeys(config: AppConfig): string | undefined {
  for (const [profileId, profile] of Object.entries(config.profiles)) {
    const textProviderId = profile.text;
    if (!textProviderId) {
      continue;
    }
    const provider = config.providers[textProviderId];
    if (!provider || provider.enabled === false || provider.capability !== "text" || !provider.apiKeyEnv) {
      continue;
    }
    if (process.env[provider.apiKeyEnv]?.trim()) {
      return profileId;
    }
  }
  return undefined;
}

export function loadDotEnv(cwd: string): void {
  const envPath = resolve(cwd, ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    if (!ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    const value = trimmed.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function getConfigTemplate(cwd?: string): string {
  const target = resolve(cwd ?? process.cwd(), "aivideo.config.yaml");
  if (existsSync(target)) {
    return readFileSync(target, "utf8");
  }
  return YAML.stringify(DEFAULT_CONFIG);
}

export function getEnvTemplate(cwd?: string): string {
  const target = resolve(cwd ?? process.cwd(), ".env.example");
  if (existsSync(target)) {
    return readFileSync(target, "utf8");
  }
  return DEFAULT_ENV_TEMPLATE;
}

export function validateConfig(config: AppConfig): string[] {
  const warnings: string[] = [];

  if (!config.profiles[config.defaults.profile]) {
    warnings.push(`Default profile "${config.defaults.profile}" is not defined in profiles.`);
  }

  for (const [profileId, profile] of Object.entries(config.profiles)) {
    for (const [capability, providerId] of Object.entries(profile)) {
      if (providerId && !config.providers[providerId]) {
        warnings.push(`Profile "${profileId}" references unknown provider "${providerId}" for ${capability}.`);
      }
    }
  }

  for (const [id, provider] of Object.entries(config.providers)) {
    if (provider.type === "openai-compatible") {
      if (!provider.baseURL) {
        warnings.push(`Provider "${id}" (openai-compatible) is missing baseURL.`);
      }
      if (!provider.model) {
        warnings.push(`Provider "${id}" (openai-compatible) is missing model or modelEnv override.`);
      }
      if (!provider.apiKeyEnv) {
        warnings.push(`Provider "${id}" (openai-compatible) is missing apiKeyEnv.`);
      }
    }
  }

  return warnings;
}

const DEFAULT_ENV_TEMPLATE = `# OpenAI
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini

# 阿里 DashScope
DASHSCOPE_API_KEY=
DASHSCOPE_MODEL=qwen-plus

# 火山引擎 Ark
ARK_API_KEY=
ARK_MODEL=doubao-seed-2-0-pro-260215
`;
