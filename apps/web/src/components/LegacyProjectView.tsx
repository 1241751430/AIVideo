/**
 * @file LegacyProjectView.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description CLI 时代旧项目与损坏项的只读视图：这类目录不挂任务引擎，GET /:id 与全部媒体路由都会 404，故只展示列表元信息（标题/成片标记）与「打开文件夹」（该端点支持旧目录）；明示编辑、预览、日志仅任务可用，替代原先点进去必报错的体验。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useState } from "react";
import { FolderOpen, History, TriangleAlert } from "lucide-react";
import type { ProjectListItem } from "@aivideo/shared";
import { api } from "../api";
import Chip from "./Chip";

/** LegacyProjectView 组件入参。 */
interface Props {
  item: ProjectListItem;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染旧项目/损坏项的只读卡片。
 */
export default function LegacyProjectView({ item }: Props) {
  const [folderHint, setFolderHint] = useState<string | null>(null);
  const corrupt = item.kind === "corrupt";
  const title = item.title || item.projectId;

  const openFolder = (): void => {
    api
      .openFolder(item.projectId)
      .then((res) => setFolderHint(res.hint ?? null))
      .catch((err: Error) => setFolderHint(err.message));
  };

  return (
    <section className="card legacy-view">
      <header className="task-header">
        <h2>
          {corrupt ? <TriangleAlert size={18} className="legacy-ico" /> : <History size={18} className="legacy-ico" />}
          {title}
        </h2>
        <span className="spacer" />
        {corrupt ? <Chip label="任务数据损坏" tone="danger" /> : <Chip label="旧项目 · 只读" tone="warn" />}
        {item.hasVideo ? <Chip label="有成片" tone="ok" /> : null}
      </header>
      <ul className="deliver-list">
        <li className="deliver-row">
          <span>项目目录</span>
          <code>project/{item.projectId}</code>
        </li>
        {item.updatedAt ? (
          <li className="deliver-row">
            <span>目录最后更新</span>
            <code>{item.updatedAt}</code>
          </li>
        ) : null}
      </ul>
      <div className="row">
        <button onClick={openFolder}>
          <FolderOpen size={15} aria-hidden="true" />
          打开文件夹
        </button>
      </div>
      {folderHint ? <div className="error-line folder-hint">{folderHint}</div> : null}
      <p className="muted legacy-note">
        {corrupt
          ? "该目录的 job.json 无法读取，工作台不展示进度与产物；可打开文件夹检查内容，或在左侧删除后重新创建任务。"
          : "这是 CLI 时代生成的项目目录，未挂接任务引擎：编辑、媒体预览与运行日志仅对「任务」可用；打开文件夹即可查看脚本、分镜与成片文件。"}
      </p>
    </section>
  );
}
