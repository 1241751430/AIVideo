/**
 * @file folder.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description open-folder 路由测试：非法项目 id 拒绝（400）、目录不存在（404）、容器环境（AIVIDEO_CONTAINER=1）降级返回宿主路径与提示，不拉起文件管理器。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OpenFolderResponse } from "@aivideo/shared";
import { createDoneJob, makeTestApp } from "../testkit.js";

test("open-folder：非法 id 400、未知项目 404", async () => {
  const ctx = makeTestApp();
  try {
    const invalid = await ctx.app.request("/api/projects/..%2Fevil/open-folder", { method: "POST" });
    assert.equal(invalid.status, 400);

    const unknown = await ctx.app.request("/api/projects/ghost-123/open-folder", { method: "POST" });
    assert.equal(unknown.status, 404);
  } finally {
    ctx.cleanup();
  }
});

test("open-folder：容器环境降级返回宿主路径与提示（不拉起文件管理器）", async () => {
  const ctx = makeTestApp();
  const saved = process.env.AIVIDEO_CONTAINER;
  process.env.AIVIDEO_CONTAINER = "1";
  try {
    const jobId = await createDoneJob(ctx);
    const res = await ctx.app.request(`/api/projects/${jobId}/open-folder`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as OpenFolderResponse;
    assert.equal(body.ok, false);
    assert.equal(body.path, join(ctx.projectsRoot, jobId));
    assert.ok(body.hint && body.hint.length > 0, "降级必须携带操作提示");

    mkdirSync(join(ctx.projectsRoot, "legacy-project-dir"), { recursive: true });
    const legacy = (await (await ctx.app.request("/api/projects/legacy-project-dir/open-folder", { method: "POST" })).json()) as OpenFolderResponse;
    assert.equal(legacy.ok, false, "无任务的旧项目目录同样可打开");
  } finally {
    if (saved === undefined) {
      delete process.env.AIVIDEO_CONTAINER;
    } else {
      process.env.AIVIDEO_CONTAINER = saved;
    }
    ctx.cleanup();
  }
});
