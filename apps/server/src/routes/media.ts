/**
 * @file media.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 媒体文件路由：项目内文件白名单读取（扩展名 + 相对路径 + isWithinBase 三重校验）、流式 HTTP Range/206 分段与 ETag 协商、成片与用户参考图快捷端点。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { assertPathWithin, isWithinBase, normalizeRenderManifest } from "@aivideo/core";
import type { ServerDeps } from "../app.js";

/** 允许通过 /file 读取的扩展名 → Content-Type。 */
const MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".srt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：构建媒体路由：GET /:id/file?path=、GET /:id/video、GET /:id/input-image?index=，全部支持 Range 请求以便 <video> 拖动。
 * @param deps 服务依赖
 * @returns 挂载于 /api/projects 的 Hono 子应用
 */
export function mediaRoutes(deps: ServerDeps): Hono {
  const router = new Hono();

  router.get("/:id/file", (c) => {
    const projectDir = requireProjectDir(deps, c);
    if (!projectDir) {
      return c.json({ error: "Unknown project" }, 404);
    }
    const raw = new URL(c.req.url).searchParams.get("path") ?? "";
    const fileResult = safeResolveProjectFile(projectDir, raw);
    if (!fileResult.ok) {
      return c.json({ error: fileResult.error }, fileResult.status);
    }
    return serveFile(c, fileResult.path);
  });

  router.get("/:id/video", (c) => {
    const projectDir = requireProjectDir(deps, c);
    if (!projectDir) {
      return c.json({ error: "Unknown project" }, 404);
    }
    const manifestPath = join(projectDir, "render-manifest.json");
    if (!existsSync(manifestPath)) {
      return c.json({ error: "render-manifest.json not found" }, 404);
    }
    let outputFile: string | undefined;
    try {
      const manifest = normalizeRenderManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
      outputFile = manifest?.outputFile;
    } catch {
      return c.json({ error: "render-manifest.json is not valid JSON" }, 500);
    }
    if (!outputFile) {
      return c.json({ error: "manifest has no outputFile" }, 404);
    }
    const fileResult = safeResolveProjectFile(projectDir, outputFile);
    if (!fileResult.ok) {
      return c.json({ error: fileResult.error }, fileResult.status);
    }
    return serveFile(c, fileResult.path);
  });

  router.get("/:id/input-image", (c) => {
    const projectDir = requireProjectDir(deps, c);
    if (!projectDir) {
      return c.json({ error: "Unknown project" }, 404);
    }
    const index = Number.parseInt(new URL(c.req.url).searchParams.get("index") ?? "", 10);
    if (!Number.isInteger(index) || index < 0) {
      return c.json({ error: "index must be a non-negative integer" }, 400);
    }
    const briefPath = join(projectDir, "brief.json");
    if (!existsSync(briefPath)) {
      return c.json({ error: "brief.json not found" }, 404);
    }
    let imagePath: string | undefined;
    try {
      const brief = JSON.parse(readFileSync(briefPath, "utf8")) as { inputImages?: string[] };
      imagePath = brief.inputImages?.[index];
    } catch {
      return c.json({ error: "brief.json is not valid JSON" }, 500);
    }
    if (!imagePath || !isAllowedMediaPath(imagePath)) {
      return c.json({ error: "No such input image" }, 404);
    }
    // brief.json 由程序写入，但参考图路径是经 JSON 落盘再读回的间接输入：
    // 一旦有人手改 brief.json 塞进项目外的绝对路径，这里不能把它当合法路径照读，
    // 与 /file 的越界口径保持一致（403 而不是静默放行）。
    const target = resolve(imagePath);
    if (!isWithinBase(projectDir, target)) {
      return c.json({ error: "path escapes the project directory" }, 403);
    }
    return serveFile(c, target);
  });

  return router;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：按 :id 定位项目目录，任务不存在返回 null。
 */
function requireProjectDir(deps: ServerDeps, c: Context): string | null {
  const id = c.req.param("id") ?? "";
  return deps.runner.get(id) ? deps.runner.projectDirOf(id) : null;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把请求 path 解析为项目目录内的安全绝对路径：仅相对路径、无 ".."、扩展名白名单、isWithinBase 兜底。
 * @param projectDir 项目目录
 * @param requestPath ?path= 原始值
 * @returns ok+path 或 状态码+错误信息
 */
export function safeResolveProjectFile(
  projectDir: string,
  requestPath: string
): { ok: true; path: string } | { ok: false; status: ContentfulStatusCode; error: string } {
  if (!requestPath || isAbsolute(requestPath) || requestPath.startsWith("/") || requestPath.includes("\\")) {
    return { ok: false, status: 400, error: "path must be a project-relative path" };
  }
  if (requestPath.split("/").some((segment) => segment === ".." || segment === ".")) {
    return { ok: false, status: 400, error: "path must not contain . or .." };
  }
  const target = resolve(projectDir, requestPath);
  if (!isAllowedMediaPath(target)) {
    return { ok: false, status: 400, error: "file type not allowed" };
  }
  try {
    assertPathWithin(projectDir, target, "Requested file");
  } catch {
    return { ok: false, status: 403, error: "path escapes the project directory" };
  }
  if (!isWithinBase(projectDir, target) && resolve(target) !== resolve(projectDir)) {
    return { ok: false, status: 403, error: "path escapes the project directory" };
  }
  return { ok: true, path: target };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：扩展名是否在媒体白名单内。
 */
function isAllowedMediaPath(filePath: string): boolean {
  return Object.prototype.hasOwnProperty.call(MEDIA_TYPES, extname(filePath).toLowerCase());
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：流式响应文件：支持单段 bytes Range（206 + Content-Range），其余 200 全量；
 * 用 createReadStream 分块下发，成片动辄上百 MB，整文件 readFileSync 会在每次拖动进度条时把整段视频读进内存。
 * 同时给出弱 ETag（size + mtime，不读内容算 hash）与 no-cache：成片会被重渲覆盖，必须每次协商，
 * 内容没变时 304 让浏览器不再重新下载分段。
 */
function serveFile(c: Context, filePath: string): Response {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return c.json({ error: "file not found" }, 404);
  }
  if (!stat.isFile()) {
    return c.json({ error: "not a file" }, 404);
  }
  const type = MEDIA_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const total = stat.size;
  // 弱 ETag：同一份文件内容变化必伴随 size 或 mtime 变化，够用于「重渲后必须取新版」的语义。
  const etag = `W/"${total.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const baseHeaders: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Cache-Control": "no-cache"
  };
  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").some((candidate) => candidate.trim() === etag)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  const rangeHeader = c.req.header("range");
  const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (match && (match[1] || match[2])) {
    let start = match[1] ? Number.parseInt(match[1], 10) : NaN;
    let end = match[2] ? Number.parseInt(match[2], 10) : NaN;
    if (Number.isNaN(start) && !Number.isNaN(end)) {
      start = Math.max(0, total - end); // suffix range: last N bytes
      end = total - 1;
    } else if (!Number.isNaN(start) && Number.isNaN(end)) {
      end = total - 1;
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= total || end < start) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` }
      });
    }
    end = Math.min(end, total - 1);
    const body = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${total}`
      }
    });
  }
  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(total) }
  });
}
