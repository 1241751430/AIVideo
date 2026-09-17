/**
 * @file Stepper.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 流水线 stepper：脚本→素材→旁白→渲染四节点，按任务状态标出已完成/进行中/失败位置。
 * @see https://github.com/1241751430/AIVideo.git
 */
import type { JobDto } from "@aivideo/shared";
import { STAGES, STAGE_LABELS, stepperIndex } from "../labels";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染四阶段进度条。
 */
export default function Stepper({ job }: { job: JobDto }) {
  const current = stepperIndex(job.phase, job.stage, job.checkpoint);
  return (
    <div className="stepper">
      {STAGES.map((stage, index) => {
        const cls =
          index < current ? "done" : index === current ? (job.phase === "failed" ? "error" : "current") : "";
        return (
          <span key={stage} style={{ display: "contents" }}>
            {index > 0 && <span className="sep">→</span>}
            <span className={`node ${cls}`}>
              {index < current ? "✓" : ""} {STAGE_LABELS[stage]}
            </span>
          </span>
        );
      })}
    </div>
  );
}
