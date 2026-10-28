/**
 * @file app.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 应用装配与路由测试：不起端口直接 app.request——创建校验（含参考图分片上传：建会话/逐张 PUT/按序搬进 input/、旧 base64 明确拒绝、缺张与越界与坏魔数与超限拒绝）、列表合并、详情、删除、取消、review 决策、工件快照、SSE 重放帧、媒体路径安全与 Range、静态页面缓存策略与系统端点。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serverConfigFromEnv } from "./config.js";
import { safeResolveProjectFile } from "./routes/media.js";
import type { JobRequest } from "./types.js";
import { createDoneJob, makeTestApp, waitUntil } from "./testkit.js";

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
    assert.equal((await ctx.app.request("/api/projects/a..b/artifacts")).status, 400, "artifacts 非法 id 拒绝");
    assert.equal((await ctx.app.request("/api/projects/a..b/events")).status, 400, "events 非法 id 拒绝");
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
    writeFileSync(join(dir, "storyboard.json"), JSON.stringify({ shots: [{ id: "shot-01", narration: "n" }, { id: "shot-02", narration: "n" }, { id: "shot-03", narration: "n" }] }), "utf8");
    mkdirSync(join(dir, "input"), { recursive: true });
    writeFileSync(join(dir, "assets", "shot-01.png"), "png", "utf8");
    writeFileSync(join(dir, "input", "1.png"), "png", "utf8");
    writeFileSync(join(dir, "audio", "shot-01.wav"), "wav", "utf8");
    writeFileSync(join(dir, "output", "final.mp4"), "0123456789", "utf8");
    writeFileSync(
      join(dir, "render-manifest.json"),
      JSON.stringify({
        shots: [
          { shotId: "shot-01", assetPath: "assets/shot-01.png" },
          { shotId: "shot-02", assetPath: join(dir, "input", "1.png") },
          { shotId: "shot-03", assetPath: "/etc/hostname" }
        ],
        outputFile: "output/final.mp4"
      }),
      "utf8"
    );
    const body = (await (await ctx.app.request(`/api/projects/${jobId}/artifacts`)).json()) as {
      videoReady: boolean;
      scriptMdReady: boolean;
      captionsReady: boolean;
      shots: Array<{ files: Record<string, string | null> }>;
    };
    assert.equal(body.videoReady, true);
    assert.equal(body.scriptMdReady, false, "没有 script.md 时不给下载入口");
    assert.equal(body.captionsReady, false, "没有 captions.srt 时不给下载入口");
    assert.deepEqual(body.shots[0]?.files, {
      video: null,
      image: "assets/shot-01.png",
      audio: "audio/shot-01.wav",
      manifestAsset: "assets/shot-01.png"
    });
    assert.equal(body.shots[1]?.files.manifestAsset, "input/1.png", "项目内绝对 assetPath 归一化为相对路径");
    assert.equal(body.shots[2]?.files.manifestAsset, null, "越界绝对 assetPath 拒绝外泄");

    // 字幕/脚本是「交付物但没有下载口」的那两份：落盘后要能被快照看见。
    writeFileSync(join(dir, "script.md"), "# 脚本", "utf8");
    mkdirSync(join(dir, "captions"), { recursive: true });
    writeFileSync(join(dir, "captions", "captions.srt"), "1\n00:00:00,000 --> 00:00:01,000\nhi\n", "utf8");
    const withExtras = (await (await ctx.app.request(`/api/projects/${jobId}/artifacts`)).json()) as {
      scriptMdReady: boolean;
      captionsReady: boolean;
    };
    assert.equal(withExtras.scriptMdReady, true);
    assert.equal(withExtras.captionsReady, true);

    // 重渲覆盖前的上一版：只有 .prev 槽位在盘时交付面板才给出取回入口。
    const beforePrev = (await (await ctx.app.request(`/api/projects/${jobId}/artifacts`)).json()) as {
      previousVideoReady: boolean;
      previousVideoFile: string | null;
    };
    assert.equal(beforePrev.previousVideoReady, false);
    assert.equal(beforePrev.previousVideoFile, null);
    writeFileSync(join(dir, "output", "final.prev.mp4"), "9876543210", "utf8");
    const withPrev = (await (await ctx.app.request(`/api/projects/${jobId}/artifacts`)).json()) as {
      previousVideoReady: boolean;
      previousVideoFile: string | null;
    };
    assert.equal(withPrev.previousVideoReady, true);
    assert.equal(withPrev.previousVideoFile, "output/final.prev.mp4", "给出相对路径供 /file 拼接");
    // 上一版要真的能取回：走既有 /file 白名单端点即可，不需要新端点。
    const prevFile = await ctx.app.request(
      `/api/projects/${jobId}/file?path=${encodeURIComponent("output/final.prev.mp4")}`
    );
    assert.equal(prevFile.status, 200);
    assert.equal(await prevFile.text(), "9876543210");
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

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：开一个上传会话并返回 uploadId（同时断言会话响应里的张数/单张上限）。
 */
