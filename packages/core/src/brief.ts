/**
 * @file brief.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 结构化 brief 文本解析与输入语言推断：把中英文键值对（主题：…；时长：…）归一化为选项表，供 CLI 与工作台服务器共用。
 * @see https://github.com/1241751430/AIVideo.git
 */

/**
 * Brief text keys (English and Chinese spellings) mapped onto the canonical
 * option names the CLI flag parser produces. Lives in core so the workbench
 * server's free-text input box parses briefs exactly like `aivideo generate`.
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把中英文键值对形式的 brief 文本解析为规范化选项，整句无法解析时作为主题
 * @param input 结构化或非结构化的 brief 文本
 * @returns 以规范选项键（theme/content/mode/...）为键的字符串表
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：按文本字符集推断输入语言（中/日/韩/俄/阿拉伯/英）
 * @param parts 参与判断的文本片段（如主题与内容）
 * @returns BCP-47 语言标签；无法判断时返回 undefined
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：归一化 brief 键名（去首尾空白、小写、去空白与连字符）以便查映射表
 */
function normalizeBriefKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[-_]/g, "");
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：归一化 brief 值，mode/skill 键把中文说法映射为英文枚举值
 * @param key 已归一化的选项键名
 * @param value 原始值
 */
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
