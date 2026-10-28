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
import type { ServerType } from "@hono/node-server";
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
  const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
    console.log(`镜头墙工作台已启动：http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
    console.log(`项目目录：${projectsRoot}`);
    if (retentionDays) {
      console.log(`过期项目清理：已开启，保留 ${retentionDays} 天（每 ${RETENTION_SWEEP_INTERVAL_MS / 3600000} 小时扫描一次）`);
    }
  });
  installShutdownHandlers(server, runner);
}

/** 关服最多等多久：任务中止 + 子进程收尸 + 连接排空，超过就硬退。 */
const SHUTDOWN_TIMEOUT_MS = 15000;

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：注册 SIGINT/SIGTERM 优雅关闭：进程收到信号 → 中止运行中任务并把断点落盘 → 排空连接 → 退出。
 * 不接管信号时，Ctrl+C 或 `docker stop` 会让服务端当场消失，正在跑的 python/ffmpeg 变成孤儿继续写项目目录，
 * 而 job.json 还停在 running——下次启动只能靠 boot() 从阶段起点重跑。
 * 第二次信号直接硬退：用户按两下 Ctrl+C 的意思很明确，不该再拦。
 */
function installShutdownHandlers(server: ServerType, runner: JobRunner): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) {
      console.log(`\n[shutdown] 再次收到 ${signal}，立即退出`);
      process.exit(1);
    }
    closing = true;
    console.log(`\n[shutdown] 收到 ${signal}，正在停止：取消运行中的任务并落盘断点…`);
    const deadline = setTimeout(() => {
      console.warn(`[shutdown] ${SHUTDOWN_TIMEOUT_MS}ms 内未排空，强制退出`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
    void runner.shutdown(SHUTDOWN_TIMEOUT_MS).then(() => {
      // SSE 是长连接，close() 要等它们主动断开；这里不另起协调逻辑，直接连上一起清掉。
      // 只有 http.Server 有这个方法（ServerType 还包含 http2 变体），运行时判断比类型断言可靠。
      if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      server.close(() => {
        clearTimeout(deadline);
        console.log("[shutdown] 已安全退出，下次启动可从中断阶段继续");
        process.exit(0);
      });
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap();
