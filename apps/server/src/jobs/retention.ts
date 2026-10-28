/**
 * @file retention.ts
 * @author zhangbaohong
 * @date 2026-10-28
 * @description 过期项目清理的服务端策略：把 core 的 cleanupExpiredProjects 接到任务引擎上——仍在排队/执行/等人工的项目一律不删，删掉的项目同时从内存台账里移除。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { basename } from "node:path";
import { cleanupExpiredProjects } from "@aivideo/core";
import type { JobPhase } from "../types.js";
import type { JobRunner } from "./job-runner.js";

/** 两次清理之间的间隔：本项目单机自用，一天扫四次的粒度已经足够，不必引入定时任务依赖。 */
export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 这三种状态代表「任务引擎还握着这个项目」，即使目录 mtime 已过期也不能删。 */
const HELD_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>(["queued", "running", "awaiting"]);

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：判断某项目是否被任务引擎持有（排队/执行中，或停在检查点等人工决策）。
 * awaiting 既不在队列里也不是 active，只看 queue/active 会把它误判成可删——用户的检查点会连同 job.json 一起消失。
 * @param runner 任务引擎
 * @param projectId 项目 id
 * @returns 是否应跳过删除
 */
export function isHeldByEngine(runner: JobRunner, projectId: string): boolean {
  if (runner.isBusy(projectId)) {
    return true;
  }
  const job = runner.get(projectId);
  return job ? HELD_PHASES.has(job.phase) : false;
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：按保留天数清理过期项目目录，返回被删除的绝对路径；被引擎持有的项目跳过，已删除的项目从内存台账移除，
 * 否则列表接口还会继续展示一个磁盘上已不存在的任务。
 * @param runner 任务引擎（skip 否决权与删除后 forget 都要经过它）
 * @param projectsRoot 项目根目录
 * @param retentionDays 保留天数（正整数；调用方负责只在开启时调用）
 * @returns 被删除的项目目录绝对路径
 */
export function sweepExpiredProjects(runner: JobRunner, projectsRoot: string, retentionDays: number): string[] {
  const removed = cleanupExpiredProjects(projectsRoot, retentionDays, {
    skip: (_dir, projectId) => isHeldByEngine(runner, projectId)
  });
  for (const dir of removed) {
    runner.forget(basename(dir));
  }
  return removed;
}