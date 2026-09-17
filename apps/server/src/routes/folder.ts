/**
 * @file folder.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 打开项目文件夹路由：宿主机按平台调用 open/explorer/xdg-open 拉起文件管理器；容器环境（AIVIDEO_CONTAINER=1）不尝试打开，降级返回宿主挂载路径供用户手动访问。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { isValidProjectId } from "@aivideo/core";
import type { ServerDeps } from "../app.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：构建 open-folder 路由（挂载于 /api/projects），支持任务与无任务旧项目目录。
 * @param deps 服务依赖
 * @returns Hono 子应用
 */
export function folderRoutes(deps: ServerDeps): Hono {
  const router = new Hono();

  router.post("/:id/open-folder", async (c) => {
    const id = c.req.param("id");
    if (!isValidProjectId(id)) {
      return c.json({ error: "Invalid project id" }, 400);
    }
    const dir = join(deps.projectsRoot, id);
    if (!existsSync(dir)) {
      return c.json({ error: "Unknown project" }, 404);
    }
    if (process.env.AIVIDEO_CONTAINER === "1") {
      return c.json({
        ok: false,
        path: dir,
        hint: "运行在容器中，无法打开宿主机的文件管理器；项目已挂载到宿主机 ./project 目录，请直接访问宿主路径。"
      });
    }
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    try {
      const child = spawn(cmd, [dir], { detached: true, stdio: "ignore" });
      await new Promise<void>((resolvePromise, rejectPromise) => {
        child.once("spawn", () => resolvePromise());
        child.once("error", rejectPromise);
      });
      child.unref();
    } catch {
      return c.json({ ok: false, path: dir, hint: `未能拉起 ${cmd}，请手动打开该目录。` });
    }
    return c.json({ ok: true, path: dir });
  });

  return router;
}
