/**
 * @file useFocusTrap.ts
 * @author zhangbaohong
 * @date 2026-10-28
 * @description 模态浮层的焦点管理：打开时把焦点移入浮层、Tab/Shift+Tab 在浮层内循环、关闭时把焦点还给打开它的那个元素。三个 portal 浮层（确认框 / 灯箱 / 速查表）原先只有 aria-modal 而没有实际约束，键盘用户 Tab 一下就会跑到背后的页面上。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useEffect } from "react";
import type { RefObject } from "react";

/** 可聚焦元素的够用子集：浮层里只有按钮、链接与表单控件。 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：收集容器内当前可见的可聚焦元素（display:none 的按钮不该被 Tab 停住）。
 */
function visibleFocusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0
  );
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：在浮层激活期间把焦点关在容器内，并在关闭后归还原先的焦点。
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  initialFocusRef?: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initial = initialFocusRef?.current ?? visibleFocusables(container)[0];
    initial?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") {
        return;
      }
      const list = visibleFocusables(container);
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0] as HTMLElement;
      const last = list[list.length - 1] as HTMLElement;
      const current = document.activeElement;
      // 焦点跑到浮层外（或浏览器把焦点抛到 body）时，下一次 Tab 必须回到浮层里。
      const outside = !(current instanceof Node) || !container.contains(current);
      if (e.shiftKey && (outside || current === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || current === last)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // 打开它的按钮可能已经被卸载（例如行内删除后列表刷新），归还前先确认还在文档里。
      if (previous && document.contains(previous)) {
        previous.focus();
      }
    };
  }, [active, containerRef, initialFocusRef]);
}
