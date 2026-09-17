/**
 * @file job-runner.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 任务引擎测试：注入假阶段执行器验证 auto 全链、guided 五检查点推进与计费闸插入、redo-stage、取消（排队/运行中）、boot 恢复与损坏隔离、阶段失败落 failed。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, ProviderSelection } from "@aivideo/core";
import type { JobRequest, StageKind } from "../types.js";
import { JobRunner } from "./job-runner.js";
import { writeJob } from "./job-store.js";
import type { StageContext, StageRunner } from "./stages.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：最小可用配置（假阶段不触碰真实字段）。
 */
function makeConfig(): AppConfig {
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：最小任务请求。
 */
function makeRequest(theme = "测试主题"): JobRequest {
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
 * 功能：假阶段执行器：记录调用顺序，可注入挂起/失败行为。
 */
function makeFakeStages(
  hooks: { hang?: (stage: StageKind, ctx: StageContext) => Promise<void>; failAt?: StageKind } = {}
): { stages: StageRunner; calls: StageKind[] } {
  const calls: StageKind[] = [];
  const run = (stage: StageKind) => async (ctx: StageContext): Promise<void> => {
    calls.push(stage);
    if (hooks.hang) {
      await hooks.hang(stage, ctx);
    }
    if (hooks.failAt === stage) {
      throw new Error(`boom:${stage}`);
    }
  };
  return {
    stages: {
      runScript: run("script"),
      runAssets: run("assets"),
      runAudio: run("audio"),
      runRender: run("render")
    },
    calls
  };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：轮询等待条件成立（默认 2s 超时）。
 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timeout waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：创建带临时项目根目录与假阶段的 runner。
 */
function makeRunner(options: { stages: StageRunner; providersFor?: (profile?: string) => ProviderSelection }): {
  runner: JobRunner;
  projectsRoot: string;
  cleanup: () => void;
} {
  const projectsRoot = mkdtempSync(join(tmpdir(), "aivideo-runner-"));
  const runner = new JobRunner({
    cwd: projectsRoot,
    projectsRoot,
    config: makeConfig(),
    providers: {},
    providersFor: options.providersFor,
    stages: options.stages
  });
  return { runner, projectsRoot, cleanup: () => rmSync(projectsRoot, { recursive: true, force: true }) };
}

test("auto 模式直跑四阶段至 done 并落盘", async () => {
  const { stages, calls } = makeFakeStages();
  const { runner, projectsRoot, cleanup } = makeRunner({ stages });
  try {
    const job = runner.create({ execMode: "auto", request: makeRequest() });
    await waitUntil(() => runner.get(job.id)?.phase === "done", "done");
    assert.deepEqual(calls, ["script", "assets", "audio", "render"]);
    assert.equal(runner.dto(job.id)?.phase, "done");
    assert.equal(runner.dto(job.id)?.result?.videoStale, false);
    assert.ok(projectsRoot);
  } finally {
    cleanup();
  }
});

test("guided 模式逐检查点推进（本地提供者不插入计费闸）", async () => {
  const { stages, calls } = makeFakeStages();
  const { runner, cleanup } = makeRunner({ stages });
  try {
    const job = runner.create({ execMode: "guided", request: makeRequest() });
    await waitUntil(() => runner.get(job.id)?.phase === "awaiting" && runner.get(job.id)?.checkpoint === "script", "awaiting script");
    assert.deepEqual(calls, ["script"]);

    assert.equal(runner.review(job.id, "approve"), true);
    await waitUntil(() => runner.get(job.id)?.checkpoint === "shots", "awaiting shots");
    assert.equal(runner.review(job.id, "approve"), true);
    await waitUntil(() => runner.get(job.id)?.checkpoint === "audio", "awaiting audio");
    assert.equal(runner.review(job.id, "approve"), true);
    await waitUntil(() => runner.get(job.id)?.checkpoint === "final", "awaiting final");
    assert.deepEqual(calls, ["script", "assets", "audio", "render"]);
    assert.equal(runner.review(job.id, "approve"), true);
    assert.equal(runner.get(job.id)?.phase, "done");
  } finally {
    cleanup();
  }
});

test("guided 在存在远端提供者时插入 cost 检查点", async () => {
  const { stages } = makeFakeStages();
  const remote: ProviderSelection = { video: { id: "remote-video", isRemote: true } as ProviderSelection["video"] };
  const { runner, cleanup } = makeRunner({ stages, providersFor: () => remote });
  try {
    const job = runner.create({ execMode: "guided", request: makeRequest() });
    await waitUntil(() => runner.get(job.id)?.checkpoint === "script", "awaiting script");
    assert.equal(runner.review(job.id, "approve"), true);
    assert.equal(runner.get(job.id)?.phase, "awaiting");
    assert.equal(runner.get(job.id)?.checkpoint, "cost");
    assert.equal(runner.review(job.id, "approve"), true);
    await waitUntil(() => runner.get(job.id)?.checkpoint === "shots", "awaiting shots");
    assert.equal(runner.get(job.id)?.phase, "awaiting");
  } finally {
    cleanup();
  }
});

test("redo-stage 重新入队执行指定阶段", async () => {
  const { stages, calls } = makeFakeStages();
  const { runner, cleanup } = makeRunner({ stages });
  try {
    const job = runner.create({ execMode: "guided", request: makeRequest() });
    await waitUntil(() => runner.get(job.id)?.checkpoint === "script", "awaiting script");
    assert.equal(runner.review(job.id, "redo-stage", "script"), true);
    await waitUntil(() => calls.filter((stage) => stage === "script").length === 2, "script rerun");
    await waitUntil(() => runner.get(job.id)?.checkpoint === "script", "awaiting script again");
  } finally {
    cleanup();
  }
});

test("取消运行中的任务：abort 信号送达阶段并落 cancelled", async () => {
  const { stages } = makeFakeStages({
    hang: (_stage, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })
  });
  const { runner, cleanup } = makeRunner({ stages });
  try {
    const job = runner.create({ execMode: "auto", request: makeRequest() });
    await waitUntil(() => runner.get(job.id)?.phase === "running", "running");
    assert.equal(runner.cancel(job.id), true);
    await waitUntil(() => runner.get(job.id)?.phase === "cancelled", "cancelled");
    assert.equal(runner.cancel(job.id), false, "终态不可再取消");
  } finally {
    cleanup();
  }
});

test("取消排队中的任务并保留队首", async () => {
  const gate = { release: () => {} };
  const blocked = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const { stages, calls } = makeFakeStages({
    hang: async (stage) => {
      if (stage === "script") {
        await blocked;
      }
    }
  });
  const { runner, cleanup } = makeRunner({ stages });
  try {
    const first = runner.create({ execMode: "auto", request: makeRequest("一") });
    const second = runner.create({ execMode: "auto", request: makeRequest("二") });
    await waitUntil(() => runner.get(first.id)?.phase === "running", "first running");
    assert.equal(runner.get(second.id)?.phase, "queued");
    assert.equal(runner.dto(second.id)?.queuePosition, 1);

    assert.equal(runner.cancel(second.id), true);
    gate.release();
    await waitUntil(() => runner.get(first.id)?.phase === "done", "first done");
    assert.equal(runner.get(second.id)?.phase, "cancelled", "被取消任务不得继续执行");
    assert.equal(calls.filter((stage) => stage === "script").length, 1);
  } finally {
    cleanup();
  }
});

test("boot 恢复 running 任务：从原阶段续跑", async () => {
  const { stages, calls } = makeFakeStages();
  const { runner, projectsRoot, cleanup } = makeRunner({ stages });
  try {
    const projectsRootForBoot = projectsRoot;
    writeJob(projectsRootForBoot, {
      id: "recover-me",
      projectId: "recover-me",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      execMode: "auto",
      phase: "running",
      stage: "assets",
      request: makeRequest("恢复")
    });
    runner.boot();
    await waitUntil(() => runner.get("recover-me")?.phase === "done", "recovered done");
    assert.deepEqual(calls, ["assets", "audio", "render"], "应跳过 script 从 assets 续跑");
  } finally {
    cleanup();
  }
});

test("boot 跳过损坏与终态任务，不自动执行", async () => {
  const { stages, calls } = makeFakeStages();
  const { runner, projectsRoot, cleanup } = makeRunner({ stages });
  try {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(projectsRoot, "corrupt-job"), { recursive: true });
    writeFileSync(join(projectsRoot, "corrupt-job", "job.json"), "{ not json", "utf8");
    writeJob(projectsRoot, {
      id: "already-done",
      projectId: "already-done",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      execMode: "auto",
      phase: "done",
      request: makeRequest("完成")
    });
    runner.boot();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(calls, []);
    assert.equal(runner.get("already-done")?.phase, "done");
    assert.equal(runner.get("corrupt-job"), undefined);
  } finally {
    cleanup();
  }
});

test("script 产物模式：auto 在脚本阶段后直接 done，不进入渲染", async () => {
  const { stages, calls } = makeFakeStages();
  const { runner, cleanup } = makeRunner({ stages });
  try {
    const request = makeRequest("只要脚本");
    request.generationMode = "script";
    const job = runner.create({ execMode: "auto", request });
    await waitUntil(() => runner.get(job.id)?.phase === "done", "done");
    assert.deepEqual(calls, ["script"]);
  } finally {
    cleanup();
  }
});

test("script 产物模式：guided 在 script 检查点 approve 后即 done", async () => {
  const { stages, calls } = makeFakeStages();
  const remote: ProviderSelection = { video: { id: "remote-video", isRemote: true } as ProviderSelection["video"] };
  const { runner, cleanup } = makeRunner({ stages, providersFor: () => remote });
  try {
    const request = makeRequest("只要脚本");
    request.generationMode = "script";
    const job = runner.create({ execMode: "guided", request });
    await waitUntil(() => runner.get(job.id)?.checkpoint === "script", "awaiting script");
    assert.equal(runner.review(job.id, "approve"), true);
    assert.equal(runner.get(job.id)?.phase, "done");
    assert.deepEqual(calls, ["script"]);
  } finally {
    cleanup();
  }
});

test("阶段抛错落 failed 并记录错误", async () => {
  const { stages } = makeFakeStages({ failAt: "assets" });
  const { runner, cleanup } = makeRunner({ stages });
  try {
    const job = runner.create({ execMode: "auto", request: makeRequest() });
    await waitUntil(() => runner.get(job.id)?.phase === "failed", "failed");
    assert.match(runner.get(job.id)?.error ?? "", /boom:assets/);
  } finally {
    cleanup();
  }
});
