/**
 * @file App.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 工作台根组件：玻璃顶栏（品牌+服务/模型状态）+ 左侧项目历史 + 右侧「创建 / 任务详情 / 旧项目只读」视图切换，持有 skills/summary/healthz 启动数据并驱动列表轮询刷新；挂 hash 路由（#/job/<id> 可分享可前进后退）、全局快捷键（N/／/?/Esc）与速查表浮层。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useCallback, useEffect, useState } from "react";
import { Keyboard, Plus } from "lucide-react";
import type { ProjectListItem, SkillCard, SummaryResponse } from "@aivideo/shared";
import { api } from "./api";
import CreateCard from "./components/CreateCard";
import LegacyProjectView from "./components/LegacyProjectView";
import ProjectList from "./components/ProjectList";
import ShortcutsSheet from "./components/ShortcutsSheet";
import Skeleton from "./components/Skeleton";
import TaskView from "./components/TaskView";
import TopBar from "./components/TopBar";
import { useHashRoute } from "./hooks/useHashRoute";
import { useShortcuts } from "./hooks/useShortcuts";

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：根组件——加载系统摘要/模板卡/健康告警，轮询项目列表，按 hash 路由管理选中任务并渲染创建/详情/旧项目只读视图。
 */
export default function App() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [skills, setSkills] = useState<SkillCard[]>([]);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const { selectedId, select } = useHashRoute();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
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
        setListLoaded(true);
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
      select(jobId);
      refreshProjects();
    },
    [refreshProjects, select]
  );

  const handleDeleted = useCallback((): void => {
    select(null);
    refreshProjects();
  }, [refreshProjects, select]);

  useShortcuts({
    onNew: () => select(null),
    onSearch: () => document.querySelector<HTMLInputElement>(".search-box input")?.focus(),
    onHelp: () => setSheetOpen((v) => !v),
    onEscape: () => setSheetOpen(false)
  });

  // 选中项类型决定视图：任务走 TaskView；旧项目/损坏项走只读视图；
  // hash 深链首帧先等列表（否则旧项目 id 会瞬时误挂任务引擎打开 SSE）；
  // 新建任务在列表轮询追上之前查不到条目，按任务视图处理（GET /:id 很快可用）。
  const selected = selectedId ? projects.find((p) => p.projectId === selectedId) ?? null : null;
  const waitingList = selectedId !== null && !selected && !listLoaded && !loadError;

  return (
    <div className="app-shell">
      <TopBar summary={summary} warnings={warnings} serviceOk={serviceOk} />
      <div className="app">
        <aside className="sidebar">
          <button className="primary new-project" onClick={() => select(null)}>
            <Plus size={15} aria-hidden="true" />
            新建项目
          </button>
          {loadError && <div className="error-line">{loadError}</div>}
          <ProjectList
            items={projects}
            selectedId={selectedId}
            onSelect={select}
            onDeleted={(id) => {
              if (id === selectedId) {
                handleDeleted();
              } else {
                refreshProjects();
              }
            }}
          />
          <button className="shortcuts-hint" onClick={() => setSheetOpen(true)} title="键盘快捷键速查">
            <Keyboard size={13} aria-hidden="true" />
            快捷键
            <kbd>?</kbd>
          </button>
        </aside>
        <main className="main">
          {selectedId === null ? (
            <CreateCard summary={summary} skills={skills} onCreated={handleCreated} />
          ) : waitingList ? (
            <section className="card">
              <Skeleton height={20} width="30%" rounded="block" />
              <div style={{ marginTop: 14 }}>
                <Skeleton height={120} rounded="block" />
              </div>
            </section>
          ) : selected && selected.kind !== "job" ? (
            <LegacyProjectView item={selected} />
          ) : (
            <TaskView jobId={selectedId} onDeleted={handleDeleted} onChanged={refreshProjects} />
          )}
        </main>
      </div>
      <ShortcutsSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </div>
  );
}
