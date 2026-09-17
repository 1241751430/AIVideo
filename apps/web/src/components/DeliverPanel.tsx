/**
 * @file DeliverPanel.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 交付面板：成片在线播放（Range 流式）、下载链接；产物被编辑后置为 videoStale 时展示警示与「重新渲染」CTA；script 模式给出脚本交付说明；「打开文件夹」调用宿主文件管理器，容器降级时展示宿主路径。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useState } from "react";
import type { ArtifactsSnapshot, JobDto } from "@aivideo/shared";
import { api, videoUrl } from "../api";

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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [folderHint, setFolderHint] = useState<string | null>(null);
  const videoReady = artifacts?.videoReady ?? false;
  const videoStale = job.result?.videoStale === true;

  const rerender = (): void => {
    setBusy(true);
    setMessage(null);
    api
      .rerender(job.id)
      .then(() => {
        setMessage("已重新排队渲染");
        onChanged();
      })
      .catch((err: Error) => setMessage(err.message))
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

  return (
    <section className="card deliver">
      <h2>
        交付{" "}
        {videoStale && <span className="badge stale">成片未反映最新编辑，需重新渲染</span>}
        {videoReady && !videoStale && <span className="badge done">可下载</span>}
      </h2>
      {videoReady ? (
        <>
          <video controls preload="metadata" src={videoUrl(job.id)} />
          <div className="actions">
            <a href={videoUrl(job.id)} download={`${job.request.theme || job.id}.mp4`}>
              <button>下载成片</button>
            </a>
            {videoStale && (
              <button className="primary" disabled={busy} onClick={rerender}>
                {busy ? "排队中…" : "重新渲染"}
              </button>
            )}
          </div>
        </>
      ) : job.request.generationMode === "script" ? (
        <div className="muted">脚本模式：产物为脚本与分镜（见上方脚本与镜头墙），不渲染视频。</div>
      ) : (
        <div className="muted">渲染完成后，成片会出现在这里（播放 / 下载）。</div>
      )}
      {message && <div className={message.startsWith("已") ? "notice" : "error-line"}>{message}</div>}
      <div className="actions" style={{ marginTop: 8, alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12 }}>
          项目目录：project/{job.projectId}
        </span>
        <button onClick={openFolder}>打开文件夹</button>
      </div>
      {folderHint && <div className="error-line" style={{ fontSize: 12 }}>{folderHint}</div>}
    </section>
  );
}
