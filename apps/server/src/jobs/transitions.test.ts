/**
 * @file transitions.test.ts
 * @author zhangbaohong
 * @date 2026-10-28
 * @description 纯状态转移规则测试：isStageKind 的入参收窄、nextAfterStage 的 auto/guided/仅脚本三支、breakStageOf 在 running/awaiting/其余相位的断点推算。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckpointKind, ExecMode, Job, JobRequest, StageKind } from "../types.js";
import { breakStageOf, isStageKind, nextAfterStage } from "./transitions.js";

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：最小任务请求（只填转移规则会读的 generationMode）。
 * @param generationMode video 全链路 | script 仅脚本产物
 * @returns JobRequest
 */
function makeRequest(generationMode: JobRequest["generationMode"] = "video"): JobRequest {
  return {
    theme: "测试主题",
    generationMode,
    skill: "auto",
    aspectRatio: "9:16",
    durationSeconds: 30,
    language: "zh-CN",
    platform: "douyin"
  };
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：构造任务实体，只覆盖本次断言关心的字段。
 * @param patch 需要覆盖的字段
 * @returns Job
 */
function makeJob(patch: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    id: "p1",
    projectId: "p1",
    createdAt: now,
    updatedAt: now,
    execMode: "auto" as ExecMode,
    phase: "queued",
    request: makeRequest(),
    ...patch
  };
}

test("isStageKind：只接受四个真实阶段名，拒绝近似值与非字符串", () => {
  for (const stage of ["script", "assets", "audio", "render"]) {
    assert.equal(isStageKind(stage), true, `${stage} 应被接受`);
  }
  for (const bad of ["shots", "final", "SCRIPT", " script", "script ", "", undefined, null, 0, {}, ["script"]]) {
    assert.equal(isStageKind(bad), false, `${JSON.stringify(bad)} 应被拒绝`);
  }
});

test("nextAfterStage auto：script→assets→audio→render→done", () => {
  const job = makeJob({ execMode: "auto" });
  assert.deepEqual(nextAfterStage(job, "script"), { kind: "stage", stage: "assets" });
  assert.deepEqual(nextAfterStage(job, "assets"), { kind: "stage", stage: "audio" });
  assert.deepEqual(nextAfterStage(job, "audio"), { kind: "stage", stage: "render" });
  assert.deepEqual(nextAfterStage(job, "render"), { kind: "done" });
});

test("nextAfterStage guided：每阶段后停在同一名的检查点", () => {
  const job = makeJob({ execMode: "guided" });
  const expected: Array<[StageKind, CheckpointKind]> = [
    ["script", "script"],
    ["assets", "shots"],
    ["audio", "audio"],
    ["render", "final"]
  ];
  for (const [stage, checkpoint] of expected) {
    assert.deepEqual(nextAfterStage(job, stage), { kind: "await", checkpoint }, `${stage} 后应停在 ${checkpoint}`);
  }
});

test("nextAfterStage 仅脚本产物：auto 直接收尾，guided 在 script 检查点停一次后收尾", () => {
  const autoJob = makeJob({ execMode: "auto", request: makeRequest("script") });
  assert.deepEqual(nextAfterStage(autoJob, "script"), { kind: "done" });

  const guidedJob = makeJob({ execMode: "guided", request: makeRequest("script") });
  assert.deepEqual(nextAfterStage(guidedJob, "script"), { kind: "await", checkpoint: "script" });
  // 检查点通过后再驱动到的任何阶段都不该继续往下走：产物模式决定了只有脚本与分镜。
  assert.deepEqual(nextAfterStage(guidedJob, "assets"), { kind: "done" });
});

test("breakStageOf running：断点就是当前阶段", () => {
  for (const stage of ["script", "assets", "audio", "render"] as const) {
    assert.equal(breakStageOf(makeJob({ phase: "running", stage })), stage);
  }
});

test("breakStageOf awaiting：回到通向该检查点的那一段", () => {
  const expected: Array<[CheckpointKind, StageKind]> = [
    ["script", "script"],
    ["shots", "assets"],
    ["audio", "audio"],
    ["final", "render"]
  ];
  for (const [checkpoint, stage] of expected) {
    assert.equal(breakStageOf(makeJob({ phase: "awaiting", checkpoint })), stage, `${checkpoint} 应回到 ${stage}`);
  }
  // 落盘数据缺 checkpoint（例如老版本 job.json）时无法判定，返回 undefined 而不是编一个阶段。
  assert.equal(breakStageOf(makeJob({ phase: "awaiting" })), undefined);
});

test("breakStageOf 其余相位：取入队时声明的起点，缺省 script", () => {
  assert.equal(breakStageOf(makeJob({ phase: "queued", resumeStage: "audio" })), "audio");
  assert.equal(breakStageOf(makeJob({ phase: "queued" })), "script");
  assert.equal(breakStageOf(makeJob({ phase: "failed", resumeStage: "render" })), "render");
  assert.equal(breakStageOf(makeJob({ phase: "cancelled" })), "script");
});