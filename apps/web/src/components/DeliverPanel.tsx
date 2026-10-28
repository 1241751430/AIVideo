/**
 * @file DeliverPanel.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 交付面板：影院式暗场框内在线播放成片（Range 流式）与下载；产物被编辑置 videoStale 时展示琥珀警示条与「重新渲染」CTA（覆盖式重写成片，先经确认框）；字幕（captions.srt）与脚本（script.md）在盘时给出独立下载口——它们此前只能去项目目录里找；脚本模式给出产物清单（脚本/分镜/镜头计数）；「打开文件夹」调宿主文件管理器，容器降级时展示宿主路径；操作反馈走 toast。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useState } from "react";
import { CircleCheck, CirclePlay, Download, FileText, FolderOpen, RotateCcw, Subtitles, TriangleAlert } from "lucide-react";
import type { ArtifactsSnapshot, JobDto } from "@aivideo/shared";
import { api, fileUrl, videoUrl } from "../api";
import { useToast } from "../hooks/useToasts";
import ConfirmDialog from "./ConfirmDialog";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染成片区（播放/下载/重渲）与产物目录提示。
 */
export default function DeliverPanel({
  job,
  artifacts,
  onChanged
}: {
  job: JobDto;
  artifacts: ArtifactsSnapshot | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [folderHint, setFolderHint] = useState<string | null>(null);
  const videoReady = artifacts?.videoReady ?? false;
  const videoStale = job.result?.videoStale === true;

  // 重渲只跑 ffmpeg、不调用任何远端提供者，因此不走计费闸（见 useCostGate）；
  // 但它是覆盖式操作：会重写现有成片，且耗时——仍要人确认一次。
  const rerender = (): void => {
    setConfirming(false);
    setBusy(true);
    api
      .rerender(job.id)
      .then(() => {
        toast.success("已重新排队渲染");
        onChanged();
      })
      .catch((err: Error) => toast.error(`重渲排队失败：${err.message}`))
      .finally(() => setBusy(false));
  };

  const openFolder = (): void => {
    setFolderHint(null);
    api
      .openFolder(job.projectId)
      .then((res) => {
        if (!res.ok) {
          setFolderHint(`${res.hint ?? "未能打开文件管理器"}（路径：${res.path}）`);
        }
      })
      .catch((err: Error) => setFolderHint(err.message));
  };

  const storyboardCount = artifacts?.storyboard?.shots?.length ?? 0;
  const hasScript = artifacts?.script != null;
  const readyShots = (artifacts?.shots ?? []).filter(
    (entry) => entry.files.video || entry.files.image || entry.files.manifestAsset
  ).length;
  // 字幕/脚本一直在磁盘上，但此前只有成片一个下载口——文案工作者拿不到自己的东西。
  // 路径以服务端给的为准（字幕文件名来自 manifest），md 固定落在项目根。
  const captionsPath = artifacts?.manifest?.captionsFile ?? "captions/captions.srt";
  const deliverables: Array<{ key: string; label: string; icon: typeof Download; href: string; file: string }> = [
    ...(artifacts?.captionsReady
      ? [{ key: "srt", label: "下载字幕", icon: Subtitles, href: fileUrl(job.id, captionsPath), file: "captions.srt" }]
      : []),
    ...(artifacts?.scriptMdReady
      ? [{ key: "md", label: "下载脚本", icon: FileText, href: fileUrl(job.id, "script.md"), file: "script.md" }]
      : [])
  ];

  return (
    <section className="card deliver">
      <h2>
        交付{" "}
        {videoStale && <span className="badge stale">成片未反映最新编辑，需重新渲染</span>}
        {videoReady && !videoStale && <span className="badge done">可下载</span>}
      </h2>
      {videoStale && videoReady && (
        <div className="stale-bar" role="status">
          <TriangleAlert size={14} aria-hidden="true" />
          编辑已改动画面/旁白/字幕，当前在线播放的仍是旧版成片。
          <button className="primary" disabled={busy} onClick={() => setConfirming(true)}>
            <RotateCcw size={13} aria-hidden="true" />
            {busy ? "排队中…" : "重新渲染"}
          </button>
        </div>
      )}
      {videoReady ? (
        <>
          <div className="deliver-frame">
            <video controls preload="metadata" src={videoUrl(job.id)} />
          </div>
          <div className="actions">
            <a href={videoUrl(job.id)} download={`${job.request.theme || job.id}.mp4`}>
              <button>
                <Download size={14} aria-hidden="true" /> 下载成片
              </button>
            </a>
            <span className="muted deliver-file" title={job.projectId}>
              <CirclePlay size={13} aria-hidden="true" /> {artifacts?.manifest?.outputFile ?? "final.mp4"}
            </span>
          </div>
        </>
      ) : job.request.generationMode === "script" ? (
        <div className="deliver-list">
          <div className={`deliver-row${hasScript ? " ok" : ""}`}>
            <CircleCheck size={14} aria-hidden="true" /> 脚本（script.json）{hasScript ? "已生成" : "待生成"}
          </div>
          <div className={`deliver-row${storyboardCount > 0 ? " ok" : ""}`}>
            <CircleCheck size={14} aria-hidden="true" /> 分镜 {storyboardCount > 0 ? `${storyboardCount} 个镜头` : "待生成"}（见上方镜头墙）
          </div>
          <div className="deliver-row muted">脚本模式不渲染视频，可在镜头墙审阅编辑后拿文案与分镜自行剪辑。</div>
        </div>
      ) : (
        <div className="deliver-list">
          <div className={`deliver-row${readyShots > 0 ? " ok" : ""}`}>
            <CircleCheck size={14} aria-hidden="true" /> 镜头画面 {readyShots}/{artifacts?.shots.length ?? 0} 已生成
          </div>
          <div className="deliver-row muted">渲染完成后，成片会出现在这里（播放 / 下载）。</div>
        </div>
      )}
      {deliverables.length > 0 && (
        <div className="actions">
          {deliverables.map((item) => (
            <a key={item.key} href={item.href} download={`${job.request.theme || job.id}-${item.file}`}>
              <button>
                <item.icon size={14} aria-hidden="true" /> {item.label}
              </button>
            </a>
          ))}
        </div>
      )}
      <div className="actions" style={{ marginTop: 8, alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12 }}>
          项目目录：project/{job.projectId}
        </span>
        <button onClick={openFolder}>
          <FolderOpen size={14} aria-hidden="true" /> 打开文件夹
        </button>
      </div>
      {folderHint && <div className="error-line" style={{ fontSize: 12 }}>{folderHint}</div>}
      <ConfirmDialog
        open={confirming}
        title="重新渲染成片"
        message="将强制重跑渲染阶段并覆盖当前成片（project 目录下的 final.mp4）。素材与配音不会重新生成，不产生远端费用。确认继续？"
        confirmLabel="重新渲染"
        danger={false}
        busy={busy}
        onConfirm={rerender}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}
