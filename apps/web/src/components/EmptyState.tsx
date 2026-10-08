/**
 * @file EmptyState.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 通用空态占位：图标 + 主文案 + 辅助说明 + 可选行动按钮，替换散落的「暂无 xx」纯文本。
 * @see https://github.com/1241751430/AIVideo.git
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** EmptyState 组件入参。 */
interface Props {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染居中空态区块。
 */
export default function EmptyState({ icon: Icon, title, hint, action }: Props) {
  return (
    <div className="empty-state">
      <Icon size={26} aria-hidden="true" />
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
