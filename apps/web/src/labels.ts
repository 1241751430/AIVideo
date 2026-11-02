/**
 * @file labels.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description UI 展示层共享映射：阶段/检查点/状态的中文文案、素材来源类别与徽标配色、检查点回退到流水线阶段与 stepper 位置的换算。
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

/** 素材来源类别；与 core 的 `AssetProvenance.kind` 一一对应（web 不依赖 core，这里就地声明窄形状）。 */
export type ProvenanceKind = "user_uploaded" | "ai_generated" | "stock" | "library";

/** 徽标色调；与 Chip 的 tone 取值同形，避免 labels 反向依赖组件。 */
export type ProvenanceTone = "neutral" | "ok" | "warn" | "danger" | "brand";

/** 前端展示所需的来源声明子集：服务端回传的是任意 JSON，收窄后只认这些字段。 */
export interface ProvenanceView {
  kind: ProvenanceKind;
  provider?: string;
  license?: string;
  sourceUrl?: string;
  attribution?: string;
}

/** 素材来源类别中文标签。 */
export const PROVENANCE_LABELS: Record<ProvenanceKind, string> = {
  user_uploaded: "用户上传",
  ai_generated: "AI 生成",
  stock: "网络素材",
  library: "素材库"
};

/** 分镜的素材来源（`assetSource`）；与 core 的 StoryboardShot.assetSource 一一对应。 */
export type AssetSourceKind = "reference_image" | "generated_image" | "title_card";

/**
 * 画面实际来源的中文标签。与 [[PROVENANCE_LABELS]] 是两个维度：这里说的是「这一镜的画面怎么来的」
 * （用了用户的图 / 模型生成 / 只有一张标题卡），那里说的是「素材的版权从哪来」。
 * 两者同时展示，用户才知道「这镜是标题卡」和「这镜的图是 AI 画的」分别是哪件事。
 */
export const ASSET_SOURCE_LABELS: Record<AssetSourceKind, string> = {
  reference_image: "参考图",
  generated_image: "生成图",
  title_card: "标题卡"
};

/**
 * 来源徽标色调。网络素材刻意用 warn：它是唯一「许可需要人工核对」的来源类别，
 * 用中性色会让人以为和 AI 生成一样不必过问。其余三类来源清晰或已带许可，保持中性/品牌色。
 */
export const PROVENANCE_TONES: Record<ProvenanceKind, ProvenanceTone> = {
  user_uploaded: "neutral",
  ai_generated: "brand",
  stock: "warn",
  library: "neutral"
};

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把服务端回传的任意 JSON 收窄成来源声明视图：kind 不在四类内、或根本不是对象时返回 null（视为「未声明」）。
 * 不做任何补全或推断——服务端已经校验过 stock 必须有出处与许可，前端再把缺失字段编出来就等于二次编造。
 * @param raw script.json / render-manifest.json 里读出的原始值
 */
export function parseProvenance(raw: unknown): ProvenanceView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const kind = item.kind;
  if (kind !== "user_uploaded" && kind !== "ai_generated" && kind !== "stock" && kind !== "library") {
    return null;
  }
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const provider = text(item.provider);
  const license = text(item.license);
  const sourceUrl = text(item.sourceUrl);
  const attribution = text(item.attribution);
  return {
    kind,
    ...(provider ? { provider } : {}),
    ...(license ? { license } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(attribution ? { attribution } : {})
  };
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：一句话说明来源，用于交付面板与徽标的正文：有署名时用署名（那本来就是给人看的署名文本），
 * 否则退回「类别（提供方）」——宁可显示「AI 生成（provider）」，也不要留一片空白让人以为没来源。
 * @param provenance 已收窄的来源声明
 */
export function provenanceSummary(provenance: ProvenanceView): string {
  if (provenance.attribution) {
    return provenance.attribution;
  }
  const label = PROVENANCE_LABELS[provenance.kind];
  return provenance.provider ? `${label}（${provenance.provider}）` : label;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：悬停详情：来源类别 + 许可 + 署名 + 出处逐行列出，缺哪项就不写哪行（不写「—」占位，避免把「未声明」看成「无许可」）。
 * @param provenance 已收窄的来源声明
 */
export function provenanceHint(provenance: ProvenanceView): string {
  const lines = [`来源：${provenanceSummary(provenance)}`];
  if (provenance.license) {
    lines.push(`许可：${provenance.license}`);
  }
  if (provenance.attribution) {
    lines.push(`署名：${provenance.attribution}`);
  }
  if (provenance.sourceUrl) {
    lines.push(`出处：${provenance.sourceUrl}`);
  }
  return lines.join("\n");
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把检查点映射到「重做该阶段」应回退的流水线阶段。
 */
export function checkpointToStage(checkpoint: CheckpointKind): StageKind {
  switch (checkpoint) {
    case "script":
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
 * 失败/取消的断点由调用方并入 stage 传入（job.stage ?? job.breakStage），停在哪儿就高亮到哪儿。
 */
export function stepperIndex(phase: JobPhase, stage?: StageKind, checkpoint?: CheckpointKind): number {
  if (phase === "done") {
    return 4;
  }
  if ((phase === "running" || phase === "failed" || phase === "cancelled") && stage) {
    return STAGES.indexOf(stage);
  }
  if (phase === "awaiting" && checkpoint) {
    const doneStages: Record<CheckpointKind, number> = { script: 1, shots: 2, audio: 3, final: 4 };
    return doneStages[checkpoint];
  }
  return -1;
}
