/**
 * @file ConfirmDialog.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 玻璃模态确认框：替换原生 window.confirm——焦点陷阱、Esc/遮罩取消、危险动作红色主按钮，删除/取消任务/放弃检查点共用。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { TriangleAlert } from "lucide-react";
import { useFocusTrap } from "../hooks/useFocusTrap";

/** ConfirmDialog 组件入参。 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  /** 危险动作（删除/放弃）时主按钮红色强调。 */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染确认模态；打开时聚焦确认按钮并挂 Esc 监听。
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认",
  danger = true,
  busy = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // 焦点陷阱：打开时聚焦确认按钮，Tab 不逃出浮层，关闭后焦点归还原按钮。
  useFocusTrap(open, cardRef, confirmRef);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) {
    return null;
  }
  return createPortal(
    <div className="overlay-backdrop" onClick={onCancel}>
      <div
        ref={cardRef}
        className="confirm-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-head">
          <TriangleAlert size={18} className={danger ? "danger-ico" : "warn-ico"} aria-hidden="true" />
          <b>{title}</b>
        </div>
        {message && <p className="confirm-msg">{message}</p>}
        <div className="confirm-actions">
          <button onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button ref={confirmRef} className={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>
            {busy ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
