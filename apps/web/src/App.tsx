/**
 * @file App.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 工作台根组件：玻璃顶栏（品牌+服务/模型状态）+ 左侧项目历史 + 右侧「创建 / 任务详情」两视图切换，持有 skills/summary/healthz 启动数据并驱动列表轮询刷新。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { ProjectListItem, SkillCard, SummaryResponse } from "@aivideo/shared";
import { api } from "./api";
import CreateCard from "./components/CreateCard";
import ProjectList from "./components/ProjectList";
import TaskView from "./components/TaskView";
import TopBar from "./components/TopBar";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：根组件——加载系统摘要/模板卡/健康告警，轮询项目列表，管理选中任务并渲染创建/详情视图。
 */
export default function App() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [skills, setSkills] = useState<SkillCard[]>([]);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serviceOk, setServiceOk] = useState(true);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    api.summary().then(setSummary).catch(() => undefined);
    api.skills().then((res) => setSkills(res.skills)).catch(() => undefined);
    api
      .healthz()
      .then((res) => {
        setWarnings(res.warnings ?? []);
        setServiceOk(true);
      })
      .catch(() => setServiceOk(false));
  }, []);

  const refreshProjects = useCallback((): void => {
    api
      .listProjects()
      .then((res) => {
        setProjects(res.projects);
        setLoadError(null);
        setServiceOk(true);
      })
      .catch((err: Error) => {
        setLoadError(err.message);
        setServiceOk(false);
      });
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
    <div className="app-shell">
      <TopBar summary={summary} warnings={warnings} serviceOk={serviceOk} />
      <div className="app">
        <aside className="sidebar">
          <button className="primary new-project" onClick={() => setSelectedId(null)}>
            <Plus size={15} aria-hidden="true" />
            新建项目
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
    </div>
  );
}
