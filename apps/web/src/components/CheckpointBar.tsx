/**
 * @file CheckpointBar.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 检查点操作条：guided 模式等待确认时展示当前检查点说明与「继续 / 重做本阶段 / 放弃」三个决策入口。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useState } from "react";
import type { JobDto } from "@aivideo/shared";
import { api } from "../api";
import { CHECKPOINT_LABELS, STAGE_LABELS, checkpointToStage } from "../labels";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染检查点决策按钮；操作后回调让上层刷新任务与工件。
 */
export default function CheckpointBar({ job, onChanged }: { job: JobDto; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (job.phase !== "awaiting" || !job.checkpoint) {
    return null;
  }
  const checkpoint = job.checkpoint;
  const decide = (decision: "approve" | "cancel" | "redo-stage"): void => {
    setBusy(true);
    setError(null);
    api
      .review(job.id, { decision, stage: decision === "redo-stage" ? checkpointToStage(checkpoint) : undefined })
      .then(onChanged)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="checkpoint-hint">
      <div>
        <b>等待确认：{CHECKPOINT_LABELS[checkpoint]}</b>
        <span className="muted">
          {" "}
          —— 审阅下方产物后继续；「重做{STAGE_LABELS[checkpointToStage(checkpoint)]}阶段」会重新执行该阶段。
        </span>
      </div>
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => decide("approve")}>
          继续
        </button>
        <button disabled={busy} onClick={() => decide("redo-stage")}>
          重做{STAGE_LABELS[checkpointToStage(checkpoint)]}阶段
        </button>
        <button className="danger" disabled={busy} onClick={() => decide("cancel")}>
          放弃任务
        </button>
        {error && <span className="error-line">{error}</span>}
      </div>
    </div>
  );
}
