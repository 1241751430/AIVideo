/**
 * @file review.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 检查点编辑与重试路由测试：并发闸门（running/queued 拒绝、cancelled 放行）、脚本元信息 PUT、单镜编辑失效矩阵（旁白删 wav、画面词删资产、字幕仅标失效）、单镜重试（删文件+重入对应阶段）、镜头拖拽排序 PUT order、批量重试 retry-batch（缺省失败镜头/显式指定/闸门）、计费预览与重新渲染、失败/取消后从断点继续（resume）。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderSelection } from "@aivideo/core";
import { readRenderManifestFile } from "@aivideo/core";
import type { StageRunner } from "../jobs/stages.js";
import { createDoneJob, hangScriptStages, makeTestApp, waitUntil } from "../testkit.js";
import type { StageKind } from "../types.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：向项目目录写 JSON 文件（自动建目录）。
 */
function putJson(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value), "utf8");
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：向项目目录写入单镜可编辑项目的标准 fixture。
 */
function writeShotFixtures(dir: string): void {
  putJson(dir, "storyboard.json", {
    shots: [{ id: "shot-1", title: "开场", narration: "旧旁白", caption: "旧字幕", visualPrompt: "旧画面", durationSeconds: 3 }]
  });
  putJson(dir, "render-manifest.json", {
    shots: [{ shotId: "shot-1", assetKind: "generated-image", assetPath: "assets/shot-1.png", durationSeconds: 3 }],
    outputFile: "output/final.mp4"
  });
  mkdirSync(join(dir, "audio"), { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "audio", "shot-1.wav"), "wav", "utf8");
  writeFileSync(join(dir, "assets", "shot-1.png"), "png", "utf8");
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：写入两镜 fixture：shot-1 有画面+配音，shot-2 无任何产物（批量重试缺省目标的对照样本）。
 */
function writeTwoShotFixtures(dir: string): void {
  putJson(dir, "storyboard.json", {
    shots: [
      { id: "shot-1", title: "A", narration: "n1", caption: "c1", visualPrompt: "p1", durationSeconds: 3 },
      { id: "shot-2", title: "B", narration: "n2", caption: "c2", visualPrompt: "p2", durationSeconds: 3 }
    ]
  });
  putJson(dir, "render-manifest.json", {
    shots: [
      { shotId: "shot-1", assetKind: "generated-image", assetPath: "assets/shot-1.png", durationSeconds: 3 },
      { shotId: "shot-2", assetKind: "generated-card", durationSeconds: 3 }
    ],
    outputFile: "output/final.mp4"
  });
  mkdirSync(join(dir, "audio"), { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "audio", "shot-1.wav"), "wav", "utf8");
  writeFileSync(join(dir, "assets", "shot-1.png"), "png", "utf8");
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：可复位失败阶段执行器：failAt 命中时抛错，置空后恢复正常（用于「先失败、再续跑」）。
 */
function makeFlakyStages(failAt: StageKind | undefined): {
  stages: StageRunner;
  calls: StageKind[];
  control: { failAt?: StageKind };
} {
  const calls: StageKind[] = [];
  const control: { failAt?: StageKind } = { failAt };
  const run = (stage: StageKind) => async (): Promise<void> => {
    calls.push(stage);
    if (control.failAt === stage) {
      throw new Error(`boom:${stage}`);
    }
  };
  return {
    stages: { runScript: run("script"), runAssets: run("assets"), runAudio: run("audio"), runRender: run("render") },
    calls,
    control
  };
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：经 POST /api/projects 建单（测试 resume 需要「真实流转」产生的 failed/cancelled 态）。
 */
async function createJobId(ctx: ReturnType<typeof makeTestApp>, briefText: string): Promise<string> {
  const res = await ctx.app.request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ briefText })
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { job: { id: string } };
  return body.job.id;
}

test("running 拒绝编辑（409），cancel 后闸门放行", async () => {
  const ctx = makeTestApp({ stages: hangScriptStages });
  try {
    const res = await ctx.app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ briefText: "主题：卡住" })
    });
    assert.equal(res.status, 201);
    const { job } = (await res.json()) as { job: { id: string } };
    await waitUntil(() => ctx.runner.get(job.id)?.phase === "running", "running");

    const blocked = await ctx.app.request(`/api/projects/${job.id}/artifacts/script`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" })
    });
    assert.equal(blocked.status, 409);

    assert.equal((await ctx.app.request(`/api/projects/${job.id}/cancel`, { method: "POST" })).status, 200);
    await waitUntil(() => ctx.runner.get(job.id)?.phase === "cancelled", "cancelled");
    const after = await ctx.app.request(`/api/projects/${job.id}/artifacts/script`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" })
    });
    assert.equal(after.status, 400, "cancelled 后可写盘，但缺 script.json → 400");
  } finally {
    ctx.cleanup();
  }
});

