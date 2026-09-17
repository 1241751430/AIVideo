/**
 * @file job-store.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description job.json 存储测试：原子读写往返、projectId 不符/解析失败判 null、scanProjects 合并损坏标记、removeProject 删除与非法 id 拒绝。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "../types.js";
import { JOB_FILE, jobFilePath, readJob, removeProject, scanProjects, writeJob } from "./job-store.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：构造最小合法 Job 实体。
 */
function makeJob(projectId: string, overrides: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    id: projectId,
    projectId,
    createdAt: now,
    updatedAt: now,
    execMode: "auto",
    phase: "queued",
    request: {
      theme: "t",
      generationMode: "video",
      skill: "auto",
      aspectRatio: "9:16",
      durationSeconds: 30,
      language: "zh-CN",
      platform: "douyin"
    },
    ...overrides
  };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：建临时 projectsRoot 并在测试尾清理。
 */
function tempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "aivideo-store-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("writeJob 原子落盘并可被 readJob 读回", () => {
  const { root, cleanup } = tempRoot();
  try {
    const job = makeJob("alpha", { phase: "running", stage: "assets" });
    writeJob(root, job);
    assert.equal(existsSync(join(root, "alpha", JOB_FILE)), true);
    assert.equal(existsSync(`${join(root, "alpha", JOB_FILE)}.tmp`), false, "临时文件应被 rename 消耗");
    const loaded = readJob(root, "alpha");
    assert.equal(loaded?.phase, "running");
    assert.equal(loaded?.stage, "assets");
  } finally {
    cleanup();
  }
});

test("readJob 对缺失/损坏/projectId 不符返回 null", () => {
  const { root, cleanup } = tempRoot();
  try {
    assert.equal(readJob(root, "missing"), null);

    mkdirSync(join(root, "broken"), { recursive: true });
    writeFileSync(join(root, "broken", JOB_FILE), "{ not json", "utf8");
    assert.equal(readJob(root, "broken"), null);

    mkdirSync(join(root, "mismatch"), { recursive: true });
    writeFileSync(join(root, "mismatch", JOB_FILE), JSON.stringify(makeJob("other")), "utf8");
    assert.equal(readJob(root, "mismatch"), null);
  } finally {
    cleanup();
  }
});

test("scanProjects 合并任务与无任务目录并标记损坏", () => {
  const { root, cleanup } = tempRoot();
  try {
    writeJob(root, makeJob("zeta", { phase: "done" }));
    mkdirSync(join(root, "legacy"), { recursive: true });
    writeFileSync(join(root, "legacy", "brief.json"), "{}", "utf8");
    mkdirSync(join(root, "bad"), { recursive: true });
    writeFileSync(join(root, "bad", JOB_FILE), "[]", "utf8");
    writeFileSync(join(root, "not-a-dir.txt"), "x", "utf8");

    const entries = scanProjects(root);
    assert.deepEqual(entries.map((entry) => entry.projectId), ["bad", "legacy", "zeta"]);
    const bad = entries.find((entry) => entry.projectId === "bad");
    assert.equal(bad?.corrupt, true);
    assert.equal(bad?.job, null);
    const legacy = entries.find((entry) => entry.projectId === "legacy");
    assert.equal(legacy?.corrupt, false);
    assert.equal(legacy?.hasProjectDir, true);
    const zeta = entries.find((entry) => entry.projectId === "zeta");
    assert.equal(zeta?.job?.phase, "done");
  } finally {
    cleanup();
  }
});

test("removeProject 删除目录；非法 id 拒绝", () => {
  const { root, cleanup } = tempRoot();
  try {
    writeJob(root, makeJob("doomed"));
    removeProject(root, "doomed");
    assert.equal(existsSync(join(root, "doomed")), false);
    assert.throws(() => removeProject(root, "../escape"), /Invalid project id/);
    assert.throws(() => jobFilePath(root, "a/b"), /Invalid project id/);
  } finally {
    cleanup();
  }
});
