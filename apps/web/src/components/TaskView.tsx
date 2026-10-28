/**
 * @file TaskView.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 任务详情视图：bento 任务头（状态徽标 + 参数 chips + 参考图条 + 派生进度 stepper）、SSE 断线提示条、图标化操作组（刷新/取消/删除走确认框与 toast）；组合检查点操作条、脚本编辑器、镜头墙、交付面板与运行日志，订阅 SSE 并在阶段/检查点变化后刷新工件快照，运行期额外按节拍补拉（镜头逐张落盘，只靠阶段切换跟不上进度）；项目不存在时给出返回新建的出口。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Play, RefreshCw, Trash, TriangleAlert, WifiOff } from "lucide-react";
import type { ArtifactsSnapshot } from "@aivideo/shared";
import { api } from "../api";
import { useJobStream } from "../hooks/useJobStream";
import { useToast } from "../hooks/useToasts";
import CheckpointBar from "./CheckpointBar";
import Chip from "./Chip";
import ConfirmDialog from "./ConfirmDialog";
import DeliverPanel from "./DeliverPanel";
import InputRefs from "./InputRefs";
import LogPanel from "./LogPanel";
import ScriptEditor from "./ScriptEditor";
import ShotWall from "./ShotWall";
import Skeleton from "./Skeleton";
import Stepper from "./Stepper";
import { PHASE_LABELS, STAGE_LABELS } from "../labels";

/**
 * 运行期工件快照补拉节拍。镜头是逐张落盘的，四段流水线跑完只会切三次阶段，
 * 光靠阶段变化刷新，镜头墙在素材阶段会整段空着。
 */
const ARTIFACTS_POLL_MS = 4000;

/** TaskView 组件入参。 */
interface Props {
  jobId: string;
  onDeleted: () => void;
  onChanged: () => void;
  /** 回到新建页（深链到不存在/已删除的项目时唯一的出口）。 */
  onBack: () => void;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染单个任务的完整工作台视图。
 */
export default function TaskView({ jobId, onDeleted, onChanged, onBack }: Props) {
  const toast = useToast();
  const { job, events, connected, error, refresh } = useJobStream(jobId);
  const [artifacts, setArtifacts] = useState<ArtifactsSnapshot | null>(null);
  const [artifactsKey, setArtifactsKey] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resuming, setResuming] = useState(false);
  /** 上一次成功读到的脚本内容：只有它变了才允许编辑器重挂载，否则会丢未保存草稿。 */
  const lastScriptRef = useRef<string | null>(null);

  const reloadArtifacts = useCallback((): void => {
    api
      .artifacts(jobId)
      .then((snapshot) => {
        setArtifacts(snapshot);
        const signature = snapshot.script ? JSON.stringify(snapshot.script) : null;
        if (signature !== lastScriptRef.current) {
          lastScriptRef.current = signature;
          setArtifactsKey((key) => key + 1);
        }
      })
      .catch(() => setArtifacts(null));
  }, [jobId]);

  useEffect(() => {
    setArtifacts(null);
    setArtifactsKey(0);
    lastScriptRef.current = null;
  }, [jobId]);

  // 依赖数组只放基本量：直接写 job?.phase 也能跑，但区别在于「job 从 null 变成对象」
  // 这一变化靠 job?.phase 的 undefined→值 表达不出来，多带一个布尔量才能首帧就拉一次工件。
  // stage 必须在内：全自动模式下 phase 整段都是 running、checkpoint 全程 undefined，
  // 少了它，脚本/镜头墙/交付面板要等任务 done 才第一次出现。
  const jobPhase = job?.phase;
  const jobStage = job?.stage;
  const jobCheckpoint = job?.checkpoint;
  const hasJob = job !== null;

  useEffect(() => {
    if (hasJob) {
      reloadArtifacts();
    }
  }, [jobPhase, jobStage, jobCheckpoint, hasJob, reloadArtifacts]);