test("PUT artifacts/script 更新元信息并标 videoStale", async () => {
  const ctx = makeTestApp();
  try {
    const jobId = await createDoneJob(ctx);
    const dir = join(ctx.projectsRoot, jobId);
    putJson(dir, "script.json", {
      title: "旧标题",
      summary: "s",
      openingHook: "h",
      voiceover: "v",
      bgmStyle: "轻快",
      cta: "关注",
      hashtags: ["#旧"],
      scenes: [{ id: "shot-1", heading: "开场", narration: "n", caption: "c", visualPrompt: "p", durationSeconds: 3 }]
    });
    putJson(dir, "render-manifest.json", { shots: [{ shotId: "shot-1", durationSeconds: 3 }], outputFile: "output/final.mp4" });

    const ok = await ctx.app.request(`/api/projects/${jobId}/artifacts/script`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新标题", hashtags: ["#新"] })
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { ok: boolean; videoStale: boolean; job: { result?: { videoStale?: boolean } } };
    assert.equal(body.videoStale, true);
    assert.equal(body.job.result?.videoStale, true);
    const saved = JSON.parse(readFileSync(join(dir, "script.json"), "utf8")) as { title: string; hashtags: string[] };
    assert.equal(saved.title, "新标题");
    assert.deepEqual(saved.hashtags, ["#新"]);
    assert.match(readFileSync(join(dir, "script.md"), "utf8"), /新标题/);

    const empty = await ctx.app.request(`/api/projects/${jobId}/artifacts/script`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  " })
    });
    assert.equal(empty.status, 400, "空字符串拒绝");
  } finally {
    ctx.cleanup();
  }
});

