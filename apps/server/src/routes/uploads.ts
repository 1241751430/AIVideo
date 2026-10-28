/**
 * @file uploads.ts
 * @author zhangbaohong
 * @date 2026-10-28
 * @description 参考图分片上传路由（挂载于 /api/uploads，与 /api/projects 的 :id 通配完全隔离）：
 * 先建会话、再一张一 PUT 二进制流（每请求体 ≤10MB，服务端边写边限流）、最后创建任务时只带 uploadId 由服务端按序搬进项目 input/。
 * 这样无论用户选了多少张图，单个 HTTP 请求的体积都是常数级，不再随张数线性膨胀。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { Hono } from "hono";
import { MAX_INPUT_IMAGES } from "@aivideo/core";
import type { ServerDeps } from "../app.js";
import {
  MAX_INPUT_IMAGE_BYTES,
  UploadError,
  createUploadSession,
  listUploadSession,
  receiveImage,
  removeUploadSession,
  sweepExpiredUploads
} from "../jobs/upload-store.js";

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：构建上传会话路由：建会话、查会话、按序号收图、放弃会话；上传错误按 UploadError 的状态码回包。
 * @param deps 服务依赖
 * @returns Hono 子应用
 */
export function uploadRoutes(deps: ServerDeps): Hono {
  const router = new Hono();

  router.post("/", (c) => {
    // 顺带清理超时会话：本项目不引入定时任务，会话量小，建会话时的顺手清扫足够。
    sweepExpiredUploads(deps.projectsRoot);
    const uploadId = createUploadSession(deps.projectsRoot);
    return c.json({ uploadId, maxImages: MAX_INPUT_IMAGES, maxBytes: MAX_INPUT_IMAGE_BYTES }, 201);
  });

  router.get("/:uploadId", (c) => {
    const session = listUploadSession(deps.projectsRoot, c.req.param("uploadId"));
    if (!session) {
      return c.json({ error: "上传会话不存在或已过期" }, 404);
    }
    return c.json(session);
  });

  router.put("/:uploadId/:index", async (c) => {
    const index = Number.parseInt(c.req.param("index"), 10);
    // 先用 Content-Length 挡掉明显超限的请求体：不必白读 10MB 以上的字节再判超限。
    const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_INPUT_IMAGE_BYTES) {
      return c.json({ error: `单张参考图不能超过 ${MAX_INPUT_IMAGE_BYTES / (1024 * 1024)}MB` }, 413);
    }
    try {
      const image = await receiveImage(deps.projectsRoot, c.req.param("uploadId"), index, c.req.raw.body);
      return c.json({ image });
    } catch (error) {
      if (error instanceof UploadError) {
        return c.json({ error: error.message }, error.status);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  router.delete("/:uploadId", (c) => {
    removeUploadSession(deps.projectsRoot, c.req.param("uploadId"));
    return c.json({ ok: true });
  });

  return router;
}