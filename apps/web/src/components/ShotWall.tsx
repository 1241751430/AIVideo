/**
 * @file ShotWall.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 镜头墙：缩略图优先的镜头卡网格——角标（时长/景别/转场/素材来源）、产物齐备小灯与拖拽排序把手（调 PUT /:id/shots/order，失败即回滚）；标题/旁白/字幕/提示词/时长编辑收进折叠抽屉，保存与单镜重试以 toast 反馈；缩略区可点开灯箱（←/→ 跨镜、Esc），顶部提供「重试失败镜头」批量入口；core 失效矩阵自动删除过期产物。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useEffect, useMemo, useState } from "react";
import { Clock, GripVertical, Image as ImageIcon, Maximize2, Mic, Pencil, Video } from "lucide-react";
import type { ShotArtifactEntry } from "@aivideo/shared";
import { api, fileUrl } from "../api";
import { useToast } from "../hooks/useToasts";
import Chip from "./Chip";
import EmptyState from "./EmptyState";
import Lightbox from "./Lightbox";
import type { LightboxItem } from "./Lightbox";
import RetryQueue from "./RetryQueue";

/** ShotWall 组件入参。 */
interface Props {
  jobId: string;
  shots: ShotArtifactEntry[];
  busy: boolean;
  /** 是否显示批量重试入口（仅脚本模式镜头本就不产画面，不应提示重试）。 */
  showRetry: boolean;
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
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：读取条目的字符串字段（storyboard 优先）。
 */
function sbField(entry: ShotArtifactEntry, key: string): string | null {
  const fromSb = (entry.storyboard as Record<string, unknown> | null)?.[key];
  const fromEntry = (entry as Record<string, unknown>)[key];
  const value = typeof fromSb === "string" ? fromSb : typeof fromEntry === "string" ? fromEntry : null;
  return value && value.trim() ? value : null;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：镜头键（shotId，缺失时按位兜底）。
 */
function keyOf(entry: ShotArtifactEntry, index: number): string {
  return String(entry.shotId ?? `shot-${index + 1}`);
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染镜头墙网格；支持把手拖拽排序（乐观更新 + 失败回滚），无工件时空态。
 */
export default function ShotWall({ jobId, shots, busy, showRetry, onChanged }: Props) {
  const toast = useToast();
  const ids = useMemo(() => shots.map(keyOf), [shots]);
  const signature = ids.join("|");
  const [order, setOrder] = useState<string[]>(ids);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [lightIdx, setLightIdx] = useState<number | null>(null);

  useEffect(() => {
    // 服务端工件刷新后对齐本地顺序（同一集合内保持乐观序）；signature 变化即 ids 变化
    const same = order.length === ids.length && ids.every((id) => order.includes(id));
    if (!same) {
      setOrder(ids);
    }
  }, [signature]);

  const byId = new Map(shots.map((entry, index) => [keyOf(entry, index), entry]));
  const ordered: ShotArtifactEntry[] = [];
  order.forEach((id) => {
    const entry = byId.get(id);
    if (entry) {
      ordered.push(entry);
      byId.delete(id);
    }
  });
  byId.forEach((entry) => ordered.push(entry));
  const canDrag = !busy && shots.length > 1 && shots.every((entry, index) => entry.shotId !== undefined);

  const commitOrder = (next: string[]): void => {
    const prev = order;
    setOrder(next);
    api
      .reorderShots(jobId, next)
      .then(() => {
        toast.success("镜头顺序已保存，成片标记为待重新渲染");
        onChanged();
      })
      .catch((err: Error) => {
        setOrder(prev);
        toast.error(`排序保存失败：${err.message}`);
      });
  };

  const handleDrop = (targetId: string): void => {
    if (!dragId || dragId === targetId) {
      return;
    }
    const next = order.filter((id) => id !== dragId);
    next.splice(next.indexOf(targetId), 0, dragId);
    if (next.length !== order.length) {
      return;
    }
    commitOrder(next);
  };

  // 灯箱条目：有画面产物的镜头按当前展示序进入 ←/→ 轮播
  const lightItems: LightboxItem[] = [];
  const lightIdxByKey = new Map<string, number>();
  ordered.forEach((entry, index) => {
    const key = keyOf(entry, index);
    const src = entry.files.video ?? entry.files.image ?? entry.files.manifestAsset;
    if (src && entry.shotId) {
      lightIdxByKey.set(key, lightItems.length);
      lightItems.push({
        id: key,
        title: formOf(entry).title || key,
        src: fileUrl(jobId, src),
        kind: entry.files.video ? "video" : "image"
      });
    }
  });
  const failedShotIds = showRetry
    ? ordered
        .filter(
          (entry) =>
            entry.shotId &&
            !entry.files.video &&
            !entry.files.image &&
            !entry.files.manifestAsset &&
            !entry.files.audio
        )
        .map((entry) => String(entry.shotId))
    : [];

  return (
    <section className="card">
      <div className="shot-wall-head">
        <h2>
          镜头墙{" "}
          {shots.length > 0 && <span className="muted shot-count">{shots.length} 镜</span>}
          {canDrag && <span className="muted drag-hint">· 按住把手可拖拽排序</span>}
        </h2>
        <span className="spacer" />
        <RetryQueue jobId={jobId} failedShotIds={failedShotIds} busy={busy} onChanged={onChanged} />
      </div>
      {shots.length === 0 ? (
        <EmptyState icon={Video} title="镜头墙为空" hint="脚本生成后，这里会列出每个镜头的预览与编辑入口" />
      ) : (
        <div className="shot-grid">
          {ordered.map((entry, index) => (
            <div
              key={keyOf(entry, index)}
              className={`shot-drop${overId === keyOf(entry, index) && dragId ? " drag-over" : ""}`}
              onDragOver={(e) => {
                if (!canDrag || !dragId) {
                  return;
                }
                e.preventDefault();
                setOverId(keyOf(entry, index));
              }}
              onDrop={(e) => {
                e.preventDefault();
                setOverId(null);
                if (canDrag) {
                  handleDrop(keyOf(entry, index));
                }
              }}
            >
              <ShotCard
                jobId={jobId}
                entry={entry}
                index={index}
                busy={busy}
                onChanged={onChanged}
                canDrag={canDrag}
                dragging={dragId === keyOf(entry, index)}
                onDragStart={() => setDragId(keyOf(entry, index))}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                onExpand={() => {
                  const li = lightIdxByKey.get(keyOf(entry, index));
                  if (li !== undefined) {
                    setLightIdx(li);
                  }
                }}
              />
            </div>
          ))}
        </div>
      )}
      <Lightbox items={lightItems} index={lightIdx} onIndex={setLightIdx} onClose={() => setLightIdx(null)} />
    </section>
  );
}

/** ShotCard 组件入参。 */
interface CardProps {
  jobId: string;
  entry: ShotArtifactEntry;
  index: number;
  busy: boolean;
  onChanged: () => void;
  canDrag: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** 打开灯箱（仅镜头有画面产物时传入）。 */
  onExpand?: () => void;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：单镜卡片——媒体缩略区 + 信息角标 + 折叠编辑抽屉 + 保存/重试（toast 反馈）。
 */
function ShotCard({
  jobId,
  entry,
  index,
  busy,
  onChanged,
  canDrag,
  dragging,
  onDragStart,
  onDragEnd,
  onExpand
}: CardProps) {
  const toast = useToast();
  const shotId = String(entry.shotId ?? `shot-${index + 1}`);
  const [form, setForm] = useState<ShotForm>(() => formOf(entry));
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
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
      return;
    }
    setSaving(true);
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
        toast.success(notes.length > 0 ? `镜头已保存：${notes.join("；")}` : "镜头已保存");
        onChanged();
      })
      .catch((err: Error) => toast.error(`保存失败：${err.message}`))
      .finally(() => setSaving(false));
  };

