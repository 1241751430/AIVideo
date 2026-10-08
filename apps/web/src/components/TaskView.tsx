/**
 * @file TaskView.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 任务详情视图：bento 任务头（状态徽标 + 参数 chips + 派生进度 stepper）、SSE 断线提示条、图标化操作组（刷新/取消/删除走确认框与 toast）；组合检查点操作条、计费卡、脚本编辑器、镜头墙、交付面板与运行日志，订阅 SSE 并在阶段/检查点变化后刷新工件快照。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useCallback, useEffect, useState } from "react";
import { Ban, RefreshCw, Trash, WifiOff } from "lucide-react";
import type { ArtifactsSnapshot } from "@aivideo/shared";
import { api } from "../api";
import { useJobStream } from "../hooks/useJobStream";
import { useToast } from "../hooks/useToasts";
import CheckpointBar from "./CheckpointBar";
import Chip from "./Chip";
import ConfirmDialog from "./ConfirmDialog";
import CostCard from "./CostCard";
import DeliverPanel from "./DeliverPanel";
import LogPanel from "./LogPanel";
import ScriptEditor from "./ScriptEditor";
import ShotWall from "./ShotWall";
import Skeleton from "./Skeleton";
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
  const toast = useToast();
  const { job, events, connected, error, refresh } = useJobStream(jobId);
  const [artifacts, setArtifacts] = useState<ArtifactsSnapshot | null>(null);
  const [artifactsKey, setArtifactsKey] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    return (
      <section className="card">
        <Skeleton height={22} width="40%" rounded="block" />
        <div style={{ marginTop: 12 }}>
          <Skeleton height={34} rounded="block" />
        </div>
        <div style={{ marginTop: 16 }}>
          <Skeleton height={120} rounded="block" />
        </div>
      </section>
    );
  }

  const busy = job.phase === "queued" || job.phase === "running";
  const canCancel = busy || job.phase === "awaiting";
  const script = (artifacts?.script ?? null) as Record<string, unknown> | null;

  const handleMutated = (): void => {
    reloadArtifacts();
    refresh();
    onChanged();
  };

  const doCancel = (): void => {
    api
      .cancel(job.id)
      .then(() => {
        toast.info("任务已取消");
        handleMutated();
      })
      .catch((err: Error) => toast.error(`取消失败：${err.message}`));
  };

  const doDelete = (): void => {
    setDeleting(true);
    api
      .deleteProject(job.id)
      .then(() => {
        toast.success("项目已删除");
        onDeleted();
      })
      .catch((err: Error) => toast.error(`删除失败：${err.message}`))
      .finally(() => setDeleting(false));
  };

  return (
    <div>
      {!connected && (
        <div className="stream-banner" role="status">
          <WifiOff size={14} aria-hidden="true" />
          事件流已断开，正在自动重连（状态仍按轮询刷新）
        </div>
      )}
      <section className="card task-bento">
        <div className="task-header">
          <h2>{job.request.theme || job.projectId}</h2>
          <span className={`badge ${job.phase}`}>{PHASE_LABELS[job.phase]}</span>
          {job.phase === "queued" && job.queuePosition ? <Chip label={`队列第 ${job.queuePosition} 位`} tone="warn" /> : null}
          <span className="spacer" />
          <div className="action-group" role="group" aria-label="任务操作">
            <button className="icon-btn" title="刷新工件" aria-label="刷新工件" disabled={busy} onClick={reloadArtifacts}>
              <RefreshCw size={14} />
            </button>
            {canCancel && (
              <button className="icon-btn" title="取消任务" aria-label="取消任务" onClick={doCancel}>
                <Ban size={14} />
              </button>
            )}
            <button
              className="icon-btn danger"
              title="删除项目"
              aria-label="删除项目"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash size={14} />
            </button>
          </div>
        </div>
        <div className="task-chips">
          {job.request.generationMode === "script" && <Chip label="仅脚本分镜" />}
          <Chip label={job.execMode === "guided" ? "分步确认" : "全自动"} />
          {job.request.skill !== "auto" && <Chip label={`模板 ${job.request.skill}`} />}
          <Chip label={job.request.aspectRatio} title="画面比例" />
          <Chip label={`${job.request.durationSeconds}s`} title="目标时长" />
          <Chip label={job.request.platform ?? "平台默认"} title="发布平台" />
          {job.request.language && <Chip label={job.request.language} title="口播语言" />}
        </div>
        {job.error && <div className="error-line">{job.error}</div>}
        <div style={{ marginTop: 10 }}>
          <Stepper job={job} shots={artifacts?.shots ?? []} />
        </div>
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title="删除项目"
        message={`确认删除「${job.request.theme || job.projectId}」？该操作会移除项目目录及其全部产物文件，无法恢复。`}
        confirmLabel="删除"
        busy={deleting}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />

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