test("PUT shots/:shotId 失效矩阵：旁白删 wav、画面词删资产、字幕仅标失效", async () => {
  const ctx = makeTestApp();
  try {
    const jobId = await createDoneJob(ctx);
    const dir = join(ctx.projectsRoot, jobId);
    writeShotFixtures(dir);
    const edit = (shotId: string, patch: Record<string, unknown>) =>
      ctx.app.request(`/api/projects/${jobId}/shots/${shotId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });

    const audio = await edit("shot-1", { narration: "新旁白" });
    assert.equal(audio.status, 200);
    const audioBody = (await audio.json()) as { assetInvalidated: boolean; audioInvalidated: boolean; deleted: string[] };
    assert.equal(audioBody.audioInvalidated, true);
    assert.equal(audioBody.assetInvalidated, false);
    assert.deepEqual(audioBody.deleted, ["audio/shot-1.wav"]);
    assert.equal(existsSync(join(dir, "audio", "shot-1.wav")), false);

    const asset = await edit("shot-1", { visualPrompt: "新画面" });
    const assetBody = (await asset.json()) as { assetInvalidated: boolean; deleted: string[] };
    assert.equal(assetBody.assetInvalidated, true);
    assert.deepEqual(assetBody.deleted, ["assets/shot-1.png"]);
    assert.equal(existsSync(join(dir, "assets", "shot-1.png")), false);
    const manifest = readRenderManifestFile(dir)!;
    assert.equal(manifest.shots[0]?.assetKind, "generated-card");
    assert.equal(manifest.shots[0]?.assetPath, undefined);

    const caption = await edit("shot-1", { caption: "仅字幕" });
    const captionBody = (await caption.json()) as { assetInvalidated: boolean; audioInvalidated: boolean; deleted: string[] };
    assert.equal(captionBody.assetInvalidated, false);
    assert.equal(captionBody.audioInvalidated, false);
    assert.deepEqual(captionBody.deleted, []);

    assert.equal((await edit("../evil", { caption: "x" })).status, 404, "非法 shotId");
    assert.equal((await edit("shot-9", { caption: "x" })).status, 404, "未知镜头");
    assert.equal((await edit("shot-1", { durationSeconds: 0 })).status, 400, "时长越界");
  } finally {
    ctx.cleanup();
  }
});

test("POST shots/:shotId/retry 删文件并重入对应阶段", async () => {
  const ctx = makeTestApp();
  try {
    const jobId = await createDoneJob(ctx);
    const dir = join(ctx.projectsRoot, jobId);
    writeShotFixtures(dir);

    const badTarget = await ctx.app.request(`/api/projects/${jobId}/shots/shot-1/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "video" })
    });
    assert.equal(badTarget.status, 400);

    const unknownShot = await ctx.app.request(`/api/projects/${jobId}/shots/shot-9/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "asset" })
    });
    assert.equal(unknownShot.status, 404);

    const assetRetry = await ctx.app.request(`/api/projects/${jobId}/shots/shot-1/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "asset" })
    });
    assert.equal(assetRetry.status, 200);
    const body = (await assetRetry.json()) as { deleted: string[] };
    assert.deepEqual(body.deleted, ["assets/shot-1.png"]);
    assert.equal(existsSync(join(dir, "assets", "shot-1.png")), false);
    await waitUntil(() => ctx.runner.get(jobId)?.phase === "done", "重跑完成");

    const audioRetry = await ctx.app.request(`/api/projects/${jobId}/shots/shot-1/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "audio" })
    });
    assert.equal(audioRetry.status, 200);
    assert.deepEqual(((await audioRetry.json()) as { deleted: string[] }).deleted, ["audio/shot-1.wav"]);
    await waitUntil(() => ctx.runner.get(jobId)?.phase === "done", "音频重跑完成");

    rmSync(join(dir, "render-manifest.json"));
    const noManifest = await ctx.app.request(`/api/projects/${jobId}/shots/shot-1/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "asset" })
    });
    assert.equal(noManifest.status, 404, "缺 manifest → 404");
  } finally {
    ctx.cleanup();
  }
});

test("GET cost-preview 汇总远端能力与计费镜头数", async () => {
  // 造已完成任务时不能带远端提供者（否则 auto 模式的计费闸会把它停在 cost），
  // 而预览接口在请求时按 providersFor 现算，所以造完任务再切换即可。
  let providers: ProviderSelection = {};
  const providersFor = (): ProviderSelection => providers;
  const ctx = makeTestApp({ providersFor });
  try {
    const jobId = await createDoneJob(ctx);
    providers = {
      image: { id: "local-image", isRemote: false },
      video: { id: "ark-video", isRemote: true }
    } as unknown as ProviderSelection;
    const dir = join(ctx.projectsRoot, jobId);
    putJson(dir, "storyboard.json", {
      shots: [
        { id: "shot-1", narration: "a", durationSeconds: 3 },
        { id: "shot-2", narration: "b", durationSeconds: 4 }
      ]
    });
    putJson(dir, "render-manifest.json", { shots: [{ shotId: "shot-1" }, { shotId: "shot-2" }] });
    putJson(dir, "brief.json", { theme: "t" });

    const res = await ctx.app.request(`/api/projects/${jobId}/cost-preview`);
    assert.equal(res.status, 200);
    const { preview } = (await res.json()) as {
      preview: { items: Array<{ capability: string; remote: boolean }>; anyRemote: boolean; billableShots: number };
    };
    assert.deepEqual(
      preview.items,
      [
        { capability: "image", id: "local-image", remote: false },
        { capability: "video", id: "ark-video", remote: true }
      ]
    );
    assert.equal(preview.anyRemote, true);
    assert.equal(preview.billableShots, 2);

    rmSync(join(dir, "storyboard.json"));
    const empty = (await (await ctx.app.request(`/api/projects/${jobId}/cost-preview`)).json()) as {
      preview: { billableShots: number };
    };
    assert.equal(empty.preview.billableShots, 0, "分镜缺失按 0 计");
  } finally {
    ctx.cleanup();
  }
});

