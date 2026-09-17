/**
 * @file TaskView.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 任务详情视图：组合 stepper、检查点操作条、计费卡、脚本编辑器、镜头墙、交付面板与运行日志；订阅 SSE 状态流并在阶段/检查点变化后刷新工件快照。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useCallback, useEffect, useState } from "react";
import type { ArtifactsSnapshot } from "@aivideo/shared";
import { api } from "../api";
import { useJobStream } from "../hooks/useJobStream";
import CheckpointBar from "./CheckpointBar";
import CostCard from "./CostCard";
import DeliverPanel from "./DeliverPanel";
import LogPanel from "./LogPanel";
import ScriptEditor from "./ScriptEditor";
import ShotWall from "./ShotWall";
import Stepper from "./Stepper";
import { PHASE_LABELS } from "../labels";

/** TaskView 组件入参。 */
interface Props {
  jobId: string;
  onDeleted: () => void;
  onChanged: () => void;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染单个任务的完整工作台视图。
 */
export default function TaskView({ jobId, onDeleted, onChanged }: Props) {
  const { job, events, connected, error, refresh } = useJobStream(jobId);
  const [artifacts, setArtifacts] = useState<ArtifactsSnapshot | null>(null);
  const [artifactsKey, setArtifactsKey] = useState(0);

  const reloadArtifacts = useCallback((): void => {
    api
      .artifacts(jobId)
      .then((snapshot) => {
        setArtifacts(snapshot);
        setArtifactsKey((key) => key + 1);
      })
      .catch(() => setArtifacts(null));
  }, [jobId]);

  useEffect(() => {
    setArtifacts(null);
    setArtifactsKey(0);
  }, [jobId]);

  useEffect(() => {
    if (job) {
      reloadArtifacts();
    }
  }, [job?.phase, job?.checkpoint, reloadArtifacts, job !== null]);

  if (error && !job) {
    return (
      <section className="card">
        <div className="error-line">{error}</div>
        <button onClick={refresh}>重试</button>
      </section>
    );
  }
  if (!job) {
    return <div className="muted">加载中…</div>;
  }

  const busy = job.phase === "queued" || job.phase === "running";
  const canCancel = busy || job.phase === "awaiting";
  const script = (artifacts?.script ?? null) as Record<string, unknown> | null;

  const handleMutated = (): void => {
    reloadArtifacts();
    refresh();
    onChanged();
  };

  return (
    <div>
      <section className="card">
        <div className="task-header">
          <h2>{job.request.theme || job.projectId}</h2>
          <span className={`badge ${job.phase}`}>{PHASE_LABELS[job.phase]}</span>
          {job.request.generationMode === "script" && <span className="badge">仅脚本</span>}
          <span className="badge">{job.execMode === "guided" ? "分步确认" : "全自动"}</span>
          {!connected && <span className="badge">事件流断开，自动重连中</span>}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {job.request.skill !== "auto" && `模板 ${job.request.skill} · `}
          {job.request.aspectRatio} · {job.request.durationSeconds}s · {job.request.platform}
          {job.queuePosition ? ` · 队列第 ${job.queuePosition} 位` : ""}
        </div>
        {job.error && <div className="error-line">{job.error}</div>}
        <div style={{ marginTop: 10 }}>
          <Stepper job={job} />
        </div>
        <div className="actions">
          <button onClick={reloadArtifacts} disabled={busy}>
            刷新工件
          </button>
          {canCancel && (
            <button
              className="danger"
              onClick={() => {
                api.cancel(job.id).then(handleMutated).catch((err: Error) => window.alert(err.message));
              }}
            >
              取消任务
            </button>
          )}
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm("确认删除该任务及其全部产物文件？")) {
                api
                  .deleteProject(job.id)
                  .then(onDeleted)
                  .catch((err: Error) => window.alert(err.message));
              }
            }}
          >
            删除项目
          </button>
        </div>
      </section>

      <CheckpointBar job={job} onChanged={handleMutated} />
      {job.phase === "awaiting" && job.checkpoint === "cost" && <CostCard jobId={job.id} />}

      {script != null && (
        <ScriptEditor
          key={`${jobId}:${artifactsKey}`}
          jobId={job.id}
          script={script}
          busy={busy}
          onSaved={handleMutated}
        />
      )}

      <ShotWall jobId={job.id} shots={artifacts?.shots ?? []} busy={busy} onChanged={handleMutated} />

      {(artifacts?.shots.length || job.phase === "done" || job.request.generationMode === "script") && (
        <DeliverPanel job={job} artifacts={artifacts} onChanged={handleMutated} />
      )}

      <section className="card">
        <h2>运行日志</h2>
        <LogPanel events={events} />
      </section>
    </div>
  );
}
