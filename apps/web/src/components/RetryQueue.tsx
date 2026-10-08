/**
 * @file RetryQueue.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 「重试全部失败镜头」按钮：files 全空的镜头数大于 0 时出现；对首个失败镜头发起素材重试——素材阶段续跑会自动补齐全部缺失画面并续走配音/渲染，故一次调用即覆盖全部失败镜头（服务端 busy 时 409，如实提示等待）。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { api } from "../api";
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
  if (failedShotIds.length === 0) {
    return null;
  }
  const run = (): void => {
    const first = failedShotIds[0];
    if (!first) {
      return;
    }
    setRunning(true);
    api
      .retryShot(jobId, first, "asset")
      .then(() => {
        toast.success(
          `已重排素材阶段：${failedShotIds.length} 个失败镜头的缺失画面将补齐，并续走配音与渲染`
        );
        onChanged();
      })
      .catch((err: Error) => toast.error(`重试失败：${err.message}`))
      .finally(() => setRunning(false));
  };
  return (
    <button
      className="retry-all"
      disabled={busy || running}
      title="素材阶段会自动跳过已有画面的镜头、重做全部缺失者"
      onClick={run}
    >
      <RotateCcw size={14} aria-hidden="true" />
      {running ? "排队中…" : `重试失败镜头 (${failedShotIds.length})`}
    </button>
  );
}
