/**
 * @file RetryQueue.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 「重试全部失败镜头」按钮：files 全空的镜头数大于 0 时出现；点击先经确认框，确认后一次调用批量重试端点（POST /:id/shots/retry-batch）清理全部失败镜头产物并单次重排素材阶段——该阶段跑完即收尾，成片会标为过期、由用户自己决定何时重新渲染（服务端 busy 时 409，如实提示等待）。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { api } from "../api";
import { useToast } from "../hooks/useToasts";
import ConfirmDialog from "./ConfirmDialog";

/** RetryQueue 组件入参。 */
interface Props {
  jobId: string;
  /** files 全空（无任何画面/配音产物）的镜头 id 列表。 */
  failedShotIds: string[];
  busy: boolean;
  onChanged: () => void;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染批量重试按钮并封装单次「重排素材阶段」调用。
 */
export default function RetryQueue({ jobId, failedShotIds, busy, onChanged }: Props) {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const submit = (): void => {
    setRunning(true);
    api
      .retryBatch(jobId, failedShotIds)
      .then((res) => {
        toast.success(`已重排素材阶段：${res.retried} 个失败镜头将补齐缺失画面；成片需在交付面板手动重新渲染`);
        onChanged();
      })
      .catch((err: Error) => toast.error(`重试失败：${err.message}`))
      .finally(() => setRunning(false));
  };

  if (failedShotIds.length === 0) {
    return null;
  }
  return (
    <>
      <button
        className="retry-all"
        disabled={busy || running}
        title="素材阶段会自动跳过已有画面的镜头、重做全部缺失者"
        onClick={() => setConfirming(true)}
      >
        <RotateCcw size={14} aria-hidden="true" />
        {running ? "排队中…" : `重试失败镜头 (${failedShotIds.length})`}
      </button>
      <ConfirmDialog
        open={confirming}
        title="重试失败镜头"
        message={`确认重试 ${failedShotIds.length} 个失败镜头？缺失的产物会被清理，任务重新排队执行素材阶段（可能再次调用远端模型）；成片需之后在交付面板手动重新渲染。`}
        confirmLabel="重试"
        busy={busy || running}
        onConfirm={() => {
          setConfirming(false);
          submit();
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
