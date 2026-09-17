/**
 * @file ScriptEditor.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 脚本元信息就地编辑器（Notion 式）：标题/摘要/开头钩子/旁白总稿/BGM/CTA/话题标签的表单编辑，仅提交发生变化的字段；镜头级字段的编辑在镜头墙完成（core 会双向同步）。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useState } from "react";
import type { ScriptMetaBody } from "@aivideo/shared";
import { api } from "../api";

/** 可编辑的脚本包（script.json 的松散形状）。 */
type ScriptLike = Record<string, unknown>;

const FIELDS: Array<{ key: keyof ScriptMetaBody; label: string; multiline?: boolean }> = [
  { key: "title", label: "标题" },
  { key: "summary", label: "摘要", multiline: true },
  { key: "openingHook", label: "开头钩子", multiline: true },
  { key: "voiceover", label: "旁白总稿", multiline: true },
  { key: "bgmStyle", label: "BGM 风格" },
  { key: "cta", label: "行动号召（CTA）" }
];

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染脚本元信息表单，diff 后保存并通知上层刷新。
 */
export default function ScriptEditor({
  jobId,
  script,
  busy,
  onSaved
}: {
  jobId: string;
  script: ScriptLike;
  busy: boolean;
  onSaved: () => void;
}) {
  const asString = (key: string): string => (typeof script[key] === "string" ? (script[key] as string) : "");
  const initial = (): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const field of FIELDS) {
      map[field.key] = asString(field.key);
    }
    return map;
  };
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [hashtags, setHashtags] = useState<string>(
    Array.isArray(script.hashtags) ? (script.hashtags as string[]).join(" ") : ""
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = (): void => {
    const patch: ScriptMetaBody = {};
    for (const field of FIELDS) {
      const next = values[field.key] ?? "";
      if (next !== asString(field.key)) {
        (patch as Record<string, unknown>)[field.key] = next;
      }
    }
    const nextTags = hashtags.split(/\s+/).filter(Boolean);
    const prevTags = Array.isArray(script.hashtags) ? (script.hashtags as string[]) : [];
    if (nextTags.join(" ") !== prevTags.join(" ")) {
      patch.hashtags = nextTags;
    }
    if (Object.keys(patch).length === 0) {
      setMessage("没有需要保存的修改");
      return;
    }
    setSaving(true);
    setMessage(null);
    api
      .updateScript(jobId, patch)
      .then(() => {
        setMessage("已保存，成片标记为待重新渲染");
        setValues(initial());
        onSaved();
      })
      .catch((err: Error) => setMessage(err.message))
      .finally(() => setSaving(false));
  };

  const scenes = Array.isArray(script.scenes) ? (script.scenes as Array<Record<string, unknown>>) : [];

  return (
    <section className="card">
      <h2>脚本</h2>
      <div className="script-form">
        {FIELDS.map((field) => (
          <label key={field.key} className="field">
            {field.label}
            {field.multiline ? (
              <textarea
                rows={2}
                disabled={busy}
                value={values[field.key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
            ) : (
              <input
                disabled={busy}
                value={values[field.key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
            )}
          </label>
        ))}
        <label className="field">
          话题标签（空格分隔）
          <input disabled={busy} value={hashtags} onChange={(e) => setHashtags(e.target.value)} />
        </label>
        <div className="actions">
          <button className="primary" disabled={busy || saving} onClick={save}>
            {saving ? "保存中…" : "保存脚本"}
          </button>
          {message && <span className={message.startsWith("已") ? "notice" : "muted"}>{message}</span>}
        </div>
      </div>
      {scenes.length > 0 && (
        <ul className="script-scenes">
          {scenes.map((scene, index) => (
            <li key={String(scene.id ?? index)}>
              {index + 1}. {String(scene.heading ?? scene.id ?? "")} —— {String(scene.narration ?? "")}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
