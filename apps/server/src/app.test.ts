/**
 * @file app.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 应用装配与路由测试：不起端口直接 app.request——创建校验、列表合并、详情、删除、取消、review 决策、工件快照、SSE 重放帧、媒体路径安全与 Range、静态页面与系统端点。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "@aivideo/core";
import { buildApp } from "./app.js";
import { serverConfigFromEnv } from "./config.js";
import { JobRunner } from "./jobs/job-runner.js";
import type { StageRunner } from "./jobs/stages.js";
import { safeResolveProjectFile } from "./routes/media.js";
import type { JobRequest } from "./types.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：最小配置（仅 defaults/profiles 被路由读取）。
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

/** 全部立即成功的假阶段。 */
const noopStages: StageRunner = {
  async runScript() {},
  async runAssets() {},
  async runAudio() {},
  async runRender() {}
};

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：装配测试应用：真实 JobRunner + 假阶段 + 临时项目根。
 */
function makeTestApp(): {
  app: ReturnType<typeof buildApp>;
  runner: JobRunner;
  projectsRoot: string;
  cleanup: () => void;
} {
  const projectsRoot = mkdtempSync(join(tmpdir(), "aivideo-app-"));
  const runner = new JobRunner({
    cwd: projectsRoot,
    projectsRoot,
    config: makeConfig(),
    providers: {},
    stages: noopStages
  });
  const here = dirname(fileURLToPath(import.meta.url));
  const app = buildApp({
    cwd: projectsRoot,
    projectsRoot,
    config: makeConfig(),
    providers: {},
    runner,
    publicDir: resolve(here, join("..", "public"))
  });
  return { app, runner, projectsRoot, cleanup: () => rmSync(projectsRoot, { recursive: true, force: true }) };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：轮询等待条件成立。
 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
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
 * 功能：创建一个自动模式任务并等待其 done。
 */
async function createDoneJob(ctx: ReturnType<typeof makeTestApp>, theme = "测试"): Promise<string> {
  const res = await ctx.app.request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ briefText: `主题：${theme}` })
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { job: { id: string } };
  await waitUntil(() => ctx.runner.get(body.job.id)?.phase === "done", "done");
  return body.job.id;
}

test("POST /api/projects 缺少 theme/content 返回 400", async () => {
  const ctx = makeTestApp();
  try {
    const res = await ctx.app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
    const bad = await ctx.app.request("/api/projects", { method: "POST", body: "not-json" });
    assert.equal(bad.status, 400);
  } finally {
    ctx.cleanup();
  }
});

test("POST 创建解析结构化 brief 并跑完自动链", async () => {
  const ctx = makeTestApp();
  try {
    const res = await ctx.app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ briefText: "主题：夏季防晒喷雾；时长：45s；模式：script", mode: "guided" })
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { job: { id: string; request: JobRequest; execMode: string; phase: string } };
    assert.equal(body.job.request.theme, "夏季防晒喷雾");
    assert.equal(body.job.request.durationSeconds, 45);
    assert.equal(body.job.request.generationMode, "script");
    assert.equal(body.job.execMode, "guided");
    await waitUntil(() => ctx.runner.get(body.job.id)?.phase === "awaiting", "awaiting script checkpoint");
    assert.equal(ctx.runner.get(body.job.id)?.checkpoint, "script");
  } finally {
    ctx.cleanup();
  }
});

test("GET /api/projects 合并任务与无任务旧目录", async () => {
  const ctx = makeTestApp();
  try {
    mkdirSync(join(ctx.projectsRoot, "legacy-dir"), { recursive: true });
    writeFileSync(join(ctx.projectsRoot, "legacy-dir", "script.json"), JSON.stringify({ title: "旧项目" }), "utf8");
    const jobId = await createDoneJob(ctx);
    const res = await ctx.app.request("/api/projects");
    const body = (await res.json()) as {
      projects: Array<{ projectId: string; kind: string; title?: string; job?: { id: string } }>;
    };
    const jobItem = body.projects.find((item) => item.projectId === jobId);
    const legacyItem = body.projects.find((item) => item.projectId === "legacy-dir");
    assert.equal(jobItem?.kind, "job");
    assert.equal(legacyItem?.kind, "project");
    assert.equal(legacyItem?.title, "旧项目");
  } finally {
    ctx.cleanup();
  }
});