async function openUploadSession(ctx: ReturnType<typeof makeTestApp>): Promise<string> {
  const res = await ctx.app.request("/api/uploads", { method: "POST" });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { uploadId: string; maxImages: number; maxBytes: number };
  assert.equal(body.maxImages, 20);
  assert.equal(body.maxBytes, 10 * 1024 * 1024);
  return body.uploadId;
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：向会话的某个序号 PUT 一张图，返回原始响应供调用方断言状态码。
 */
async function putImage(
  ctx: ReturnType<typeof makeTestApp>,
  uploadId: string,
  index: number,
  bytes: Uint8Array
): Promise<Response> {
  return ctx.app.request(`/api/uploads/${uploadId}/${index}`, { method: "PUT", body: bytes });
}

test("分片上传：建会话 → 逐张 PUT → 创建时按序搬进 input/ 并销毁会话", async () => {
  const ctx = makeTestApp();
  try {
    const uploadId = await openUploadSession(ctx);
    assert.equal((await putImage(ctx, uploadId, 0, PNG_BYTES)).status, 200);
    assert.equal((await putImage(ctx, uploadId, 1, JPG_BYTES)).status, 200);

    const session = (await (await ctx.app.request(`/api/uploads/${uploadId}`)).json()) as {
      images: Array<{ index: number; ext: string; bytes: number }>;
    };
    assert.deepEqual(
      session.images.map((image) => [image.index, image.ext]),
      [
        [0, "png"],
        [1, "jpg"]
      ]
    );

    const res = await ctx.app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ briefText: "主题：带图", uploadId })
    });
    assert.equal(res.status, 201);
    const { job } = (await res.json()) as { job: { id: string; request: JobRequest } };
    assert.equal(job.request.inputImagePaths?.length, 2);
    assert.ok(existsSync(join(ctx.projectsRoot, job.id, "input", "1.png")));
    assert.ok(existsSync(join(ctx.projectsRoot, job.id, "input", "2.jpg")));
    // 搬完即销毁：同一会话不能被复用去建第二个任务（避免两任务共享同一批输入目录语义）
    assert.equal((await ctx.app.request(`/api/uploads/${uploadId}`)).status, 404);
  } finally {
    ctx.cleanup();
  }
});

