/**
 * @file useHashRoute.ts
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 零依赖 hash 路由：选中任务与 URL `#/job/<id>` 双向同步——刷新/分享可恢复现场，浏览器前进后退可用；非任务（旧项目/损坏项）同样以该格式携带目录 id。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useCallback, useEffect, useState } from "react";

/** 匹配 `#/job/<id>` 的 hash 形状。 */
const JOB_HASH = /^#\/job\/(.+)$/;

/** useHashRoute 返回值。 */
export interface HashRoute {
  selectedId: string | null;
  select: (id: string | null) => void;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：维护与 location.hash 同步的选中项 id；hashchange（前进/后退）自动回灌状态。
 */
export function useHashRoute(): HashRoute {
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const match = window.location.hash.match(JOB_HASH);
    return match ? decodeURIComponent(match[1] ?? "") : null;
  });

  useEffect(() => {
    const onHashChange = (): void => {
      const match = window.location.hash.match(JOB_HASH);
      setSelectedId(match ? decodeURIComponent(match[1] ?? "") : null);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const select = useCallback((id: string | null): void => {
    setSelectedId(id);
    const target = id ? `#/job/${encodeURIComponent(id)}` : "#";
    if (window.location.hash !== target) {
      window.location.hash = target;
    }
  }, []);

  return { selectedId, select };
}
