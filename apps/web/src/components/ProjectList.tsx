/**
 * @file ProjectList.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 侧栏项目历史列表：任务/旧项目/损坏项点色区分，显示标题、状态与时间，支持选中与删除。
 * @see https://github.com/1241751430/AIVideo.git
 */
import type { ProjectListItem } from "@aivideo/shared";
import { api } from "../api";
import { PHASE_LABELS } from "../labels";

/** ProjectList 组件入参。 */
interface Props {
  items: ProjectListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
}

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
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染项目历史列表。
 */
export default function ProjectList({ items, selectedId, onSelect, onDeleted }: Props) {
  return (
    <div className="project-list">
      {items.length === 0 && <div className="muted" style={{ padding: "8px 10px" }}>暂无项目</div>}
      {items.map((item) => (
        <div
          key={item.projectId}
          className={`project-item${item.projectId === selectedId ? " selected" : ""}`}
          onClick={() => onSelect(item.projectId)}
        >
          <span className={`dot ${dotClass(item)}`} />
          <span className="meta">
            <span className="title">{item.job?.request.theme || item.title || item.projectId}</span>
            <span className="sub">
              {item.kind === "corrupt"
                ? "任务数据损坏"
                : item.job
                  ? PHASE_LABELS[item.job.phase]
                  : item.hasVideo
                    ? "旧项目·有成片"
                    : "旧项目"}
            </span>
          </span>
          <button
            className="danger"
            title="删除项目及其目录"
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`确认删除「${item.job?.request.theme || item.title || item.projectId}」及其全部产物文件？`)) {
                api
                  .deleteProject(item.projectId)
                  .then(() => onDeleted(item.projectId))
                  .catch((err: Error) => window.alert(err.message));
              }
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
