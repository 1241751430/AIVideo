/**
 * @file app.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 应用装配：buildApp(deps) 依赖注入组装 API 路由与无构建步骤的静态工作台页面，测试不起端口即可通过 app.request 驱动全部路由。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { Hono } from "hono";
import type { AppConfig, ProviderSelection } from "@aivideo/core";
import { isWithinBase } from "@aivideo/core";
import type { JobRunner } from "./jobs/job-runner.js";
import { mediaRoutes } from "./routes/media.js";
import { projectRoutes } from "./routes/projects.js";
import { reviewRoutes } from "./routes/review.js";
import { systemRoutes } from "./routes/system.js";

/** buildApp 的注入依赖。 */
export interface ServerDeps {
  /** 仓库根目录（config/providers/render worker 的定位基准）。 */
  cwd: string;
  projectsRoot: string;
  config: AppConfig;
  providers: ProviderSelection;
  /** 按 provider profile 装配提供者（计费预览与素材阶段共用口径）。 */
  providersFor: (profile?: string) => ProviderSelection;
  runner: JobRunner;
  /** public/ 静态目录绝对路径。 */
  publicDir: string;
}

/** 静态资源扩展名 → Content-Type（工作台前端无构建步骤）。 */
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png"
};

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：组装应用：/api（healthz/skills/summary + projects CRUD/SSE + 媒体文件）与其余路径的静态页面，静态读取限定 publicDir 内。
 * @param deps 服务依赖
 * @returns 可独立测试的 Hono 应用
 */
export function buildApp(deps: ServerDeps): Hono {
  const app = new Hono();

  const api = new Hono();
  api.route("/projects", mediaRoutes(deps));
  api.route("/projects", reviewRoutes(deps));
  api.route("/projects", projectRoutes(deps));
  api.route("/", systemRoutes(deps));
  app.route("/api", api);

  app.get("*", (c) => {
    const urlPath = new URL(c.req.url).pathname;
    const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const target = resolve(deps.publicDir, relative);
    if (!isWithinBase(deps.publicDir, target)) {
      return c.json({ error: "forbidden" }, 403);
    }
    const type = STATIC_TYPES[extname(target).toLowerCase()];
    if (!type) {
      return c.json({ error: "not found" }, 404);
    }
    try {
      if (!statSync(target).isFile()) {
        throw new Error("not a file");
      }
      const body = readFileSync(target);
      return new Response(body, { headers: { "Content-Type": type } });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  return app;
}
