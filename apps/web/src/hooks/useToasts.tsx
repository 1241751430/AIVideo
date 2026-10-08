/**
 * @file useToasts.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 全局通知体系：ToastProvider 以 portal 挂玻璃浮层，useToast() 暴露 success/error/info；支持行动按钮、自动过期与 aria-live 播报，替换全站原生 alert。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleCheck, CircleX, Info, X } from "lucide-react";

/** 通知语义类型。 */
export type ToastKind = "success" | "error" | "info";

/** 通知附带的行动按钮。 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/** useToast() 返回值。 */
export interface ToastApi {
  push: (kind: ToastKind, text: string, action?: ToastAction) => void;
  success: (text: string, action?: ToastAction) => void;
  error: (text: string, action?: ToastAction) => void;
  info: (text: string, action?: ToastAction) => void;
}

/** 单条通知的内部状态形状。 */
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  action?: ToastAction;
}

/** 各类型自动关闭时长（毫秒）：error 停留更久便于阅读。 */
const DISMISS_MS: Record<ToastKind, number> = { success: 3600, error: 6000, info: 4200 };

/** 同屏最多保留的通知数。 */
const MAX_TOASTS = 5;

const ToastContext = createContext<ToastApi | null>(null);

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：通知容器——维护 toast 列表、自动过期与 portal 浮层渲染，包裹整个应用根节点。
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number): void => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string, action?: ToastAction): void => {
      seq.current += 1;
      const id = seq.current;
      setItems((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, kind, text, action }]);
      window.setTimeout(() => dismiss(id), DISMISS_MS[kind]);
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (text: string, action?: ToastAction) => push("success", text, action),
      error: (text: string, action?: ToastAction) => push("error", text, action),
      info: (text: string, action?: ToastAction) => push("info", text, action)
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toast-stack" role="status" aria-live="polite">
          {items.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.kind === "success" ? <CircleCheck size={16} /> : t.kind === "error" ? <CircleX size={16} /> : <Info size={16} />}
              <span className="toast-text">{t.text}</span>
              {t.action && (
                <button
                  className="toast-action"
                  onClick={() => {
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="关闭通知">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：在 ToastProvider 子树内获取通知 API。
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast 必须在 ToastProvider 内使用");
  }
  return ctx;
}
