/**
 * @file labels.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description UI 展示层共享映射：阶段/检查点/状态的中文文案、徽标配色，以及检查点回退到流水线阶段与 stepper 位置的换算。
 * @see https://github.com/1241751430/AIVideo.git
 */
import type { CheckpointKind, JobPhase, StageKind } from "@aivideo/shared";

/** 流水线四阶段的中文名。 */
export const STAGES: StageKind[] = ["script", "assets", "audio", "render"];

/** 阶段中文标签。 */
export const STAGE_LABELS: Record<StageKind, string> = {
  script: "脚本",
  assets: "素材",
  audio: "旁白",
  render: "渲染"
};

/** 检查点中文标签。 */
export const CHECKPOINT_LABELS: Record<CheckpointKind, string> = {
  script: "脚本评审",
  cost: "计费确认",
  shots: "镜头墙审阅",
  audio: "旁白试听",
  final: "成片验收"
};

/** 状态机宏阶段中文标签。 */
export const PHASE_LABELS: Record<JobPhase, string> = {
  queued: "排队中",
  running: "执行中",
  awaiting: "等待确认",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把检查点映射到「重做该阶段」应回退的流水线阶段（cost 检查点重做脚本）。
 */
export function checkpointToStage(checkpoint: CheckpointKind): StageKind {
  switch (checkpoint) {
    case "script":
    case "cost":
      return "script";
    case "shots":
      return "assets";
    case "audio":
      return "audio";
    case "final":
      return "render";
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：计算 stepper 高亮位（0..4，4 表示全部完成）；queued/未知返回 -1。
 */
export function stepperIndex(phase: JobPhase, stage?: StageKind, checkpoint?: CheckpointKind): number {
  if (phase === "done") {
    return 4;
  }
  if (phase === "running" && stage) {
    return STAGES.indexOf(stage);
  }
  if (phase === "awaiting" && checkpoint) {
    const doneStages: Record<CheckpointKind, number> = { script: 1, cost: 1, shots: 2, audio: 3, final: 4 };
    return doneStages[checkpoint];
  }
  if (phase === "failed" && stage) {
    return STAGES.indexOf(stage);
  }
  return -1;
}
