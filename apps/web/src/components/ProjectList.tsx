/**
 * @file ProjectList.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 侧栏项目历史列表：关键字搜索 + 状态筛选 chips + 相对时间 + 类型图标（任务/旧项目/损坏），运行项呼吸点；删除走玻璃确认框并以 toast 反馈。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useMemo, useState } from "react";
import { Film, History, Search, Trash, TriangleAlert } from "lucide-react";
import type { ProjectListItem } from "@aivideo/shared";
import { api } from "../api";
import { useToast } from "../hooks/useToasts";
import ConfirmDialog from "./ConfirmDialog";
import EmptyState from "./EmptyState";
import { PHASE_LABELS } from "../labels";

/** ProjectList 组件入参。 */
interface Props {
  items: ProjectListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
}

/** 列表状态筛选项。 */
type StatusFilter = "all" | "active" | "done" | "failed";

const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "active", label: "进行中" },
  { key: "done", label: "已完成" },
  { key: "failed", label: "失败" }
];

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把列表项映射为点色（done/进行中/失败/损坏/普通）。
 */
function dotClass(item: ProjectListItem): string {
  if (item.kind === "corrupt") {
    return "corrupt";
  }
  const phase = item.job?.phase;
  if (phase === "done") {
    return "done";
  }
  if (phase === "failed" || phase === "cancelled") {
    return "failed";
  }
  if (phase) {
    return "active";
  }
  return "";
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：列表项归属的状态桶（用于筛选与副标题文案）。
 */
function statusOf(item: ProjectListItem): { key: StatusFilter | "legacy"; label: string } {
  if (item.kind === "corrupt") {
    return { key: "failed", label: "任务数据损坏" };
  }
  const phase = item.job?.phase;
  if (phase) {
    if (phase === "done") {
      return { key: "done", label: PHASE_LABELS[phase] };
    }
    if (phase === "failed" || phase === "cancelled") {
      return { key: "failed", label: PHASE_LABELS[phase] };
    }
    return { key: "active", label: PHASE_LABELS[phase] };
  }
  return { key: "legacy", label: item.hasVideo ? "旧项目 · 有成片" : "旧项目" };
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：ISO 时间转中文相对时间（刚刚/x分钟前/x小时前/x天前/日期）。
 */
function relTime(iso: string | undefined): string {
  if (!iso) {
    return "";
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) {
    return "刚刚";
  }
  if (min < 60) {
    return `${min}分钟前`;
  }
  const hour = Math.floor(min / 60);
  if (hour < 24) {
    return `${hour}小时前`;
  }
  const day = Math.floor(hour / 24);
  if (day < 7) {
    return `${day}天前`;
  }
  return new Date(then).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：标题取值（任务主题 > 旧项目目录名 > id）。
 */
function titleOf(item: ProjectListItem): string {
  return item.job?.request.theme || item.title || item.projectId;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染带搜索与筛选的项目历史列表，删除经确认框后以 toast 反馈。
 */
export default function ProjectList({ items, selectedId, onSelect, onDeleted }: Props) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [pendingDelete, setPendingDelete] = useState<ProjectListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const visible = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== "all" && statusOf(item).key !== filter) {
        return false;
      }
      if (!kw) {
        return true;
      }
      return titleOf(item).toLowerCase().includes(kw) || item.projectId.toLowerCase().includes(kw);
    });
  }, [items, query, filter]);

  const confirmDelete = (): void => {
    if (!pendingDelete) {
      return;
    }
    setDeleting(true);
    api
      .deleteProject(pendingDelete.projectId)
      .then(() => {
        toast.success(`已删除「${titleOf(pendingDelete)}」`);
        onDeleted(pendingDelete.projectId);
        setPendingDelete(null);
      })
      .catch((err: Error) => toast.error(`删除失败：${err.message}`))
      .finally(() => setDeleting(false));
  };

  return (
    <div className="project-list-wrap">
      <label className="search-box">
        <Search size={14} aria-hidden="true" />
        <input
          placeholder="搜索项目"
          aria-label="搜索项目"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="filter-chips" role="group" aria-label="状态筛选">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`fchip${filter === f.key ? " selected" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
        <span className="fchip-count muted">{visible.length}</span>
      </div>
      <div className="project-list">
        {visible.length === 0 && (
          <EmptyState
            icon={items.length === 0 ? Film : Search}
            title={items.length === 0 ? "还没有项目" : "没有匹配项"}
            hint={items.length === 0 ? "点击上方「新建项目」从一个想法开始" : "换个关键字或筛选条件试试"}
          />
        )}
        {visible.map((item) => {
          const status = statusOf(item);
          return (
            <div
              key={item.projectId}
              className={`project-item${item.projectId === selectedId ? " selected" : ""}`}
              onClick={() => onSelect(item.projectId)}
            >
              <span className={`dot ${dotClass(item)}`} aria-hidden="true" />
              <span className="meta">
                <span className="title">
                  {item.kind === "corrupt" && <TriangleAlert size={12} className="kind-ico" aria-hidden="true" />}
                  {item.kind === "project" && <History size={12} className="kind-ico" aria-hidden="true" />}
                  {titleOf(item)}
                </span>
                <span className="sub">
                  {status.label}
                  {item.updatedAt ? ` · ${relTime(item.updatedAt)}` : ""}
                </span>
              </span>
              <button
                className="icon-btn danger del-btn"
                title="删除项目及其目录"
                aria-label={`删除 ${titleOf(item)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDelete(item);
                }}
              >
                <Trash size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除项目"
        message={
          pendingDelete
            ? `确认删除「${titleOf(pendingDelete)}」？该操作会移除项目目录及其全部产物文件，无法恢复。`
            : undefined
        }
        confirmLabel="删除"
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
