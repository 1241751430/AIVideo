/**
 * @file review.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 检查点编辑与重试路由：脚本元信息 PUT、单镜字段 PUT（core 失效矩阵自动清理过期产物）、单镜素材/配音重试（删文件 + 重新入队对应阶段，复用续跑机制只重做该镜）、计费预览与重新渲染入口。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { RenderManifest, ScriptMetaPatch, ShotEditPatch } from "@aivideo/core";
import { deleteShotAudio, deleteShotGeneratedAssets, updateScriptMeta, updateShot } from "@aivideo/core";
import { buildCostPreview } from "../jobs/cost-preview.js";
import type { ServerDeps } from "../app.js";
import type { Job } from "../types.js";

/** 路由守卫结果：要么拿到任务实体与项目目录，要么已给出状态码响应。 */
type Guarded = { ok: true; job: Job; projectDir: string } | { ok: false; status: 404 | 409; error: string };

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：构建编辑/重试/计费预览路由（挂载于 /api/projects）。
 * @param deps 服务依赖
 * @returns Hono 子应用
 */
export function reviewRoutes(deps: ServerDeps): Hono {
  const router = new Hono();

  router.put("/:id/artifacts/script", async (c) => {
    const guard = guardEditable(deps, c.req.param("id"));
    if (!guard.ok) {
      return c.json({ error: guard.error }, guard.status);
    }
    const patch = (await c.req.json().catch(() => null)) as ScriptMetaPatch | null;
    if (!patch || typeof patch !== "object") {
      return c.json({ error: "JSON body required" }, 400);
    }
    try {
      updateScriptMeta(guard.projectDir, patch);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    deps.runner.markVideoStale(guard.job.id);
    return c.json({ ok: true, videoStale: true, job: deps.runner.dto(guard.job.id) });
  });

  router.put("/:id/shots/:shotId", async (c) => {
    const guard = guardEditable(deps, c.req.param("id"));
    if (!guard.ok) {
      return c.json({ error: guard.error }, guard.status);
    }
    const patch = (await c.req.json().catch(() => null)) as ShotEditPatch | null;
    if (!patch || typeof patch !== "object") {
      return c.json({ error: "JSON body required" }, 400);
    }
    try {
      const result = updateShot(guard.projectDir, c.req.param("shotId"), patch);
      deps.runner.markVideoStale(guard.job.id);
      return c.json({
        ok: true,
        assetInvalidated: result.assetInvalidated,
        audioInvalidated: result.audioInvalidated,
        deleted: result.deleted.map((file) => file.slice(guard.projectDir.length + 1)),
        job: deps.runner.dto(guard.job.id)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /Unknown shot|Invalid shot id/.test(message) ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  router.post("/:id/shots/:shotId/retry", async (c) => {
    const guard = guardEditable(deps, c.req.param("id"));
    if (!guard.ok) {
      return c.json({ error: guard.error }, guard.status);
    }
    const body = (await c.req.json().catch(() => null)) as { target?: string } | null;
    const target = body?.target;
    if (target !== "asset" && target !== "audio") {
      return c.json({ error: "target must be asset|audio" }, 400);
    }
    const shotId = c.req.param("shotId");
    const deleted: string[] = [];
    if (target === "asset") {
      const manifest = readManifest(guard.projectDir);
      if (!manifest) {
        return c.json({ error: "render-manifest.json not found — generate the script first" }, 404);
      }
      if (!manifest.shots.some((entry) => entry.shotId === shotId)) {
        return c.json({ error: `Unknown shot: ${shotId}` }, 404);
      }
      try {
        deleted.push(...deleteShotGeneratedAssets(guard.projectDir, manifest, shotId).deleted);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    } else {
      try {
        deleted.push(...deleteShotAudio(guard.projectDir, shotId).deleted);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    const queued = deps.runner.rerun(guard.job.id, target === "asset" ? "assets" : "audio");
    if (!queued) {
      return c.json({ error: "Task is busy; retry later" }, 409);
    }
    return c.json({ ok: true, deleted: deleted.map((file) => file.slice(guard.projectDir.length + 1)) });
  });

  router.get("/:id/cost-preview", (c) => {
    const guard = guardEditable(deps, c.req.param("id"));
    if (!guard.ok) {
      return c.json({ error: guard.error }, guard.status);
    }
    const providers = deps.providersFor(guard.job.request.providerProfile);
    return c.json({ preview: buildCostPreview(guard.projectDir, providers) });
  });

  router.post("/:id/rerender", (c) => {
    const guard = guardEditable(deps, c.req.param("id"));
    if (!guard.ok) {
      return c.json({ error: guard.error }, guard.status);
    }
    const queued = deps.runner.rerun(guard.job.id, "render");
    return queued ? c.json({ ok: true }) : c.json({ error: "Task is busy; retry later" }, 409);
  });

  return router;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：编辑/重试的并发闸门：任务必须存在且不在 queued/running（避免与阶段执行争写同一产物文件）。
 */
function guardEditable(deps: ServerDeps, jobId: string): Guarded {
  const job = deps.runner.get(jobId);
  if (!job) {
    return { ok: false, status: 404, error: "Unknown project" };
  }
  if (job.phase === "queued" || job.phase === "running") {
    return { ok: false, status: 409, error: "任务执行中，编辑与重试需等待当前阶段结束" };
  }
  const projectDir = deps.runner.projectDirOf(job.projectId);
  if (!existsSync(projectDir)) {
    return { ok: false, status: 404, error: "Project directory not found" };
  }
  return { ok: true, job, projectDir };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：读取项目 render-manifest.json；缺失或 shots 非法返回 null。
 */
function readManifest(projectDir: string): RenderManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(join(projectDir, "render-manifest.json"), "utf8")) as RenderManifest;
    return manifest && Array.isArray(manifest.shots) ? manifest : null;
  } catch {
    return null;
  }
}
