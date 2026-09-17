import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { validateLocalImageFile } from "@aivideo/core";

export interface ParsedArgs {
  command: string[];
  options: Record<string, string | boolean>;
}

const BRIEF_KEY_MAP: Record<string, string> = {
  theme: "theme",
  topic: "theme",
  title: "theme",
  "主题": "theme",
  "标题": "theme",
  content: "content",
  brief: "content",
  description: "content",
  "内容": "content",
  "主要内容": "content",
  "补充内容": "content",
  mode: "mode",
  "模式": "mode",
  "输出模式": "mode",
  skill: "skill",
  "模板": "skill",
  "风格模板": "skill",
  aspect: "aspect",
  ratio: "aspect",
  aspectratio: "aspect",
  "比例": "aspect",
  "视频比例": "aspect",
  duration: "duration",
  length: "duration",
  "时长": "duration",
  "视频时长": "duration",
  language: "language",
  lang: "language",
  "语言": "language",
  platform: "platform",
  "平台": "platform",
  profile: "provider-profile",
  provider: "provider-profile",
  providerprofile: "provider-profile",
  "模型配置": "provider-profile",
  "配置档": "provider-profile",
  image: "images",
  images: "images",
  "图片": "images",
  "参考图片": "images"
};

export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token.startsWith("--")) {
      const [rawKey = "", inlineValue] = token.slice(2).split("=", 2);
      if (inlineValue !== undefined) {
        options[rawKey] = inlineValue;
        continue;
      }
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        options[rawKey] = true;
        continue;
      }
      options[rawKey] = next;
      index += 1;
      continue;
    }
    command.push(token);
  }

  return { command, options };
}

export function getStringOption(options: Record<string, string | boolean>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

export function getBooleanOption(options: Record<string, string | boolean>, key: string): boolean {
  return options[key] === true || options[key] === "true";
}

export function parseDuration(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const parsed = normalized.endsWith("s")
    ? Number.parseInt(normalized.slice(0, -1), 10)
    : Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseKeepDays(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function normalizeInputOptions(
  options: Record<string, string | boolean>,
  cwd: string
): Record<string, string | boolean> {
  const merged: Record<string, string | boolean> = {};
  const briefFile = getStringOption(options, "brief-file");
  if (briefFile) {
    const briefPath = isAbsolute(briefFile) ? briefFile : resolve(cwd, briefFile);
    if (!existsSync(briefPath)) {
      throw new Error(`Brief file not found: ${briefPath}`);
    }
    Object.assign(merged, parseStructuredBrief(readFileSync(briefPath, "utf8")));
  }

  const brief = getStringOption(options, "brief");
  if (brief) {
    Object.assign(merged, parseStructuredBrief(brief));
  }

  return {
    ...merged,
    ...options
  };
}

export function parseStructuredBrief(input: string): Record<string, string> {
  const normalized = input.replace(/\r/g, "\n");
  const segments = normalized
    .split(/[;\n；]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const parsed: Record<string, string> = {};

  for (const segment of segments) {
    const match = segment.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
    if (!match) {
      continue;
    }
    const rawKey = normalizeBriefKey(match[1] ?? "");
    const rawValue = (match[2] ?? "").trim();
    const key = BRIEF_KEY_MAP[rawKey];
    if (!key || !rawValue) {
      continue;
    }
    parsed[key] = normalizeBriefValue(key, rawValue);
  }

  if (Object.keys(parsed).length === 0 && input.trim()) {
    parsed.theme = input.trim();
  }

  return parsed;
}

export function inferInputLanguage(parts: Array<string | undefined>): string | undefined {
  const text = parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ")
    .trim();
  if (!text) {
    return undefined;
  }

  if (/[一-龥]/u.test(text)) {
    return "zh-CN";
  }
  if (/[ぁ-ゖァ-ヺ]/u.test(text)) {
    return "ja-JP";
  }
  if (/[가-힣]/u.test(text)) {
    return "ko-KR";
  }
  if (/[Ѐ-ӿ]/u.test(text)) {
    return "ru-RU";
  }
  if (/[؀-ۿ]/u.test(text)) {
    return "ar";
  }
  if (/[A-Za-z]/.test(text)) {
    return "en-US";
  }

  return undefined;
}

export function parseImages(value: string | undefined, cwd: string): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const entries = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (isAbsolute(item) ? item : resolve(cwd, item)));
  for (const entry of entries) {
    // Shared with the video providers' reference-image guard: existence,
    // regular-file, non-empty, 10MB cap and png/jpg/jpeg/webp extensions.
    validateLocalImageFile(entry, "Image");
  }
  return entries;
}

function normalizeBriefKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[-_]/g, "");
}

function normalizeBriefValue(key: string, value: string): string {
  if (key === "mode") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "脚本" || normalized === "文案") {
      return "script";
    }
    if (normalized === "视频") {
      return "video";
    }
    return normalized;
  }

  if (key === "skill") {
    return value.trim().toLowerCase();
  }

  return value.trim();
}