  const retry = (target: "asset" | "audio"): void => {
    api
      .retryShot(jobId, shotId, target)
      .then((res) => {
        toast.success(
          res.deleted.length > 0
            ? `已删除 ${res.deleted.join("、")}，任务重新排队执行${target === "asset" ? "素材" : "配音"}阶段`
            : `任务已重新排队执行${target === "asset" ? "素材" : "配音"}阶段`
        );
        onChanged();
      })
      .catch((err: Error) => toast.error(`重试失败：${err.message}`));
  };

  const assetFile = entry.files.video ?? entry.files.image ?? entry.files.manifestAsset;
  const duration = form.durationSeconds ? `${form.durationSeconds}s` : null;
  const metaChips = [
    { label: sbField(entry, "shotType"), title: "景别" },
    { label: sbField(entry, "transition"), title: "转场" },
    { label: sbField(entry, "assetSource"), title: "素材来源" }
  ].filter((c): c is { label: string; title: string } => Boolean(c.label));

  return (
    <article className={`shot-card${dragging ? " dragging" : ""}${open ? " editing" : ""}`}>
      <header className="shot-head">
        {canDrag && (
          <button
            className="drag-handle"
            draggable
            title="按住拖拽调整镜头顺序"
            aria-label="拖拽排序"
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              onDragStart();
            }}
            onDragEnd={onDragEnd}
          >
            <GripVertical size={15} />
          </button>
        )}
        <span className="shot-no">{index + 1}</span>
        <span className="shot-name" title={shotId}>
          {form.title || shotId}
        </span>
        <span className="shot-assets" title="产物齐备情况">
          <Video size={13} className={entry.files.video || entry.files.image || entry.files.manifestAsset ? "on" : ""} aria-label="画面" />
          <Mic size={13} className={entry.files.audio ? "on" : ""} aria-label="配音" />
        </span>
        <button
          className={`icon-btn edit-toggle${dirty() ? " dirty" : ""}`}
          aria-expanded={open}
          title={open ? "收起编辑" : "编辑本镜"}
          onClick={() => setOpen((v) => !v)}
        >
          <Pencil size={13} />
        </button>
      </header>
      <div className="shot-media">
        {entry.files.video ? (
          <>
            <video controls preload="metadata" src={fileUrl(jobId, entry.files.video)} />
            {onExpand && (
              <button className="icon-btn shot-expand" aria-label="放大播放本镜" onClick={onExpand}>
                <Maximize2 size={13} />
              </button>
            )}
          </>
        ) : assetFile ? (
          <img
            src={fileUrl(jobId, assetFile)}
            alt={shotId}
            loading="lazy"
            onClick={onExpand}
            title={onExpand ? "点击放大查看" : undefined}
          />
        ) : (
          <div className="shot-media-empty">
            <ImageIcon size={20} aria-hidden="true" />
            <span>尚无画面产物</span>
          </div>
        )}
        {duration && (
          <span className="shot-badge duration">
            <Clock size={11} aria-hidden="true" />
            {duration}
          </span>
        )}
      </div>
      {metaChips.length > 0 && (
        <div className="shot-badges">
          {metaChips.map((c) => (
            <Chip key={c.title} label={c.label} title={c.title} />
          ))}
        </div>
      )}
      {entry.files.audio && <audio controls preload="none" src={fileUrl(jobId, entry.files.audio)} />}
      {open && (
        <div className="shot-drawer">
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
        </div>
      )}
    </article>
  );
}
