/**
 * @file create-request.ts
 * @author zhangbaohong
 * @date 2026-10-28
 * @description 创建任务的请求归一化：把 brief 文本与显式字段合成为 JobRequest、把上传的参考图解码落盘到 input/。
 * 与 HTTP 无关（不碰 Context、不拼响应），所以从 projects.ts 里拆出来，路由只负责取 body 和落错误码。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GenerateRequest,
  GenerationMode,
  MAX_INPUT_IMAGES,
  inferInputLanguage,
  parseDuration,
  parseStructuredBrief,
  validateGenerateRequest
} from "@aivideo/core";
import type { AppConfig } from "@aivideo/core";
import type { ExecMode, JobRequest } from "../types.js";

/** 单张参考图的大小上限：10MB（base64 落盘后按解码字节数计）。 */
const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：把创建请求（briefText 与显式字段）合成为 JobRequest：显式字段优先、经 core 的 validateGenerateRequest 护栏校验；
 * mode=auto|guided 是执行模式，generationMode 是产物模式。
 * @param config 应用配置（取 defaults 作为缺省值）
 * @param body 请求 JSON
 * @returns JobRequest 与执行模式；非法输入抛错
 */
export function buildJobRequest(config: AppConfig, body: Record<string, unknown>): { request: JobRequest; execMode: ExecMode } {
  const briefText = typeof body.briefText === "string" ? body.briefText : "";
  const fields = briefText.trim() ? parseStructuredBrief(briefText) : {};
  const defaults = config.defaults;
  const explicitString = (key: string): string | undefined =>
    typeof body[key] === "string" && (body[key] as string).trim() ? (body[key] as string).trim() : undefined;

  const theme = explicitString("theme") ?? fields.theme;
  const content = explicitString("content") ?? fields.content;
  if (!theme && !content) {
    throw new Error("theme 或 content 至少提供一个（可直接输入一段 brief）");
  }
  for (const [label, value] of [["theme", theme], ["content", content]] as const) {
    if (value && value.length > 2000) {
      throw new Error(`${label} 超过 2000 字符上限`);
    }
  }

  const rawGenerationMode = explicitString("generationMode") ?? fields.mode;
  const generationMode: GenerationMode = rawGenerationMode === "script" ? "script" : "video";
  const skill = explicitString("skill") ?? fields.skill ?? "auto";
  const rawDuration = body.durationSeconds;
  const durationSeconds =
    typeof rawDuration === "number" ? Math.round(rawDuration) : (parseDuration(fields.duration) ?? defaults.durationSeconds);
  const aspectRatio = explicitString("aspectRatio") ?? fields.aspect ?? defaults.aspectRatio;
  const language =
    explicitString("language") ?? fields.language ?? inferInputLanguage([theme, content]) ?? defaults.language;
  const platform = explicitString("platform") ?? fields.platform ?? defaults.platform;
  const providerProfile = explicitString("providerProfile") ?? fields["provider-profile"];

  const generateRequest: GenerateRequest = {
    theme,
    content,
    images: [],
    skill,
    mode: generationMode,
    aspectRatio,
    durationSeconds,
    language,
    platform,
    persistArtifacts: true
  };
  validateGenerateRequest(generateRequest);

  const execMode: ExecMode = explicitString("mode") === "guided" ? "guided" : "auto";
  const request: JobRequest = {
    theme,
    content,
    generationMode,
    skill,
    aspectRatio,
    durationSeconds,
    language,
    platform,
    providerProfile
  };
  return { request, execMode };
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：创建时参考图落盘：解码 data-URL/裸 base64，按魔数识别 png/jpeg/webp、单张 ≤10MB、总数 ≤ MAX_INPUT_IMAGES，
 * 写入 project/<id>/input/<n>.<ext>；任何一张非法即抛错（调用方清理整个预生成目录）。
 * 上限直接取 core 的约束，避免服务端与 workflow 校验各写一个数字、日后改一处漏一处。
 * @param projectsRoot 项目根目录
 * @param projectId 预生成的项目 id
 * @param rawImages base64 / data-URL 字符串数组（顺序即用户提交顺序）
 * @returns 落盘后的绝对路径列表（顺序即提交顺序；core 据此把第 n 张图按 id 绑定到第 n 个镜头，之后重排也不会换图）
 */
export function persistInputImages(projectsRoot: string, projectId: string, rawImages: unknown[]): string[] {
  if (rawImages.length > MAX_INPUT_IMAGES) {
    throw new Error(`参考图最多 ${MAX_INPUT_IMAGES} 张`);
  }
  const inputDir = join(projectsRoot, projectId, "input");
  const written: string[] = [];
  rawImages.forEach((raw, index) => {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error(`images[${index}] 必须是非空 base64 字符串`);
    }
    const payload = raw.replace(/^data:[^,]*,/, "");
    const buffer = Buffer.from(payload, "base64");
    if (buffer.length === 0) {
      throw new Error(`images[${index}] base64 解码为空`);
    }
    if (buffer.length > MAX_INPUT_IMAGE_BYTES) {
      throw new Error(`images[${index}] 超过 10MB 上限`);
    }
    const ext = sniffImageExt(buffer);
    if (!ext) {
      throw new Error(`images[${index}] 不是受支持的图片（png/jpeg/webp）`);
    }
    if (index === 0) {
      mkdirSync(inputDir, { recursive: true });
    }
    const target = join(inputDir, `${index + 1}.${ext}`);
    writeFileSync(target, buffer);
    written.push(target);
  });
  return written;
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：按魔数嗅探图片扩展名：PNG(89 50 4E 47)/JPEG(FF D8)/WEBP(RIFF…WEBP)；未知返回 null。
 * @param buffer 解码后的图片字节
 * @returns 扩展名或 null
 */
function sniffImageExt(buffer: Buffer): string | null {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "png";
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "jpg";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }
  return null;
}