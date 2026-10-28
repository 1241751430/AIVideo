/**
 * @file transitions.ts
 * @author zhangbaohong
 * @date 2026-10-28
 * @description 任务状态机的纯转移规则：阶段名收窄、阶段完成后的下一跳、取消/失败时的断点阶段。
 * 三者都只读 Job 字段、不碰 runner 的队列与落盘，抽出来后既能单测也能被路由复用。
 * @see https://github.com/1241751430/AIVideo.git
 */
import type { CheckpointKind, Job, StageKind } from "../types.js";

/** 阶段完成后的下一跳：进入下一阶段、停在检查点、或收尾。 */
export type StageTransition =
  | { kind: "stage"; stage: StageKind }
  | { kind: "await"; checkpoint: CheckpointKind }
  | { kind: "done" };

/** 流水线阶段的运行时清单，顺序即执行顺序。 */
const STAGE_KINDS: readonly StageKind[] = ["script", "assets", "audio", "render"];

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：把来自 HTTP 请求/磁盘 JSON 的未知值收窄成 StageKind；配合类型守卫使用后，调用方不必再写 `as never`。
 * @param value 待判断的值
 * @returns 是否为合法阶段名
 */
export function isStageKind(value: unknown): value is StageKind {
  return typeof value === "string" && (STAGE_KINDS as readonly string[]).includes(value);
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：阶段完成后的转移：auto 依次 script→assets→audio→render→done；guided 每阶段后进入对应检查点。
 * @param job 任务实体（读 execMode 与 request.generationMode）
 * @param stage 刚完成的阶段
 * @returns 下一跳描述
 */
export function nextAfterStage(job: Job, stage: StageKind): StageTransition {
  // "script" 产物模式只要脚本与分镜：脚本阶段后直接收尾，不进入素材/旁白/渲染。
  if (job.request.generationMode === "script") {
    if (job.execMode === "guided" && stage === "script") {
      return { kind: "await", checkpoint: "script" };
    }
    return { kind: "done" };
  }
  if (job.execMode === "auto") {
    switch (stage) {
      case "script":
        return { kind: "stage", stage: "assets" };
      case "assets":
        return { kind: "stage", stage: "audio" };
      case "audio":
        return { kind: "stage", stage: "render" };
      case "render":
        return { kind: "done" };
    }
    return { kind: "done" };
  }
  switch (stage) {
    case "script":
      return { kind: "await", checkpoint: "script" };
    case "assets":
      return { kind: "await", checkpoint: "shots" };
    case "audio":
      return { kind: "await", checkpoint: "audio" };
    case "render":
      return { kind: "await", checkpoint: "final" };
  }
  return { kind: "done" };
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：推算取消时的断点阶段——「继续」该从哪一段接上。
 * 运行中取当前阶段；排队中取入队时声明的起点；等待中取通向该检查点的那一段：
 * 续跑靠输入指纹跳过已完成的阶段，随后按原模式重新停回同一检查点（script 回到脚本闸，
 * 即重新确认一次脚本——成片链路里没有从检查点直接跳过的旁路，宁可多点一次也不跳过人工确认）。
 * @param job 取消前的任务快照（phase/stage/checkpoint/resumeStage 决定结果）
 * @returns 断点阶段；无法判定时 undefined
 */
export function breakStageOf(job: Job): StageKind | undefined {
  if (job.phase === "running") {
    return job.stage;
  }
  if (job.phase === "awaiting") {
    switch (job.checkpoint) {
      case "script":
        return "script";
      case "shots":
        return "assets";
      case "audio":
        return "audio";
      case "final":
        return "render";
      default:
        return undefined;
    }
  }
  return job.resumeStage ?? "script";
}