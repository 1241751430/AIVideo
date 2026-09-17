/**
 * @file CostCard.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 计费确认卡：拉取 /cost-preview 展示四类能力的远端/本地归属与预计计费镜头数；全本地时给出免费提示。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useEffect, useState } from "react";
import type { CostPreview } from "@aivideo/shared";
import { api } from "../api";

const CAPABILITY_LABELS: Record<string, string> = {
  text: "文本生成",
  image: "图像生成",
  video: "视频生成",
  speech: "语音合成"
};

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：挂载时拉取计费预览并渲染明细表。
 */
export default function CostCard({ jobId }: { jobId: string }) {
  const [preview, setPreview] = useState<CostPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setError(null);
    api
      .costPreview(jobId)
      .then((res) => setPreview(res.preview))
      .catch((err: Error) => setError(err.message));
  }, [jobId]);

  return (
    <section className="card">
      <h2>计费预览</h2>
      {error && <div className="error-line">{error}</div>}
      {!preview && !error && <div className="muted">加载中…</div>}
      {preview && (
        <>
          {preview.anyRemote ? (
            <div className="checkpoint-hint" style={{ marginTop: 0 }}>
              以下能力将调用远端付费接口，确认后再继续。
            </div>
          ) : (
            <div className="notice">全部为本地能力，不产生远端费用。</div>
          )}
          <table className="cost-table">
            <thead>
              <tr>
                <th>能力</th>
                <th>提供者</th>
                <th>计费</th>
              </tr>
            </thead>
            <tbody>
              {preview.items.map((item) => (
                <tr key={item.capability}>
                  <td>{CAPABILITY_LABELS[item.capability] ?? item.capability}</td>
                  <td>{item.id}</td>
                  <td style={{ color: item.remote ? "var(--warn)" : "var(--ok)" }}>
                    {item.remote ? "远端·计费" : "本地·免费"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted" style={{ marginTop: 8 }}>
            预计逐镜生成 {preview.billableShots} 个镜头{preview.billableShots === 0 ? "（分镜尚未生成）" : ""}
          </div>
        </>
      )}
    </section>
  );
}
