/**
 * @file testkit.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description server 测试公共装配：最小配置、假阶段执行器、真实 JobRunner + buildApp 的测试应用（临时项目根）、任务创建与等待助手。非 *.test.ts，不被测试运行器收集。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, ProviderSelection } from "@aivideo/core";
import { buildApp } from "./app.js";
import { JobRunner } from "./jobs/job-runner.js";
import type { StageContext, StageRunner } from "./jobs/stages.js";
import type { JobRequest } from "./types.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：最小配置（仅 defaults/profiles 被路由读取）。
 */
export function makeConfig(): AppConfig {
  return {
    defaults: {
      profile: "default",
      aspectRatio: "9:16",
      durationSeconds: 30,
      language: "zh-CN",
      platform: "douyin",
      projectsDir: "project",
      gpu: false
    },
    providers: {},
    profiles: { default: {} }
  } as unknown as AppConfig;
}

/** 全部立即成功的假阶段。 */
export const noopStages: StageRunner = {
  async runScript() {},
  async runAssets() {},
  async runAudio() {},
  async runRender() {}
};

/** hangStages：script 阶段挂起直到 abort，其余立即成功（测并发闸门）。 */
export const hangScriptStages: StageRunner = {
  async runScript(ctx: StageContext) {
    await new Promise<void>((_resolve, reject) => {
      ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  },
  async runAssets() {},
  async runAudio() {},
  async runRender() {}
};

/** 测试应用上下文。 */
export interface TestAppContext {
  app: ReturnType<typeof buildApp>;
  runner: JobRunner;
  projectsRoot: string;
  cleanup: () => void;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：装配测试应用：真实 JobRunner + 可注入假阶段/providersFor/静态目录 + 临时项目根。
 */
export function makeTestApp(
  options: {
    stages?: StageRunner;
    providersFor?: (profile?: string) => ProviderSelection;
    publicDir?: string;
  } = {}
): TestAppContext {
  const projectsRoot = mkdtempSync(join(tmpdir(), "aivideo-app-"));
  const config = makeConfig();
  const runner = new JobRunner({
    cwd: projectsRoot,
    projectsRoot,
    config,
    providers: {},
    providersFor: options.providersFor,
    stages: options.stages ?? noopStages
  });
  const here = dirname(fileURLToPath(import.meta.url));
  const app = buildApp({
    cwd: projectsRoot,
    projectsRoot,
    config,
    providers: {},
    providersFor: options.providersFor ?? (() => ({})),
    runner,
    publicDir: options.publicDir ?? resolve(here, join("..", "public"))
  });
  return { app, runner, projectsRoot, cleanup: () => rmSync(projectsRoot, { recursive: true, force: true }) };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：轮询等待条件成立（默认 2s 超时）。
 */
export async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timeout waiting for: ${label}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：构造最小任务请求。
 */
export function makeRequest(theme = "测试主题"): JobRequest {
  return {
    theme,
    generationMode: "video",
    skill: "auto",
    aspectRatio: "9:16",
    durationSeconds: 30,
    language: "zh-CN",
    platform: "douyin"
  };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：创建一个自动模式任务并等待其 done。
 */
export async function createDoneJob(ctx: TestAppContext, theme = "测试"): Promise<string> {
  const res = await ctx.app.request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ briefText: `主题：${theme}` })
  });
  if (res.status !== 201) {
    throw new Error(`create failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { job: { id: string } };
  await waitUntil(() => ctx.runner.get(body.job.id)?.phase === "done", "done");
  return body.job.id;
}
