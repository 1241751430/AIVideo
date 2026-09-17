/**
 * @file config.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 配置层：内置默认配置（Provider 目录与 profile 定义）、加载并合并 aivideo.config.yaml、环境变量覆盖与 .env 读取、profile 解析与自动推断，以及配置校验与模板导出。
 * @see https://github.com/1241751430/AIVideo.git
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import YAML from "yaml";
import { AppConfig, ProviderProfileConfig } from "./types.js";
import { isWithinBase } from "./utils.js";

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
    },
    "openai-image": {
      type: "openai-compatible-image",
      capability: "image",
      vendor: "openai",
      enabled: true,
      baseURL: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      modelEnv: "OPENAI_IMAGE_MODEL",
      model: "gpt-image-1",
      description: "OpenAI 图片模型（gpt-image-1）"
    },
    "aliyun-image": {
      type: "openai-compatible-image",
      capability: "image",
      vendor: "aliyun",
      enabled: true,
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "DASHSCOPE_API_KEY",
      modelEnv: "DASHSCOPE_IMAGE_MODEL",
      model: "wan2.2-t2i-flash",
      description: "阿里 DashScope 兼容图片模型"
    },
    "volcengine-image": {
      type: "openai-compatible-image",
      capability: "image",
      vendor: "volcengine",
      enabled: true,
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyEnv: "ARK_API_KEY",
      modelEnv: "ARK_IMAGE_MODEL",
      model: "doubao-seedream-4-0-250828",
      sizeMap: {
        "9:16": "2K",
        "16:9": "2K",
        "1:1": "2K",
        "4:5": "2K",
        "default": "2K"
      },
      extraBody: { watermark: false },
      description: "火山引擎 Ark Seedream 图片模型"
    },
    "volcengine-video": {
      type: "ark-seedance-video",
      capability: "video",
      vendor: "volcengine",
      enabled: true,
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyEnv: "ARK_API_KEY",
      modelEnv: "ARK_VIDEO_MODEL",
      model: "doubao-seedance-1-0-pro-250528",
      description: "火山引擎 Ark Seedance 视频模型（异步任务）"
    },
    "volcengine-speech": {
      type: "ark-tts-speech",
      capability: "speech",
      vendor: "volcengine",
      enabled: true,
      baseURL: "https://openspeech.bytedance.com/api/v1/tts",
      appIdEnv: "ARK_TTS_APP_ID",
      apiKeyEnv: "ARK_TTS_ACCESS_KEY",
      modelEnv: "ARK_TTS_VOICE",
      model: "zh_female_qingxin",
      description: "火山引擎语音合成（需在语音技术控制台单独开通，使用 appid + access token）"
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
      image: "openai-image",
      video: "noop-video",
      speech: "local-say"
    },
    china: {
      text: "aliyun-text",
      image: "aliyun-image",
      video: "noop-video",
      speech: "local-say"
    },
    volcengine: {
      text: "volcengine-text",
      image: "volcengine-image",
      video: "volcengine-video",
      speech: "local-say"
    }
  }
};

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：读取 cwd 下的 aivideo.config.yaml 并与默认配置逐层合并；文件不存在时直接返回默认配置的克隆，随后应用模型环境变量覆盖并校验 projectsDir 安全性。
 * @returns 合并后的 AppConfig
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：浅拷贝 DEFAULT_CONFIG 的 defaults/providers/profiles 三层结构，避免调用方修改污染默认值。
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：遍历配置中的 Provider，若其 modelEnv 指定的环境变量有值则覆盖 provider.model。
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验 projectsDir 必须是相对路径且解析后仍位于 cwd 内，否则抛出说明性错误。
 */