test("GET/DELETE /api/projects/:id 与取消/review 边界", async () => {
  const ctx = makeTestApp();
  try {
    assert.equal((await ctx.app.request("/api/projects/unknown-id")).status, 404);
    const jobId = await createDoneJob(ctx);

    assert.equal((await ctx.app.request(`/api/projects/${jobId}`)).status, 200);
    assert.equal((await ctx.app.request(`/api/projects/${jobId}/cancel`, { method: "POST" })).status, 409, "done 不可取消");
    const badDecision = await ctx.app.request(`/api/projects/${jobId}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "nope" })
    });
    assert.equal(badDecision.status, 400);
    assert.equal(
      (
        await ctx.app.request(`/api/projects/${jobId}/review`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "approve" })
        })
      ).status,
      409,
      "非 awaiting 不接受 approve"
    );

    mkdirSync(join(ctx.projectsRoot, "legacy-2"), { recursive: true });
    assert.equal((await ctx.app.request("/api/projects/legacy-2", { method: "DELETE" })).status, 200);
    assert.equal((await ctx.app.request("/api/projects/ghost-3", { method: "DELETE" })).status, 404);
    assert.equal((await ctx.app.request("/api/projects/a..b", { method: "DELETE" })).status, 400, "非法 id 拒绝");
    assert.equal((await ctx.app.request(`/api/projects/${jobId}`, { method: "DELETE" })).status, 200);
    assert.equal((await ctx.app.request(`/api/projects/${jobId}`)).status, 404, "forget 后消失");
  } finally {
    ctx.cleanup();
  }
});

test("GET /:id/artifacts 汇总工件与成片就绪", async () => {
  const ctx = makeTestApp();
  try {
    const jobId = await createDoneJob(ctx);
    const dir = join(ctx.projectsRoot, jobId);
    mkdirSync(join(dir, "assets"), { recursive: true });
    mkdirSync(join(dir, "audio"), { recursive: true });
    mkdirSync(join(dir, "output"), { recursive: true });
    writeFileSync(join(dir, "storyboard.json"), JSON.stringify({ shots: [{ id: "shot-01", narration: "n" }] }), "utf8");
    writeFileSync(join(dir, "assets", "shot-01.png"), "png", "utf8");
    writeFileSync(join(dir, "audio", "shot-01.wav"), "wav", "utf8");
    writeFileSync(join(dir, "output", "final.mp4"), "0123456789", "utf8");
    writeFileSync(
      join(dir, "render-manifest.json"),
      JSON.stringify({ shots: [{ shotId: "shot-01", assetPath: "assets/shot-01.png" }], outputFile: "output/final.mp4" }),
      "utf8"
    );
    const body = (await (await ctx.app.request(`/api/projects/${jobId}/artifacts`)).json()) as {
      videoReady: boolean;
      shots: Array<{ files: Record<string, string | null> }>;
    };
    assert.equal(body.videoReady, true);
    assert.deepEqual(body.shots[0]?.files, {
      video: null,
      image: "assets/shot-01.png",
      audio: "audio/shot-01.wav",
      manifestAsset: "assets/shot-01.png"
    });
  } finally {
    ctx.cleanup();
  }
});

test("GET /:id/events 重放历史帧并支持 Last-Event-ID 续传", async () => {
  const ctx = makeTestApp();
  try {
    const jobId = await createDoneJob(ctx);
    const first = await ctx.app.request(`/api/projects/${jobId}/events`);
    assert.equal(first.headers.get("content-type"), "text/event-stream");
    const reader = first.body?.getReader();
    assert.ok(reader);
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /^id: 1\ndata: \{.*"type":"status".*\}\n\n/, "首帧为 id:1 的 status 事件");
    await reader.cancel();

    const resumed = await ctx.app.request(`/api/projects/${jobId}/events`, {
      headers: { "last-event-id": "1" }
    });
    const resumeReader = resumed.body?.getReader();
    assert.ok(resumeReader);
    const resumedChunk = new TextDecoder().decode((await resumeReader.read()).value);
    assert.match(resumedChunk, /^id: 2\n/, "续传帧从 id:2 开始");
    await resumeReader.cancel();

    assert.equal((await ctx.app.request("/api/projects/ghost/events")).status, 404);
  } finally {
    ctx.cleanup();
  }
});

test("safeResolveProjectFile 拒绝绝对路径、穿越与白名单外扩展名", () => {
  const bad1 = safeResolveProjectFile("/tmp/proj", "/etc/passwd");
  assert.equal(bad1.ok, false);
  assert.equal(bad1.status, 400);
  const bad2 = safeResolveProjectFile("/tmp/proj", "../secret.png");
  assert.equal(bad2.ok, false);
  const bad3 = safeResolveProjectFile("/tmp/proj", "notes/../../x.png");
  assert.equal(bad3.ok, false);
  const bad4 = safeResolveProjectFile("/tmp/proj", "evil.exe");
  assert.equal(bad4.ok, false);
  assert.match((bad4 as { error: string }).error, /not allowed/);
  const ok = safeResolveProjectFile("/tmp/proj", "assets/shot.png");
  assert.equal(ok.ok, true);
  assert.equal((ok as { path: string }).path, resolve("/tmp/proj", "assets/shot.png"));
});

test("GET /:id/video 支持 Range：206 分段、416 越界、200 全量", async () => {
  const ctx = makeTestApp();
  try {
    const jobId = await createDoneJob(ctx);
    const dir = join(ctx.projectsRoot, jobId);
    mkdirSync(join(dir, "output"), { recursive: true });
    writeFileSync(join(dir, "output", "final.mp4"), "0123456789", "utf8");
    writeFileSync(join(dir, "render-manifest.json"), JSON.stringify({ shots: [], outputFile: "output/final.mp4" }), "utf8");

    const full = await ctx.app.request(`/api/projects/${jobId}/video`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("content-length"), "10");

    const partial = await ctx.app.request(`/api/projects/${jobId}/video`, { headers: { range: "bytes=0-3" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), "bytes 0-3/10");
    assert.equal(await partial.text(), "0123");

    const suffix = await ctx.app.request(`/api/projects/${jobId}/video`, { headers: { range: "bytes=-4" } });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), "bytes 6-9/10");

    const overflow = await ctx.app.request(`/api/projects/${jobId}/video`, { headers: { range: "bytes=100-" } });
    assert.equal(overflow.status, 416);
  } finally {
    ctx.cleanup();
  }
});

test("静态工作台页面与系统端点", async () => {
  const ctx = makeTestApp();
  try {
    const index = await ctx.app.request("/");
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await index.text(), /镜头墙工作台/);
    assert.equal((await ctx.app.request("/app.css")).status, 200);
    assert.equal((await ctx.app.request("/app.js")).status, 200);
    assert.equal((await ctx.app.request("/missing.xyz")).status, 404);

    const health = (await (await ctx.app.request("/api/healthz")).json()) as { ok: boolean };
    assert.equal(health.ok, true);
    const skills = (await (await ctx.app.request("/api/skills")).json()) as { skills: unknown[] };
    assert.ok(skills.skills.length > 0);
    const summary = (await (await ctx.app.request("/api/summary")).json()) as { profiles: string[] };
    assert.ok(summary.profiles.includes("default"));
  } finally {
    ctx.cleanup();
  }
});

test("serverConfigFromEnv 默认与覆盖", () => {
  assert.deepEqual(serverConfigFromEnv({}), { host: "127.0.0.1", port: 8787 });
  assert.deepEqual(serverConfigFromEnv({ AIVIDEO_SERVER_HOST: "0.0.0.0", AIVIDEO_SERVER_PORT: "9000" }), {
    host: "0.0.0.0",
    port: 9000
  });
  assert.deepEqual(serverConfigFromEnv({ AIVIDEO_SERVER_PORT: "not-a-port" }), { host: "127.0.0.1", port: 8787 });
  assert.deepEqual(serverConfigFromEnv({ AIVIDEO_SERVER_PORT: "99999" }), { host: "127.0.0.1", port: 8787 });
});