test("POST rerender：done 重排渲染、running 拒绝、未知 404", async () => {
  const ctx = makeTestApp();
  const hung = makeTestApp({ stages: hangScriptStages });
  try {
    const jobId = await createDoneJob(ctx);
    assert.equal((await ctx.app.request(`/api/projects/${jobId}/rerender`, { method: "POST" })).status, 200);
    await waitUntil(() => ctx.runner.get(jobId)?.phase === "done", "重渲完成");
    assert.equal((await ctx.app.request("/api/projects/ghost-1/rerender", { method: "POST" })).status, 404);

    const res = await hung.app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ briefText: "主题：占用" })
    });
    const { job } = (await res.json()) as { job: { id: string } };
    await waitUntil(() => hung.runner.get(job.id)?.phase === "running", "running");
    assert.equal((await hung.app.request(`/api/projects/${job.id}/rerender`, { method: "POST" })).status, 409);
    await hung.app.request(`/api/projects/${job.id}/cancel`, { method: "POST" });
    await waitUntil(() => hung.runner.get(job.id)?.phase === "cancelled", "cancelled");
  } finally {
    ctx.cleanup();
    hung.cleanup();
  }
});

test("PUT shots/order：重排落盘并标 stale，非重排/非法 id/运行中各自拒绝", async () => {
  const ctx = makeTestApp();
  try {
    const jobId = await createDoneJob(ctx);
    const dir = join(ctx.projectsRoot, jobId);
    writeTwoShotFixtures(dir);

    const ok = await ctx.app.request(`/api/projects/${jobId}/shots/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shotIds: ["shot-2", "shot-1"] })
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { ok: boolean; order: string[]; videoStale: boolean; job: { result?: { videoStale?: boolean } } };
    assert.deepEqual(body.order, ["shot-2", "shot-1"]);
    assert.equal(body.videoStale, true);
    assert.equal(body.job.result?.videoStale, true);
    const storyboard = JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")) as {
      shots: Array<{ id: string }>;
    };
    assert.deepEqual(storyboard.shots.map((shot) => shot.id), ["shot-2", "shot-1"]);

    const dup = await ctx.app.request(`/api/projects/${jobId}/shots/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shotIds: ["shot-1", "shot-1"] })
    });
    assert.equal(dup.status, 400, "重复 id 非重排");
    const evil = await ctx.app.request(`/api/projects/${jobId}/shots/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shotIds: ["../x", "shot-2"] })
    });
    assert.equal(evil.status, 404, "非法 shotId");
    const missing = await ctx.app.request(`/api/projects/${jobId}/shots/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shotIds: ["shot-1"] })
    });
    assert.equal(missing.status, 400, "缺项非重排");
    assert.equal(
      (
        await ctx.app.request(`/api/projects/${jobId}/shots/order`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
      ).status,
      400,
      "shotIds 必须是数组"
    );
    assert.equal(
      (
        await ctx.app.request(`/api/projects/ghost-7/shots/order`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shotIds: ["shot-1"] })
        })
      ).status,
      404,
      "未知任务 404"
    );
  } finally {
    ctx.cleanup();
  }
});

