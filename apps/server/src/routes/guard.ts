/**
 * @file guard.ts
 * @author zhangbaohong
 * @date 2026-10-30
 * @description 路由守卫的公共部分：凡是「要改动项目磁盘上的产物」的入口（编辑、重试、重渲、续跑、换 BGM）
 * 都必须先过同一道闸——任务存在、不在 queued/running、项目目录还在。
 * 抽在这里而不是各路由自己写一遍，是因为这条判据一旦两边走偏，就会出现「BGM 能换、编辑却报忙」这类鬼故事。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { existsSync } from "node:fs";
import type { ServerDeps } from "../app.js";
import type { Job } from "../types.js";

/** 路由守卫结果：要么拿到任务实体与项目目录，要么已给出状态码响应。 */
export type Guarded = { ok: true; job: Job; projectDir: string } | { ok: false; status: 404 | 409; error: string };

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：改动类路由的并发闸门：任务必须存在且不在 queued/running（避免与阶段执行争写同一产物文件）。
 * @param deps 服务依赖
 * @param jobId 任务 id
 * @returns 通过时带回任务与项目目录，否则带回建议状态码与错误文案
 */
export function guardEditable(deps: ServerDeps, jobId: string): Guarded {
  const job = deps.runner.get(jobId);
  if (!job) {
    return { ok: false, status: 404, error: "Unknown project" };
  }
  if (job.phase === "queued" || job.phase === "running") {
    return { ok: false, status: 409, error: "任务执行中，编辑与重试需等待当前阶段结束" };
  }
  const projectDir = deps.runner.projectDirOf(job.projectId);
  if (!existsSync(projectDir)) {
    return { ok: false, status: 404, error: "Project directory not found" };
  }
  return { ok: true, job, projectDir };
}