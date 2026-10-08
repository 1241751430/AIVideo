/**
 * @file useShortcuts.ts
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 全局键盘快捷键 Hook：N 新建、/ 聚焦搜索、? 速查表、Esc 关闭浮层；输入框/文本域/可编辑区内一律豁免（Esc 除外），带修饰键的组合不拦截。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useEffect, useRef } from "react";

/** 快捷键回调集合（均可选）。 */
export interface ShortcutHandlers {
  onNew?: () => void;
  onSearch?: () => void;
  onHelp?: () => void;
  onEscape?: () => void;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：注册全局 keydown 监听并路由到处理器；处理器经 ref 透传，监听只挂一次。
 */
export function useShortcuts(handlers: ShortcutHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      const el = e.target as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (e.key === "Escape") {
        ref.current.onEscape?.();
        return;
      }
      if (typing || e.isComposing) {
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        ref.current.onNew?.();
      } else if (e.key === "/") {
        e.preventDefault();
        ref.current.onSearch?.();
      } else if (e.key === "?") {
        e.preventDefault();
        ref.current.onHelp?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