function assertSafeProjectsDir(cwd: string, projectsDir: string): void {
  if (isAbsolute(projectsDir)) {
    throw new Error(`projectsDir must be a relative path, got: ${projectsDir}`);
  }
  const resolved = resolve(cwd, projectsDir);
  if (!isWithinBase(resolve(cwd), resolved)) {
    throw new Error(`projectsDir must stay within the project root, got: ${projectsDir}`);
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：先解析出生效的 profile id，再从 config.profiles 取出对应 profile；未知 id 抛出错误。
 * @returns 对应的 ProviderProfileConfig
 */
export function resolveProfile(config: AppConfig, requestedProfile?: string): ProviderProfileConfig {
  const profileId = resolveProfileId(config, requestedProfile);
  const profile = config.profiles[profileId];
  if (!profile) {
    throw new Error(`Unknown provider profile: ${profileId}`);
  }
  return profile;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：确定生效的 profile：显式传入优先（非空且非 "auto"），否则按已配置密钥的环境变量推断，最后回退 defaults.profile。
 */
export function resolveProfileId(config: AppConfig, requestedProfile?: string): string {
  const explicitProfile = normalizeProfileValue(requestedProfile);
  if (explicitProfile) {
    return explicitProfile;
  }

  return inferProfileFromConfiguredKeys(config) ?? config.defaults.profile;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：去除 profile 值首尾空白，空串或 "auto" 归一为 undefined，表示不显式指定。
 */
function normalizeProfileValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") {
    return undefined;
  }
  return trimmed;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：按 profile 顺序检查其文本 Provider 的 apiKeyEnv 是否已在环境变量中配置，返回第一个匹配的 profile id。
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：解析 cwd 下的 .env 文件，仅把白名单前缀（OPENAI_、DASHSCOPE_、ARK_ 等）且尚未设置的键写入 process.env。
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：返回 cwd 下已有的 aivideo.config.yaml 原文；不存在时把默认配置序列化成 YAML 模板返回。
 */
export function getConfigTemplate(cwd?: string): string {
  const target = resolve(cwd ?? process.cwd(), "aivideo.config.yaml");
  if (existsSync(target)) {
    return readFileSync(target, "utf8");
  }
  return YAML.stringify(DEFAULT_CONFIG);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：返回 cwd 下已有的 .env.example 原文；不存在时返回内置的 DEFAULT_ENV_TEMPLATE。
 */
export function getEnvTemplate(cwd?: string): string {
  const target = resolve(cwd ?? process.cwd(), ".env.example");
  if (existsSync(target)) {
    return readFileSync(target, "utf8");
  }
  return DEFAULT_ENV_TEMPLATE;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：收集所有 Provider 定义引用到的环境变量名（apiKeyEnv/appIdEnv/modelEnv），去重排序返回。
 */
/**
 * Every environment variable name referenced by the configured providers
 * (API keys, app ids, model overrides). Used by tests and tooling to keep the
 * `.env` template in sync with the provider definitions.
 */
export function collectProviderEnvKeys(config: AppConfig): string[] {
  const keys = new Set<string>();
  for (const provider of Object.values(config.providers)) {
    for (const key of [provider.apiKeyEnv, provider.appIdEnv, provider.modelEnv]) {
      if (key) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验配置一致性并返回告警列表：默认 profile 未定义、profile 引用未知 Provider、openai 兼容类 Provider 缺 baseURL/model/apiKeyEnv。
 */
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
    if (provider.type === "openai-compatible" || provider.type === "openai-compatible-image" || provider.type === "ark-seedance-video" || provider.type === "ark-tts-speech") {
      if (!provider.baseURL) {
        warnings.push(`Provider "${id}" (${provider.type}) is missing baseURL.`);
      }
      if (!provider.model) {
        warnings.push(`Provider "${id}" (${provider.type}) is missing model or modelEnv override.`);
      }
      if (!provider.apiKeyEnv) {
        warnings.push(`Provider "${id}" (${provider.type}) is missing apiKeyEnv.`);
      }
    }
  }

  return warnings;
}

const DEFAULT_ENV_TEMPLATE = `# OpenAI
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
OPENAI_IMAGE_MODEL=gpt-image-1

# 阿里 DashScope
DASHSCOPE_API_KEY=
DASHSCOPE_MODEL=qwen-plus
DASHSCOPE_IMAGE_MODEL=wan2.2-t2i-flash

# 火山引擎 Ark
ARK_API_KEY=
ARK_MODEL=doubao-seed-2-0-pro-260215
ARK_IMAGE_MODEL=doubao-seedream-4-0-250828
ARK_VIDEO_MODEL=doubao-seedance-1-0-pro-250528

# 火山引擎 语音合成（语音技术控制台，与 Ark 密钥不通用）
ARK_TTS_APP_ID=
ARK_TTS_ACCESS_KEY=
ARK_TTS_VOICE=zh_female_qingxin
`;
