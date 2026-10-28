/**
 * @file useCostGate.tsx
 * @author zhangbaohong
 * @date 2026-10-28
 * @description 计费前的确认闸：重试/重渲这类会调用远端提供者的动作，先取 /cost-preview 看本次真正会用到的能力，
 * 有远端能力就弹一次成本确认，全本地则静默放行——「不再重复扣费」由指纹保证，「这次要扣多少」由这里让人看见。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { CostPreview, CostPreviewItem } from "@aivideo/shared";
import { api } from "../api";
import { remoteCapabilities } from "../cost";
import ConfirmDialog from "../components/ConfirmDialog";

/** 一次待确认动作的描述。 */
export interface CostGateAsk {
  /** 本次动作会调用到的能力（只算真的会跑的阶段，避免把无关接口算进账单）。 */
  capabilities: CostPreviewItem["capability"][];
  title: string;
  /** 拼确认正文：仅在命中远端能力时调用，所以 remote 非空。 */
  message: (remote: CostPreviewItem[], preview: CostPreview) => string;
  /** 确认后（或无需确认时）真正执行的动作。 */
  run: () => void;
}

/** 待确认的弹窗内容。 */
interface Pending {
  title: string;
  message: string;
  run: () => void;
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：为某个任务提供「先看账单再动手」的闸门：返回 ask()（判断是否需要确认）与 dialog（需渲染的确认框）。
 * 预览失败不静默放行——拿不到账单时也要人点一次，避免在服务异常时悄悄发起付费调用。
 */
export function useCostGate(jobId: string): { ask: (req: CostGateAsk) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback(
    (req: CostGateAsk): void => {
      api
        .costPreview(jobId)
        .then(({ preview }) => {
          const remote = remoteCapabilities(preview, req.capabilities);
          if (remote.length === 0) {
            req.run();
            return;
          }
          setPending({ title: req.title, message: req.message(remote, preview), run: req.run });
        })
        .catch((err: Error) => {
          setPending({
            title: req.title,
            message: `无法获取计费预览（${err.message}）。该动作可能调用远端付费接口，确认继续？`,
            run: req.run
          });
        });
    },
    [jobId]
  );

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.title ?? "确认计费"}
      message={pending?.message}
      confirmLabel="确认继续"
      danger={false}
      onConfirm={() => {
        const next = pending;
        setPending(null);
        next?.run();
      }}
      onCancel={() => setPending(null)}
    />
  );

  return { ask, dialog };
}