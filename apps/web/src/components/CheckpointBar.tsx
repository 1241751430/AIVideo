/**
 * @file CheckpointBar.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 检查点操作条：guided 模式等待确认时展示当前检查点说明与「继续 / 重做本阶段 / 放弃」决策入口；渐变描边卡样式，放弃动作经玻璃确认框兜底，操作反馈走 toast。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useState } from "react";
import { Check, RotateCcw, Ban } from "lucide-react";
import type { JobDto } from "@aivideo/shared";
import { api } from "../api";
import { useToast } from "../hooks/useToasts";
import ConfirmDialog from "./ConfirmDialog";
import { CHECKPOINT_LABELS, STAGE_LABELS, checkpointToStage } from "../labels";

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染检查点决策按钮；操作后回调让上层刷新任务与工件。
 */
export default function CheckpointBar({ job, onChanged }: { job: JobDto; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  if (job.phase !== "awaiting" || !job.checkpoint) {
    return null;
  }
  const checkpoint = job.checkpoint;
  const decide = (decision: "approve" | "cancel" | "redo-stage"): void => {
    setBusy(true);
    api
      .review(job.id, { decision, stage: decision === "redo-stage" ? checkpointToStage(checkpoint) : undefined })
      .then(() => {
        if (decision === "approve") {
          toast.success(`已确认${CHECKPOINT_LABELS[checkpoint]}，任务继续执行`);
        } else if (decision === "redo-stage") {
          toast.info(`正在重做${STAGE_LABELS[checkpointToStage(checkpoint)]}阶段`);
        } else {
          toast.info("任务已放弃");
        }
        onChanged();
      })
      .catch((err: Error) => toast.error(`操作失败：${err.message}`))
      .finally(() => setBusy(false));
  };
  return (
    <div className="checkpoint-hint">
      <div>
        <b>
          <Check size={14} className="h2-ico cp-ico" aria-hidden="true" />
          等待确认：{CHECKPOINT_LABELS[checkpoint]}
        </b>
        <span className="muted">
          {" "}
          —— 审阅下方产物后继续；「重做{STAGE_LABELS[checkpointToStage(checkpoint)]}阶段」会重新执行该阶段。
        </span>
      </div>
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => decide("approve")}>
          <Check size={14} aria-hidden="true" /> 继续
        </button>
        <button disabled={busy} onClick={() => decide("redo-stage")}>
          <RotateCcw size={14} aria-hidden="true" /> 重做{STAGE_LABELS[checkpointToStage(checkpoint)]}阶段
        </button>
        <button className="danger" disabled={busy} onClick={() => setConfirmAbandon(true)}>
          <Ban size={14} aria-hidden="true" /> 放弃任务
        </button>
      </div>
      <ConfirmDialog
        open={confirmAbandon}
        title="放弃任务"
        message={`确认放弃「${job.request.theme || job.projectId}」？已生成的产物会保留，但任务不再继续。`}
        confirmLabel="放弃任务"
        busy={busy}
        onConfirm={() => {
          setConfirmAbandon(false);
          decide("cancel");
        }}
        onCancel={() => setConfirmAbandon(false)}
      />
    </div>
  );
}
