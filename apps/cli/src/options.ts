/**
 * @file options.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description CLI 参数与结构化 brief 的解析、归一化及输入辅助工具（时长/天数/图片/语言推断等）
 * @see https://github.com/1241751430/AIVideo.git
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { inferInputLanguage, parseDuration, parseStructuredBrief, validateLocalImageFile } from "@aivideo/core";

// The structured-brief parser, language inference and the duration grammar
// moved to @aivideo/core so the workbench server parses input identically to
// `aivideo generate`; re-exported here to keep the historical CLI surface.
export { inferInputLanguage, parseDuration, parseStructuredBrief };

export interface ParsedArgs {
  command: string[];
  options: Record<string, string | boolean>;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：解析 argv，拆出命令词数组与 --key[=value] 选项表
 * @param argv 命令行参数（process.argv 去头）
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：安全读取字符串型选项，值非字符串时返回 undefined
 */
export function getStringOption(options: Record<string, string | boolean>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：安全读取布尔型选项（true 或字符串 "true" 均视为真）
 */
export function getBooleanOption(options: Record<string, string | boolean>, key: string): boolean {
  return options[key] === true || options[key] === "true";
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：解析清理保留天数，须为正整数否则返回 undefined
 */
export function parseKeepDays(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：展开 --brief/--brief-file 的结构化内容并与直接选项合并（直接选项优先）
 * @param options 原始命令行选项
 * @param cwd 工作目录（解析 brief 文件相对路径）
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：解析逗号分隔的图片路径列表，逐个解析为绝对路径并做本地图片校验
 * @param value --images 选项原始值
 * @param cwd 工作目录（解析相对路径）
 * @returns 校验通过的图片路径数组；value 为空时返回 undefined
 */
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
