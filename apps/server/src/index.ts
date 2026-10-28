/**
 * @file index.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 工作台服务主入口：加载配置与 .env、装配 provider、启动任务引擎（含 boot 恢复与可选的过期项目清理）、监听 HTTP 端口（默认仅 127.0.0.1）。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig, loadDotEnv, validateConfig } from "@aivideo/core";
import { createProviderSelection } from "@aivideo/providers";
import { buildApp } from "./app.js";
import { serverConfigFromEnv } from "./config.js";
import { EventHub } from "./jobs/events.js";
import { JobRunner } from "./jobs/job-runner.js";
import { RETENTION_SWEEP_INTERVAL_MS, sweepExpiredProjects } from "./jobs/retention.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：主引导：读取仓库根配置、装配默认 profile 的 providers（按任务 profile 延迟重建）、boot 恢复中断任务并启动 HTTP 服务。
 */
function bootstrap(): void {
  const cwd = process.cwd();
  loadDotEnv(cwd);
  const config = loadConfig(cwd);
  for (const warning of validateConfig(config)) {
    console.warn(`[config] ${warning}`);
  }
  const defaultProfile = createProviderSelection(config, undefined);
  const providersByProfile = new Map<string, ReturnType<typeof createProviderSelection>>();
  const providersFor = (profile?: string): ReturnType<typeof createProviderSelection> => {
    if (!profile) {
      return defaultProfile;
    }
    let providers = providersByProfile.get(profile);
    if (!providers) {
      providers = createProviderSelection(config, profile);
      providersByProfile.set(profile, providers);
    }
    return providers;
  };
  const projectsRoot = resolve(cwd, config.defaults.projectsDir);
  const events = new EventHub();
  const runner = new JobRunner({
    cwd,
    projectsRoot,
    config,
    providers: defaultProfile,
    providersFor,
    events
  });
  const { host, port, retentionDays } = serverConfigFromEnv();
  runner.boot();
  if (retentionDays) {
    // 清理放在 boot 之后：此时内存台账已从磁盘重建，isHeldByEngine 才能认出哪些项目正被任务持有。
    // 默认不开启（AIVIDEO_RETENTION_DAYS 不填），删用户数据这件事不该是默认行为。
    const sweep = (): void => {
      try {
        const removed = sweepExpiredProjects(runner, projectsRoot, retentionDays);
        if (removed.length > 0) {
          console.log(`[retention] 已清理 ${removed.length} 个超过 ${retentionDays} 天的项目`);
        }
      } catch (error) {
        // 清理失败不该让服务起不来或崩掉：记录后等下一轮。
        console.warn(`[retention] 清理失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    sweep();
    setInterval(sweep, RETENTION_SWEEP_INTERVAL_MS).unref();
  }

  // 优先托管 apps/web 的构建产物；未构建时回退到内置的无构建工作台 public/。
  const webDist = resolve(cwd, "apps", "web", "dist");
  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir = existsSync(join(webDist, "index.html")) ? webDist : resolve(here, join("..", "public"));
  const app = buildApp({
    cwd,
    projectsRoot,
    config,
    providers: defaultProfile,
    runner,
    publicDir
  });
  serve({ fetch: app.fetch, hostname: host, port }, () => {
    console.log(`镜头墙工作台已启动：http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
    console.log(`项目目录：${projectsRoot}`);
    if (retentionDays) {
      console.log(`过期项目清理：已开启，保留 ${retentionDays} 天（每 ${RETENTION_SWEEP_INTERVAL_MS / 3600000} 小时扫描一次）`);
    }
  });
}

bootstrap();
