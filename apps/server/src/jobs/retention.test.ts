/**
 * @file retention.test.ts
 * @author zhangbaohong
 * @date 2026-10-28
 * @description 过期项目清理策略的测试：任务引擎持有的项目（排队/执行/等人工）不被删除，空闲目录照常清理，删掉的项目同步从内存台账移除。
 * @see https://github.com/1241751430/AIVideo.git
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobRunner } from "./job-runner.js";
import { isHeldByEngine, sweepExpiredProjects } from "./retention.js";
import { makeConfig, makeRequest, noopStages, waitUntil } from "../testkit.js";

/** 十天前：超过任何测试里使用的保留天数。 */
function tenDaysAgo(): Date {
  return new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：装配临时项目根上的真实 JobRunner（假阶段，不碰 ffmpeg 与远端）。
 */
function makeRunner(): { runner: JobRunner; projectsRoot: string; cleanup: () => void } {
  const projectsRoot = mkdtempSync(join(tmpdir(), "aivideo-retention-"));
  const runner = new JobRunner({
    cwd: projectsRoot,
    projectsRoot,
    config: makeConfig(),
    providers: {},
    stages: noopStages
  });
  return { runner, projectsRoot, cleanup: () => rmSync(projectsRoot, { recursive: true, force: true }) };
}

test("停在检查点等人工的任务不会被清理", async () => {
  const { runner, projectsRoot, cleanup } = makeRunner();
  try {
    // guided 模式在脚本后停在 awaiting：这时它既不排队也不在执行，只靠 isBusy 会漏判。
    const job = runner.create({ execMode: "guided", request: makeRequest("等待确认") });
    await waitUntil(() => runner.get(job.id)?.phase === "awaiting", "awaiting");
    assert.equal(isHeldByEngine(runner, job.id), true);

    const idle = join(projectsRoot, "idle-project");
    mkdirSync(idle);
    const old = tenDaysAgo();
    utimesSync(runner.projectDirOf(job.id), old, old);
    utimesSync(idle, old, old);

    const removed = sweepExpiredProjects(runner, projectsRoot, 7);
    assert.deepEqual(removed, [idle], "只清理空闲目录");
    assert.equal(existsSync(runner.projectDirOf(job.id)), true, "等待中的项目仍在盘上");
    assert.equal(runner.get(job.id)?.phase, "awaiting", "内存状态原样保留");
  } finally {
    cleanup();
  }
});

test("清理掉的任务同时从内存台账移除", async () => {
  const { runner, projectsRoot, cleanup } = makeRunner();
  try {
    // auto 且无远端提供者：一次跑完到 done，之后不再有写盘，可以放心把 mtime 推到过期。
    const job = runner.create({ execMode: "auto", request: makeRequest("已完成") });
    await waitUntil(() => runner.get(job.id)?.phase === "done", "done");
    assert.equal(isHeldByEngine(runner, job.id), false, "done 不再被引擎持有");

    const old = tenDaysAgo();
    utimesSync(runner.projectDirOf(job.id), old, old);

    const removed = sweepExpiredProjects(runner, projectsRoot, 7);
    assert.deepEqual(removed, [runner.projectDirOf(job.id)]);
    assert.equal(existsSync(runner.projectDirOf(job.id)), false, "目录已删除");
    assert.equal(runner.get(job.id), undefined, "列表不应再出现一个磁盘上不存在的任务");
  } finally {
    cleanup();
  }
});