test("PUT shots/order：running 拒绝 409", async () => {
  const hung = makeTestApp({ stages: hangScriptStages });
  try {
    const res = await hung.app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ briefText: "主题：占用排序" })
    });
    const { job } = (await res.json()) as { job: { id: string } };
    await waitUntil(() => hung.runner.get(job.id)?.phase === "running", "running");
    assert.equal(
      (
        await hung.app.request(`/api/projects/${job.id}/shots/order`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shotIds: ["shot-1"] })
        })
      ).status,
      409
    );
    await hung.app.request(`/api/projects/${job.id}/cancel`, { method: "POST" });
    await waitUntil(() => hung.runner.get(job.id)?.phase === "cancelled", "cancelled");
  } finally {
    hung.cleanup();
  }
});

test("POST shots/retry-batch：缺省只重排失败镜头、显式指定清产物、闸门与坏输入拒绝", async () => {
  const ctx = makeTestApp();
  try {
    const jobId = await createDoneJob(ctx);
    const dir = join(ctx.projectsRoot, jobId);
    writeTwoShotFixtures(dir);

    const def = await ctx.app.request(`/api/projects/${jobId}/shots/retry-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(def.status, 200);
    const defBody = (await def.json()) as { retried: number; deleted: string[] };
    assert.equal(defBody.retried, 1, "缺省命中产物全空的 shot-2");
    assert.deepEqual(defBody.deleted, []);
    await waitUntil(() => ctx.runner.get(jobId)?.phase === "done", "缺省批重试跑完");

    const explicit = await ctx.app.request(`/api/projects/${jobId}/shots/retry-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shotIds: ["shot-1"] })
    });
    assert.equal(explicit.status, 200);
    const explicitBody = (await explicit.json()) as { retried: number; deleted: string[] };
    assert.equal(explicitBody.retried, 1);
    assert.deepEqual(explicitBody.deleted, ["assets/shot-1.png"]);
    assert.equal(existsSync(join(dir, "assets", "shot-1.png")), false);
    await waitUntil(() => ctx.runner.get(jobId)?.phase === "done", "显式批重试跑完");

    // 补齐产物后缺省目标为空 → 不再重排
    writeFileSync(join(dir, "audio", "shot-2.wav"), "wav", "utf8");
    writeFileSync(join(dir, "assets", "shot-1.png"), "png", "utf8");
    const none = await ctx.app.request(`/api/projects/${jobId}/shots/retry-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(none.status, 200);
    assert.equal(((await none.json()) as { retried: number }).retried, 0);

    assert.equal(
      (
        await ctx.app.request(`/api/projects/${jobId}/shots/retry-batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shotIds: [] })
        })
      ).status,
      400,
      "空数组拒绝"
    );
    assert.equal(
      (
        await ctx.app.request(`/api/projects/${jobId}/shots/retry-batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shotIds: ["shot-9"] })
        })
      ).status,
      404,
      "未知镜头 404"
    );
    rmSync(join(dir, "render-manifest.json"));
    assert.equal(
      (await ctx.app.request(`/api/projects/${jobId}/shots/retry-batch`, { method: "POST", body: "{}" })).status,
      404,
      "缺 manifest → 404"
    );
  } finally {
    ctx.cleanup();
  }
});

test("POST shots/retry-batch：running 拒绝 409", async () => {
  const hung = makeTestApp({ stages: hangScriptStages });
  try {
    const res = await hung.app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ briefText: "主题：占用批重试" })
    });
    const { job } = (await res.json()) as { job: { id: string } };
    await waitUntil(() => hung.runner.get(job.id)?.phase === "running", "running");
    assert.equal(
      (await hung.app.request(`/api/projects/${job.id}/shots/retry-batch`, { method: "POST", body: "{}" })).status,
      409
    );
    await hung.app.request(`/api/projects/${job.id}/cancel`, { method: "POST" });
    await waitUntil(() => hung.runner.get(job.id)?.phase === "cancelled", "cancelled");
  } finally {
    hung.cleanup();
  }
});

test("POST resume：failed 从断点续跑到 done，断点随之清除", async () => {
  const { stages, calls, control } = makeFlakyStages("assets");
  const ctx = makeTestApp({ stages });
  try {
    const jobId = await createJobId(ctx, "主题：断点续跑");
    await waitUntil(() => ctx.runner.get(jobId)?.phase === "failed", "failed");
    assert.equal(ctx.runner.get(jobId)?.breakStage, "assets");
    assert.deepEqual(calls, ["script", "assets"]);

    control.failAt = undefined;
    const res = await ctx.app.request(`/api/projects/${jobId}/resume`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()) as { ok: boolean }, { ok: true });
    await waitUntil(() => ctx.runner.get(jobId)?.phase === "done", "resumed done");

    const job = ctx.runner.get(jobId);
    assert.equal(job?.breakStage, undefined, "续跑完成即清除断点");
    assert.equal(job?.result?.videoStale, false, "跑完全链，成片不算过期");
    assert.deepEqual(calls, ["script", "assets", "assets", "audio", "render"], "已完成的脚本阶段不重做");
  } finally {
    ctx.cleanup();
  }
});

test("POST resume：cancelled 任务同样可续，起于取消时所在阶段", async () => {
  // 首次 script 挂起到 abort（造出「运行中被取消」），之后恢复正常，续跑才能走完。
  let firstRun = true;
  const calls: StageKind[] = [];
  const stages: StageRunner = {
    async runScript(ctx) {
      calls.push("script");
      if (!firstRun) {
        return;
      }
      firstRun = false;
      await new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
    async runAssets() {
      calls.push("assets");
    },
    async runAudio() {
      calls.push("audio");
    },
    async runRender() {
      calls.push("render");
    }
  };
  const ctx = makeTestApp({ stages });
  try {
    const jobId = await createJobId(ctx, "主题：取消后续跑");
    await waitUntil(() => ctx.runner.get(jobId)?.phase === "running", "running");
    assert.equal((await ctx.app.request(`/api/projects/${jobId}/cancel`, { method: "POST" })).status, 200);
    await waitUntil(() => ctx.runner.get(jobId)?.phase === "cancelled", "cancelled");
    assert.equal(ctx.runner.get(jobId)?.breakStage, "script");

    const res = await ctx.app.request(`/api/projects/${jobId}/resume`, { method: "POST" });
    assert.equal(res.status, 200);
    await waitUntil(() => ctx.runner.get(jobId)?.phase === "done", "resumed done");
    assert.deepEqual(calls, ["script", "script", "assets", "audio", "render"], "从断点 script 重跑并走完后续阶段");
  } finally {
    ctx.cleanup();
  }
});

test("POST resume：未知 404、done 与 running 各 409", async () => {
  const ctx = makeTestApp();
  const hung = makeTestApp({ stages: hangScriptStages });
  try {
    assert.equal((await ctx.app.request("/api/projects/ghost-2/resume", { method: "POST" })).status, 404);
    const doneId = await createDoneJob(ctx);
    assert.equal((await ctx.app.request(`/api/projects/${doneId}/resume`, { method: "POST" })).status, 409);

    const runningId = await createJobId(hung, "主题：占用续跑");
    await waitUntil(() => hung.runner.get(runningId)?.phase === "running", "running");
    const res = await hung.app.request(`/api/projects/${runningId}/resume`, { method: "POST" });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /编辑与重试需等待当前阶段结束/);

    await hung.app.request(`/api/projects/${runningId}/cancel`, { method: "POST" });
    await waitUntil(() => hung.runner.get(runningId)?.phase === "cancelled", "cancelled");
  } finally {
    ctx.cleanup();
    hung.cleanup();
  }
});
