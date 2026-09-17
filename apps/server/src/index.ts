/**
 * @file index.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 工作台服务主入口：加载配置与 .env、装配 provider、启动任务引擎（含 boot 恢复）、监听 HTTP 端口（默认仅 127.0.0.1）。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig, loadDotEnv, validateConfig } from "@aivideo/core";
import { createProviderSelection } from "@aivideo/providers";
import { buildApp } from "./app.js";
import { serverConfigFromEnv } from "./config.js";
import { EventHub } from "./jobs/events.js";
import { JobRunner } from "./jobs/job-runner.js";

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
  const projectsRoot = resolve(cwd, config.defaults.projectsDir);
  const events = new EventHub();
  const runner = new JobRunner({
    cwd,
    projectsRoot,
    config,
    providers: defaultProfile,
    providersFor: (profile) => {
      if (!profile) {
        return defaultProfile;
      }
      let providers = providersByProfile.get(profile);
      if (!providers) {
        providers = createProviderSelection(config, profile);
        providersByProfile.set(profile, providers);
      }
      return providers;
    },
    events
  });
  runner.boot();

  const here = dirname(fileURLToPath(import.meta.url));
  const app = buildApp({
    cwd,
    projectsRoot,
    config,
    providers: defaultProfile,
    runner,
    publicDir: resolve(here, join("..", "public"))
  });
  const { host, port } = serverConfigFromEnv();
  serve({ fetch: app.fetch, hostname: host, port }, () => {
    console.log(`镜头墙工作台已启动：http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
    console.log(`项目目录：${projectsRoot}`);
  });
}

bootstrap();