test("分片上传：旧的内联 images 被明确拒绝，坏魔数/越界序号/缺张/未知会话各自报错", async () => {
  const ctx = makeTestApp();
  try {
    const legacy = await ctx.app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ briefText: "主题：旧路径", images: [PNG_BYTES.toString("base64")] })
    });
    assert.equal(legacy.status, 400);
    assert.match(((await legacy.json()) as { error: string }).error, /分片上传/);

    const uploadId = await openUploadSession(ctx);
    const badMagic = await putImage(ctx, uploadId, 0, Buffer.from("not-an-image"));
    assert.equal(badMagic.status, 400);
    assert.match(((await badMagic.json()) as { error: string }).error, /不是受支持的图片/);
    const outOfRange = await putImage(ctx, uploadId, 20, PNG_BYTES);
    assert.equal(outOfRange.status, 400);

    // 0、2 有图而 1 缺失：序号不连续就不搬，否则镜头绑定会错位
    assert.equal((await putImage(ctx, uploadId, 0, PNG_BYTES)).status, 200);
    assert.equal((await putImage(ctx, uploadId, 2, PNG_BYTES)).status, 200);
    const missing = await ctx.app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ briefText: "主题：缺张", uploadId })
    });
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as { error: string }).error, /第 2 张缺失/);
    // 失败时会话一并销毁：半截会话重试只会继续缺张，不如让客户端整批重传
    assert.equal((await ctx.app.request(`/api/uploads/${uploadId}`)).status, 404);

    // 未知/畸形会话 id：一律 404，不泄露目录结构
    assert.equal((await putImage(ctx, "00000000-0000-4000-8000-000000000000", 0, PNG_BYTES)).status, 404);
    assert.equal((await putImage(ctx, "../../etc", 0, PNG_BYTES)).status, 404);
    const unknown = await ctx.app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ briefText: "主题：无会话", uploadId: "00000000-0000-4000-8000-000000000000" })
    });
    assert.equal(unknown.status, 400);
    assert.match(((await unknown.json()) as { error: string }).error, /不存在或已过期/);
  } finally {
    ctx.cleanup();
  }
});

test("分片上传：单张超过 10MB 拒绝且不落盘，.uploads 不出现在项目列表", async () => {
  const ctx = makeTestApp();
  try {
    const uploadId = await openUploadSession(ctx);
    // 真发一个 10MB+1 的体：Content-Length 预检与边读边限流两条路都走一遍
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    PNG_BYTES.copy(oversized, 0);
    const res = await putImage(ctx, uploadId, 0, oversized);
    assert.equal(res.status, 413);
    assert.equal(readdirSync(join(ctx.projectsRoot, ".uploads", uploadId)).length, 0, "超限文件不残留");

    const list = (await (await ctx.app.request("/api/projects")).json()) as { projects: unknown[] };
    assert.equal(list.projects.length, 0, ".uploads 首字符非字母数字，扫描时被跳过");

    const del = await ctx.app.request(`/api/uploads/${uploadId}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal((await ctx.app.request(`/api/uploads/${uploadId}/0`, { method: "PUT", body: PNG_BYTES })).status, 404);
  } finally {
    ctx.cleanup();
  }
});

test("静态缓存头：入口 no-cache、哈希 assets immutable", async () => {
  const publicDir = mkdtempSync(join(tmpdir(), "aivideo-static-"));
  mkdirSync(join(publicDir, "assets"), { recursive: true });
  writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>t</title>", "utf8");
  writeFileSync(join(publicDir, "assets", "index-AbC123.js"), "console.log(1)", "utf8");
  const ctx = makeTestApp({ publicDir });
  try {
    const index = await ctx.app.request("/index.html");
    assert.equal(index.status, 200);
    assert.equal(index.headers.get("cache-control"), "no-cache");
    const asset = await ctx.app.request("/assets/index-AbC123.js");
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const page = await ctx.app.request("/");
    assert.equal(page.headers.get("cache-control"), "no-cache", "入口同样 no-cache");
  } finally {
    ctx.cleanup();
    rmSync(publicDir, { recursive: true, force: true });
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

test("serverConfigFromEnv 的保留期不填即关闭", () => {
  // 默认不带 retentionDays 这个键：调用方一个 if 就能判断「清理功能没开」。
  assert.equal("retentionDays" in serverConfigFromEnv({}), false);
  assert.equal(serverConfigFromEnv({ AIVIDEO_RETENTION_DAYS: "7" }).retentionDays, 7);
  for (const bad of ["", "0", "-3", "abc", "7.5"]) {
    assert.equal(
      "retentionDays" in serverConfigFromEnv({ AIVIDEO_RETENTION_DAYS: bad }),
      false,
      `非法保留期 ${JSON.stringify(bad)} 不开启清理`
    );
  }
});
