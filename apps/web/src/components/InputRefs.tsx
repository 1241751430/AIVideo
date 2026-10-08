/**
 * @file InputRefs.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 任务头参考图条：GET /:id/input-image?index= 按 brief.inputImages 顺序出图、越界即 404，故用隐藏 Image 从 0 逐个探测（上限 8）收集缩略图；一张都没有时整行不渲染，点击可新窗口查看原图。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useEffect, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { inputImageUrl } from "../api";

/** 探测上限（防越界请求无限延伸）。 */
const MAX_PROBE = 8;

/** InputRefs 组件入参。 */
interface Props {
  projectId: string;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：顺序探测并渲染参考图缩略行。
 */
export default function InputRefs({ projectId }: Props) {
  const [urls, setUrls] = useState<string[]>([]);

  useEffect(() => {
    setUrls([]);
    let cancelled = false;
    let index = 0;
    const probe = (): void => {
      if (cancelled || index >= MAX_PROBE) {
        return;
      }
      const url = inputImageUrl(projectId, index);
      const img = new Image();
      img.onload = (): void => {
        if (cancelled) {
          return;
        }
        index += 1;
        setUrls((prev) => [...prev, url]);
        probe();
      };
      img.onerror = (): void => {
        // 越界 404（或任务无参考图/未落盘）：探测自然结束
      };
      img.src = url;
    };
    probe();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (urls.length === 0) {
    return null;
  }
  return (
    <div className="ref-row" aria-label="参考图">
      <span className="muted ref-label">
        <ImageIcon size={12} aria-hidden="true" />
        参考图 {urls.length}
      </span>
      {urls.map((url, i) => (
        <a key={url} className="ref-thumb-link" href={url} target="_blank" rel="noreferrer" title={`查看参考图 ${i + 1} 原图`}>
          <img className="ref-thumb" src={url} alt={`参考图 ${i + 1}`} loading="lazy" />
        </a>
      ))}
    </div>
  );
}
