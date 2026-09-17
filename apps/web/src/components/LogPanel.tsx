/**
 * @file LogPanel.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 运行日志面板：按 SSE 事件顺序渲染 log 与 status 行，自动滚动到底部。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useEffect, useRef } from "react";
import type { EventRecord } from "@aivideo/shared";
import { PHASE_LABELS } from "../labels";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染事件日志并跟随最新行滚动。
 */
export default function LogPanel({ events }: { events: EventRecord[] }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (box) {
      box.scrollTop = box.scrollHeight;
    }
  }, [events]);
  return (
    <div className="log-panel" ref={boxRef}>
      {events.length === 0 && <span className="muted">（暂无日志）</span>}
      {events.map((event) => {
        const time = new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false });
        if (event.type === "log") {
          return (
            <span key={event.id} className="log-line">
              {time} {String(event.data.message ?? "")}
            </span>
          );
        }
        const phase = String(event.data.phase ?? "");
        return (
          <span key={event.id} className={`log-line status${phase === "failed" ? " failed-line" : ""}`}>
            {time} ▸ {PHASE_LABELS[phase as keyof typeof PHASE_LABELS] ?? phase}
            {event.data.stage ? `（${String(event.data.stage)}）` : ""}
            {event.data.error ? `：${String(event.data.error)}` : ""}
          </span>
        );
      })}
    </div>
  );
}
