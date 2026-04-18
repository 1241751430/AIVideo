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
    projectsDir: "projects"
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
    }
  }
};

export function loadConfig(cwd: string): AppConfig {
  const configPath = resolve(cwd, CONFIG_FILE);
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
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
  assertSafeProjectsDir(cwd, config.defaults.projectsDir);
  return config;
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
  const profileId = requestedProfile ?? config.defaults.profile;
  const profile = config.profiles[profileId];
  if (!profile) {
    throw new Error(`Unknown provider profile: ${profileId}`);
  }
  return profile;
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
    const value = trimmed.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function getConfigTemplate(cwd?: string): string {
  return readFileSync(resolve(cwd ?? process.cwd(), "aivideo.config.yaml"), "utf8");
}

export function getEnvTemplate(cwd?: string): string {
  return readFileSync(resolve(cwd ?? process.cwd(), ".env.example"), "utf8");
}
