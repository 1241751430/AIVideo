/**
 * @file cost-preview.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 计费预览：从已装配提供者与落盘分镜生成「哪些能力会调用远端计费接口、预计多少个镜头」的确认数据，与 CLI 向导计费页同一判定口径（isRemote）。
 * @see https://github.com/1241751430/AIVideo.git
 */
import type { ProviderSelection } from "@aivideo/core";
import { loadAssetArtifacts } from "@aivideo/core";
import type { CostPreview, CostPreviewItem } from "@aivideo/shared";

export type { CostPreview, CostPreviewItem };

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：汇总四类提供者的远端/本地属性与分镜镜头数，生成计费预览；分镜未生成时 billableShots 为 0。
 * @param projectDir 项目目录
 * @param providers 当前 profile 装配的提供者集合
 */
export function buildCostPreview(projectDir: string, providers: ProviderSelection): CostPreview {
  const entries = [
    ["text", providers.text],
    ["image", providers.image],
    ["video", providers.video],
    ["speech", providers.speech]
  ] as const;
  const items: CostPreviewItem[] = [];
  for (const [capability, provider] of entries) {
    if (provider) {
      items.push({ capability, id: provider.id, remote: provider.isRemote === true });
    }
  }
  let billableShots = 0;
  try {
    billableShots = loadAssetArtifacts(projectDir)?.storyboard.shots.length ?? 0;
  } catch {
    billableShots = 0;
  }
  return { items, anyRemote: items.some((item) => item.remote), billableShots };
}
