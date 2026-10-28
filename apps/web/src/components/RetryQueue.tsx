/**
 * @file RetryQueue.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 「重试全部失败镜头」按钮：files 全空的镜头数大于 0 时出现；一次调用批量重试端点（POST /:id/shots/retry-batch）清理全部失败镜头产物并单次重排素材阶段——该阶段跑完即收尾，成片会标为过期、由用户自己决定何时重新渲染（服务端 busy 时 409，如实提示等待）。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { api } from "../api";
import { describeCapabilities } from "../cost";
import { useCostGate } from "../hooks/useCostGate";
import { useToast } from "../hooks/useToasts";

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
  // 计费闸：批量重试会重新调用图/视频提供者，有远端能力时先让人看一眼账单。
  const costGate = useCostGate(jobId);

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

  const run = (): void => {
    costGate.ask({
      capabilities: ["image", "video"],
      title: "重试失败镜头",
      message: (remote, preview) =>
        `本次将为 ${failedShotIds.length} 个镜头补齐画面，调用远端能力：${describeCapabilities(remote)}。` +
        (preview.billableShots > 0 ? `项目共 ${preview.billableShots} 镜，已有画面的镜头会按输入指纹跳过。` : "") +
        "确认继续？",
      run: submit
    });
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
        onClick={run}
      >
        <RotateCcw size={14} aria-hidden="true" />
        {running ? "排队中…" : `重试失败镜头 (${failedShotIds.length})`}
      </button>
      {costGate.dialog}
    </>
  );
}
