/**
 * @file cost.ts
 * @author zhangbaohong
 * @date 2026-10-28
 * @description 重试/重跑前的计费摘要工具：从 /cost-preview 里挑出「本次动作真的会调用到的远端能力」，拼成确认框可用的纯文本；没有命中远端能力时调用方直接放行，不额外加一次点击。
 * @see https://github.com/1241751430/AIVideo.git
 */
import type { CostPreview, CostPreviewItem } from "@aivideo/shared";

/** 计费能力的中文名（确认框文案用）。 */
const CAPABILITY_LABELS: Record<CostPreviewItem["capability"], string> = {
  text: "文本",
  image: "图像",
  video: "视频",
  speech: "语音"
};

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：筛出本次动作涉及且标为远端的计费能力。
 * 只按动作真正会跑的阶段取能力（补齐画面只看图像/视频、重配音只看语音），
 * 否则会把不会调用的文本接口也算进账单，让确认框变成误报。
 * @param preview 服务端计费预览
 * @param capabilities 本次动作可能调用到的能力
 * @returns 命中的远端能力；为空表示全本地，调用方无需确认
 */
export function remoteCapabilities(
  preview: CostPreview,
  capabilities: CostPreviewItem["capability"][]
): CostPreviewItem[] {
  return preview.items.filter((item) => item.remote && capabilities.includes(item.capability));
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：把远端能力拼成「视频（ark-video）、语音（edge-tts）」，供确认框 message（仅接受纯字符串）。
 */
export function describeCapabilities(items: CostPreviewItem[]): string {
  return items.map((item) => `${CAPABILITY_LABELS[item.capability]}（${item.id}）`).join("、");
}