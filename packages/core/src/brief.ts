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
  "参考图片": "images",
  dialogue: "dialogue",
  lines: "dialogue",
  "台词": "dialogue",
  "对白": "dialogue",
  "脚本台词": "dialogue",
  bgm: "bgm",
  music: "bgm",
  "音乐": "bgm",
  "背景音乐": "bgm"
};

/**
 * 台词块的起始标记。台词是用户原样提供的成句文本，可能包含 `;`、`；`、换行——这些正是普通 brief 的分段符，
 * 所以它必须**先于分段**被整块取走，否则多句台词会被切成若干残句（第一句去当 theme，其余变成解析失败的行）。
 * 约定：台词块占据从该标记到文本末尾的全部内容（即写在最后）；单行式的 `台词：xxx` 仍然照旧解析。
 */
const DIALOGUE_BLOCK_PATTERN = /^[ \t]*(?:台词|对白|脚本台词|dialogue)[ \t]*[:：]/im;

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把 structured brief 里「台词块」整体摘出来，返回剩余文本与台词原文。
 * 台词只去掉首尾空白（那是标记与分隔带来的噪音），内部换行/标点/空格一律原样保留——用户怎么给就怎么用。
 * @param text 已把 `\r` 归一为 `\n` 的 brief 文本
 * @returns rest 供后续按段解析的文本；dialogue 台词原文（没有台词块时为 undefined）
 */
function extractDialogueBlock(text: string): { rest: string; dialogue?: string } {
  const match = DIALOGUE_BLOCK_PATTERN.exec(text);
  if (!match) {
    return { rest: text };
  }
  const dialogue = text.slice(match.index + match[0].length).trim();
  return {
    rest: text.slice(0, match.index),
    ...(dialogue ? { dialogue } : {})
  };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把中英文键值对形式的 brief 文本解析为规范化选项，整句无法解析时作为主题
 * @param input 结构化或非结构化的 brief 文本
 * @returns 以规范选项键（theme/content/mode/dialogue/...）为键的字符串表
 */
export function parseStructuredBrief(input: string): Record<string, string> {
  // CRLF 只折成**一个**换行：把 `\r` 直接换成 `\n` 会让 Windows 文本里每个换行变成空行，
  // 对分段无害，但台词块是逐字保留的，多出来的空行会真的进到配音文本里。
  const normalized = input.replace(/\r\n?/g, "\n");
  const { rest, dialogue } = extractDialogueBlock(normalized);
  const segments = rest
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

  if (dialogue) {
    parsed.dialogue = dialogue;
  }

  // 回退主题只看「摘掉台词块」之后的部分：否则整段台词会被当成主题，用户说的话就成了影片题目。
  if (Object.keys(parsed).length === 0 && rest.trim()) {
    parsed.theme = rest.trim();
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
