/**
 * @file App.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 工作台根组件：左侧项目历史 + 右侧「创建 / 任务详情」两个视图的切换，持有 skills/summary 启动数据并驱动列表轮询刷新。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useCallback, useEffect, useState } from "react";
import type { ProjectListItem, SkillCard, SummaryResponse } from "@aivideo/shared";
import { api } from "./api";
import CreateCard from "./components/CreateCard";
import ProjectList from "./components/ProjectList";
import TaskView from "./components/TaskView";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：根组件——加载系统摘要与模板卡，轮询项目列表，管理选中任务并渲染创建/详情视图。
 */
export default function App() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [skills, setSkills] = useState<SkillCard[]>([]);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api.summary().then(setSummary).catch((err: Error) => setLoadError(err.message));
    api.skills().then((res) => setSkills(res.skills)).catch(() => undefined);
  }, []);

  const refreshProjects = useCallback((): void => {
    api
      .listProjects()
      .then((res) => {
        setProjects(res.projects);
        setLoadError(null);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  useEffect(() => {
    refreshProjects();
    const timer = window.setInterval(refreshProjects, 5000);
    return () => window.clearInterval(timer);
  }, [refreshProjects]);

  const handleCreated = useCallback(
    (jobId: string): void => {
      setSelectedId(jobId);
      refreshProjects();
    },
    [refreshProjects]
  );

  const handleDeleted = useCallback((): void => {
    setSelectedId(null);
    refreshProjects();
  }, [refreshProjects]);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>镜头墙工作台</h1>
        <button className="primary" onClick={() => setSelectedId(null)}>
          ＋ 新建项目
        </button>
        {loadError && <div className="error-line">{loadError}</div>}
        <ProjectList
          items={projects}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDeleted={(id) => {
            if (id === selectedId) {
              handleDeleted();
            } else {
              refreshProjects();
            }
          }}
        />
      </aside>
      <main className="main">
        {selectedId ? (
          <TaskView jobId={selectedId} onDeleted={handleDeleted} onChanged={refreshProjects} />
        ) : (
          <CreateCard summary={summary} skills={skills} onCreated={handleCreated} />
        )}
      </main>
    </div>
  );
}
