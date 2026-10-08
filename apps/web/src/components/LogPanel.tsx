/**
 * @file LogPanel.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 运行日志面板：工具条支持级别过滤（错误按关键字启发式识别，非服务端等级字段）、自动跟随开关（离底即暂停并出现「回到最新」）、全屏展开（Esc 关闭）与一键复制；终端式等宽渲染 SSE 事件流。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Copy, Maximize2, Minimize2 } from "lucide-react";
import type { EventRecord } from "@aivideo/shared";
import { useToast } from "../hooks/useToasts";
import { PHASE_LABELS } from "../labels";

/** 日志级别过滤器。 */
type LevelFilter = "all" | "log" | "status" | "error";

const LEVELS: Array<{ key: LevelFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "log", label: "日志" },
  { key: "status", label: "状态" },
  { key: "error", label: "错误" }
];

/** 错误关键字启发式：SSE 事件没有服务端等级字段，只能按文本猜测，tooltip 如实标注。 */
const ERROR_PATTERN = /失败|错误|异常|超时|警告|error|fail|timeout|warn|exception/i;

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：把事件渲染为一行文本。
 */
function lineOf(event: EventRecord): string {
  const time = new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false });
  if (event.type === "log") {
    return `${time} ${String(event.data.message ?? "")}`;
  }
  const phase = String(event.data.phase ?? "");
  return `${time} ▸ ${PHASE_LABELS[phase as keyof typeof PHASE_LABELS] ?? phase}${
    event.data.stage ? `（${String(event.data.stage)}）` : ""
  }${event.data.error ? `：${String(event.data.error)}` : ""}`;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：判定事件级别（error 为关键字启发式）。
 */
function levelOf(event: EventRecord): "log" | "status" | "error" {
  if (ERROR_PATTERN.test(lineOf(event))) {
    return "error";
  }
  return event.type === "log" ? "log" : "status";
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染事件日志；支持过滤、跟随、展开与复制。
 */
export default function LogPanel({ events }: { events: EventRecord[] }) {
  const toast = useToast();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [following, setFollowing] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const visible = useMemo(
    () => (level === "all" ? events : events.filter((event) => levelOf(event) === level)),
    [events, level]
  );

  useEffect(() => {
    if (following) {
      const box = boxRef.current;
      if (box) {
        box.scrollTop = box.scrollHeight;
      }
    }
  }, [visible, following, expanded, level]);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const counts = useMemo(() => {
    const acc: Record<Exclude<LevelFilter, "all">, number> = { log: 0, status: 0, error: 0 };
    for (const event of events) {
      acc[levelOf(event)] += 1;
    }
    return acc;
  }, [events]);

  const copyAll = (): void => {
    const text = visible.map(lineOf).join("\n");
    if (!navigator.clipboard) {
      toast.error("当前浏览器环境不支持剪贴板写入");
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`已复制 ${visible.length} 行日志`))
      .catch(() => toast.error("复制失败：浏览器拒绝了剪贴板访问"));
  };

  return (
    <div className={`log-wrap${expanded ? " expanded" : ""}`}>
      <div className="log-toolbar">
        <div className="log-filters" role="group" aria-label="日志级别过滤">
          {LEVELS.map((item) => (
            <button
              key={item.key}
              className={`fchip${level === item.key ? " selected" : ""}${item.key === "error" ? " err" : ""}`}
              title={item.key === "error" ? "错误由关键字启发式识别（服务端无等级字段）" : undefined}
              onClick={() => setLevel(item.key)}
            >
              {item.label}
              {item.key !== "all" ? ` ${counts[item.key]}` : ` ${events.length}`}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button
          className={`icon-btn${following ? " active" : ""}`}
          title={following ? "自动跟随最新日志（滚动离开底部会暂停）" : "已暂停跟随"}
          aria-label="切换自动跟随"
          onClick={() => setFollowing((v) => !v)}
        >
          <ChevronDown size={14} />
        </button>
        <button className="icon-btn" title="复制当前筛选结果" aria-label="复制日志" onClick={copyAll}>
          <Copy size={14} />
        </button>
        <button
          className="icon-btn"
          title={expanded ? "退出全屏（Esc）" : "全屏展开日志"}
          aria-label={expanded ? "退出日志全屏" : "全屏展开日志"}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>
      <div
        className="log-panel"
        ref={boxRef}
        onScroll={() => {
          const box = boxRef.current;
          if (!box) {
            return;
          }
          const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
          setFollowing(nearBottom);
        }}
      >
        {visible.length === 0 && <span className="muted">（暂无{level === "all" ? "" : "该级别"}日志）</span>}
        {visible.map((event) => {
          const kind = levelOf(event);
          return (
            <span key={event.id} className={`log-line${event.type === "status" ? " status" : ""}${kind === "error" ? " failed-line" : ""}`}>
              {lineOf(event)}
            </span>
          );
        })}
      </div>
      {!following && visible.length > 0 && (
        <button className="log-jump" onClick={() => setFollowing(true)}>
          <ChevronDown size={13} aria-hidden="true" />
          回到最新
        </button>
      )}
    </div>
  );
}
