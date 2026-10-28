/**
 * @file create-request.ts
 * @author zhangbaohong
 * @date 2026-10-28
 * @description 创建任务的请求归一化：把 brief 文本与显式字段合成为 JobRequest、把分片上传会话里的参考图按序搬进 input/。
 * 与 HTTP 无关（不碰 Context、不拼响应），所以从 projects.ts 里拆出来，路由只负责取 body 和落错误码。
 * @see https://github.com/1241751430/AIVideo.git
 */
import {
  GenerateRequest,
  GenerationMode,
  inferInputLanguage,
  parseDuration,
  parseStructuredBrief,
  validateGenerateRequest
} from "@aivideo/core";
import type { AppConfig } from "@aivideo/core";
import type { ExecMode, JobRequest } from "../types.js";

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：从请求体里取上传会话 id：`uploadId` 非空字符串才视为「带参考图」，其余一律当作没有参考图。
 * 参考图不再走 body 里的 base64（20×10MB 的 base64 会把单个 JSON 请求撑到两百多 MB），
 * 旧的 `images` 字段若还传过来，明确报错而不是静默丢掉——用户以为传上了图、结果任务里没有，比报错难查得多。
 * @param body 请求 JSON
 * @returns 上传会话 id；没有参考图时返回 undefined
 */
export function uploadIdOf(body: Record<string, unknown>): string | undefined {
  if (Array.isArray(body.images) && body.images.length > 0) {
    throw new Error("不再支持 images 内联 base64，请改用分片上传（先 POST /api/uploads 建会话，再逐张 PUT，创建时传 uploadId）");
  }
  const uploadId = body.uploadId;
  return typeof uploadId === "string" && uploadId.trim() ? uploadId.trim() : undefined;
}

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
