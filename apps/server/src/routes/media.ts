/**
 * @file media.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 媒体文件路由：项目内文件白名单读取（扩展名 + 相对路径 + isWithinBase 三重校验）、HTTP Range/206 分段、成片与用户参考图快捷端点。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { assertPathWithin, isWithinBase } from "@aivideo/core";
import type { RenderManifest } from "@aivideo/core";
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
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RenderManifest;
      outputFile = manifest.outputFile;
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
    return serveFile(c, resolve(imagePath));
  });

  return router;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：按 :id 定位项目目录，任务不存在返回 null。
 */
function requireProjectDir(deps: ServerDeps, c: any): string | null {
  const id = c.req.param("id");
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
 * 功能：读文件并响应，支持单段 bytes Range（206 + Content-Range），其余 200 全量。
 */
function serveFile(c: any, filePath: string): Response {
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
    const buffer = readFileSync(filePath);
    return new Response(buffer.subarray(start, end + 1), {
      status: 206,
      headers: {
        "Content-Type": type,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes"
      }
    });
  }
  const buffer = readFileSync(filePath);
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(total),
      "Accept-Ranges": "bytes"
    }
  });
}