  // 运行期补拉：镜头是逐张落盘的，四段流水线只切三次阶段，阶段驱动追不上素材进度。
  const jobRunning = jobPhase === "queued" || jobPhase === "running";
  useEffect(() => {
    if (!hasJob || !jobRunning) {
      return;
    }
    const timer = window.setInterval(reloadArtifacts, ARTIFACTS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasJob, jobRunning, reloadArtifacts]);

  if (error && !job) {
    // 服务端对不存在/已删项目回的是英文 "Unknown project"；直接铺在界面上既不像人话，
    // 旁边的「重试」也永远只会再失败一次。这里给出中文说明与一条真正能走的路。
    const missing = /\b404\b|unknown project/i.test(error);
    return (
      <section className="card">
        <div className="error-line">
          {missing ? `找不到项目「${jobId}」：它可能已被删除，或存在于另一台机器的项目目录里。` : error}
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          {!missing && <button onClick={refresh}>重试</button>}
          <button className="primary" onClick={onBack}>
            返回新建
          </button>
        </div>
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
  // 失败/取消是终态：没有检查点条可点，只能靠「从断点继续」重新入队。
  const canResume = job.phase === "failed" || job.phase === "cancelled";
  // 断点未知时不指名阶段：旧版本落盘的 job.json 没有 breakStage，
  // 继承到它的人不该被告知「停在脚本阶段」这种编出来的事实。
  const breakStageLabel = job.breakStage ? STAGE_LABELS[job.breakStage] : null;
  const resumeHint = breakStageLabel ? `任务在${breakStageLabel}阶段` : "任务";
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

  const doResume = (): void => {
    setResuming(true);
    api
      .resume(job.id)
      .then(() => {
        toast.success("已从断点继续");
        handleMutated();
      })
      .catch((err: Error) => toast.error(`继续失败：${err.message}`))
      .finally(() => setResuming(false));
  };

  return (
    <div>
      {!connected && (
        <div className="stream-banner" role="status">
          <WifiOff size={14} aria-hidden="true" />
          实时事件流已断开，任务状态改为每 3 秒轮询刷新（运行日志暂停，恢复连接后自动补齐）
        </div>
      )}
      <section className="card task-bento">
        <div className="task-header">
          <h2>{job.request.theme || job.projectId}</h2>
          <span className={`badge ${job.phase}`}>{PHASE_LABELS[job.phase]}</span>
          {job.phase === "queued" && job.queuePosition ? <Chip label={`队列第 ${job.queuePosition} 位`} tone="warn" /> : null}
          <span className="spacer" />
          <div className="action-group" role="group" aria-label="任务操作">
            {/* 读工件是只读操作：运行中恰恰最需要它，不能跟删除一样被 busy 锁住。 */}
            <button className="icon-btn" title="刷新工件" aria-label="刷新工件" onClick={reloadArtifacts}>
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
        <InputRefs projectId={job.projectId} />
        {job.error && <div className="error-line">{job.error}</div>}
        {canResume && (
          <div className="stale-bar" role="status">
            <TriangleAlert size={14} aria-hidden="true" />
            {resumeHint}
            {job.phase === "failed" ? "中断" : "被取消"}，已完成的阶段会按输入指纹跳过，继续不会重复调用远端模型。
            <button className="primary" disabled={resuming} onClick={doResume}>
              <Play size={13} aria-hidden="true" />
              {resuming ? "入队中…" : breakStageLabel ? `从${breakStageLabel}继续` : "从断点继续"}
            </button>
          </div>
        )}
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

      {script != null && (
        <ScriptEditor
          key={`${jobId}:${artifactsKey}`}
          jobId={job.id}
          script={script}
          busy={busy}
          onSaved={handleMutated}
        />
      )}

      <ShotWall
        jobId={job.id}
        shots={artifacts?.shots ?? []}
        busy={busy}
        showRetry={job.request.generationMode !== "script"}
        onChanged={handleMutated}
      />

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
