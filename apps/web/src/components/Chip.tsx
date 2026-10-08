/**
 * @file Chip.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 通用信息胶囊：图标 + 文案 + 语义色调（neutral/ok/warn/danger/brand），用于任务参数、镜头角标与创建页解析预览。
 * @see https://github.com/1241751430/AIVideo.git
 */
import type { ReactNode } from "react";

/** Chip 组件入参。 */
export interface ChipProps {
  label: string;
  icon?: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "danger" | "brand";
  title?: string;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染单个只读信息胶囊。
 */
export default function Chip({ label, icon, tone = "neutral", title }: ChipProps) {
  return (
    <span className={`chip ${tone}`} title={title}>
      {icon}
      {label}
    </span>
  );
}
