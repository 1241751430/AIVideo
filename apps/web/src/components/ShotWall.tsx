/**
 * @file ShotWall.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 镜头墙：逐镜卡片展示可预览的视频/图片/配音，就地编辑标题、旁白、字幕、画面提示词与时长（core 失效矩阵自动删除过期产物），并提供「重新生成素材 / 重新配音」单镜重试入口。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useState } from "react";
import type { ShotArtifactEntry } from "@aivideo/shared";
import { api, fileUrl } from "../api";

/** ShotWall 组件入参。 */
interface Props {
  jobId: string;
  shots: ShotArtifactEntry[];
  busy: boolean;
  onChanged: () => void;
}

/** 单镜可编辑字段（表单态）。 */
interface ShotForm {
  title: string;
  narration: string;
  caption: string;
  visualPrompt: string;
  durationSeconds: string;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：从工件条目（storyboard 优先、manifest 兜底）提取表单初始值。
 */
function formOf(entry: ShotArtifactEntry): ShotForm {
  const sb = (entry.storyboard ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const fromSb = sb[key];
    if (typeof fromSb === "string" || typeof fromSb === "number") {
      return String(fromSb);
    }
    const fromManifest = entry[key];
    if (typeof fromManifest === "string" || typeof fromManifest === "number") {
      return String(fromManifest);
    }
    return undefined;
  };
  return {
    title: pick("title") ?? String(entry.shotId ?? ""),
    narration: pick("narration") ?? "",
    caption: pick("caption") ?? "",
    visualPrompt: pick("visualPrompt") ?? "",
    durationSeconds: pick("durationSeconds") ?? ""
  };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染镜头墙网格；无工件时给出占位提示。
 */
export default function ShotWall({ jobId, shots, busy, onChanged }: Props) {
  return (
    <section className="card">
      <h2>镜头墙</h2>
      {shots.length === 0 ? (
        <div className="muted">脚本生成后，这里会列出每个镜头的预览与编辑入口。</div>
      ) : (
        <div className="shot-grid">
          {shots.map((entry, index) => (
            <ShotCard key={String(entry.shotId ?? index)} jobId={jobId} entry={entry} index={index} busy={busy} onChanged={onChanged} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：单镜卡片——媒体预览 + 编辑表单 + 保存/重试与失效反馈。
 */
function ShotCard({
  jobId,
  entry,
  index,
  busy,
  onChanged
}: {
  jobId: string;
  entry: ShotArtifactEntry;
  index: number;
  busy: boolean;
  onChanged: () => void;
}) {
  const shotId = String(entry.shotId ?? `shot-${index + 1}`);
  const [form, setForm] = useState<ShotForm>(() => formOf(entry));
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = (): boolean =>
    form.title !== formOf(entry).title ||
    form.narration !== formOf(entry).narration ||
    form.caption !== formOf(entry).caption ||
    form.visualPrompt !== formOf(entry).visualPrompt ||
    form.durationSeconds !== formOf(entry).durationSeconds;

  const save = (): void => {
    const base = formOf(entry);
    const patch: Record<string, string | number> = {};
    for (const key of ["title", "narration", "caption", "visualPrompt"] as const) {
      if (form[key] !== base[key]) {
        patch[key] = form[key];
      }
    }
    if (form.durationSeconds !== base.durationSeconds) {
      patch.durationSeconds = Number(form.durationSeconds);
    }
    if (Object.keys(patch).length === 0) {
      setMessage("没有修改");
      return;
    }
    setSaving(true);
    setMessage(null);
    api
      .updateShot(jobId, shotId, patch)
      .then((res) => {
        const notes: string[] = [];
        if (res.audioInvalidated) {
          notes.push("旁白过期，将重新配音");
        }
        if (res.assetInvalidated) {
          notes.push("画面过期，将重新生成素材");
        }
        if (res.deleted.length > 0) {
          notes.push(`已清理 ${res.deleted.join("、")}`);
        }
        setMessage(notes.length > 0 ? `已保存：${notes.join("；")}` : "已保存");
        onChanged();
      })
      .catch((err: Error) => setMessage(err.message))
      .finally(() => setSaving(false));
  };

  const retry = (target: "asset" | "audio"): void => {
    setMessage(null);
    api
      .retryShot(jobId, shotId, target)
      .then((res) => {
        setMessage(
          res.deleted.length > 0
            ? `已删除 ${res.deleted.join("、")}，任务重新排队执行${target === "asset" ? "素材" : "配音"}阶段`
            : `该镜头暂无${target === "asset" ? "素材" : "配音"}文件，任务重新排队执行对应阶段`
        );
        onChanged();
      })
      .catch((err: Error) => setMessage(err.message));
  };

  const assetFile = entry.files.video ?? entry.files.image ?? entry.files.manifestAsset;

  return (
    <div className="shot-card">
      <div className="shot-title">
        <span>
          {index + 1}. {form.title || shotId}
        </span>
        <span className="muted" style={{ fontSize: 11 }}>
          {shotId}
        </span>
      </div>
      {entry.files.video ? (
        <video controls preload="metadata" src={fileUrl(jobId, entry.files.video)} />
      ) : assetFile ? (
        <img src={fileUrl(jobId, assetFile)} alt={shotId} loading="lazy" />
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          尚无画面产物（素材阶段生成后可见）
        </div>
      )}
      {entry.files.audio ? <audio controls preload="none" src={fileUrl(jobId, entry.files.audio)} /> : null}
      <label className="field">
        标题
        <input disabled={busy} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </label>
      <label className="field">
        旁白（改动将删除本镜配音）
        <textarea
          rows={2}
          disabled={busy}
          value={form.narration}
          onChange={(e) => setForm({ ...form, narration: e.target.value })}
        />
      </label>
      <label className="field">
        字幕
        <input disabled={busy} value={form.caption} onChange={(e) => setForm({ ...form, caption: e.target.value })} />
      </label>
      <label className="field">
        画面提示词（改动将删除本镜素材）
        <textarea
          rows={2}
          disabled={busy}
          value={form.visualPrompt}
          onChange={(e) => setForm({ ...form, visualPrompt: e.target.value })}
        />
      </label>
      <label className="field">
        时长（秒）
        <input
          type="number"
          min={1}
          disabled={busy}
          value={form.durationSeconds}
          onChange={(e) => setForm({ ...form, durationSeconds: e.target.value })}
        />
      </label>
      <div className="row">
        <button className="primary" disabled={busy || saving || !dirty()} onClick={save}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button disabled={busy} title="删除本镜素材并重新排队素材阶段" onClick={() => retry("asset")}>
          重生成素材
        </button>
        <button disabled={busy} title="删除本镜配音并重新排队旁白阶段" onClick={() => retry("audio")}>
          重配音
        </button>
      </div>
      {message && <div className={message.startsWith("已") ? "notice" : "error-line"}>{message}</div>}
    </div>
  );
}
