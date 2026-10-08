/**
 * @file Lightbox.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 镜头画面灯箱：暗幕放大预览镜头图/视频，支持 ←/→ 跨镜切换与 Esc 关闭，底部显示序号与镜头标题；由镜头墙缩略区唤起。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

/** 灯箱条目。 */
export interface LightboxItem {
  id: string;
  title: string;
  src: string;
  kind: "image" | "video";
}

/** Lightbox 组件入参。 */
interface Props {
  items: LightboxItem[];
  /** null 表示关闭。 */
  index: number | null;
  onIndex: (index: number) => void;
  onClose: () => void;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染灯箱浮层并挂 ←/→/Esc 键监听。
 */
export default function Lightbox({ items, index, onIndex, onClose }: Props) {
  useEffect(() => {
    if (index === null || items.length === 0) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowRight") {
        onIndex((index + 1) % items.length);
      } else if (e.key === "ArrowLeft") {
        onIndex((index - 1 + items.length) % items.length);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onIndex, onClose]);

  if (index === null || !items[index]) {
    return null;
  }
  const item = items[index];
  return createPortal(
    <div className="overlay-backdrop lightbox" onClick={onClose}>
      <div className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn lightbox-close" aria-label="关闭灯箱" onClick={onClose}>
          <X size={16} />
        </button>
        {items.length > 1 && (
          <button
            className="icon-btn lightbox-nav prev"
            aria-label="上一个镜头"
            onClick={() => onIndex((index - 1 + items.length) % items.length)}
          >
            <ChevronLeft size={20} />
          </button>
        )}
        {item.kind === "video" ? (
          <video controls autoPlay preload="metadata" src={item.src} />
        ) : (
          <img src={item.src} alt={item.title} />
        )}
        {items.length > 1 && (
          <button
            className="icon-btn lightbox-nav next"
            aria-label="下一个镜头"
            onClick={() => onIndex((index + 1) % items.length)}
          >
            <ChevronRight size={20} />
          </button>
        )}
        <div className="lightbox-caption">
          {index + 1} / {items.length} · {item.title}
        </div>
      </div>
    </div>,
    document.body
  );
}
