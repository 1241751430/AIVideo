/**
 * @file CostCard.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 计费确认卡：拉取 /cost-preview 以徽章卡网格展示四类能力的 provider 归属与计费状态（远端·计费琥珀 / 本地·免费绿色），全本地时给出免费提示；骨架屏覆盖拉取空窗。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useEffect, useState } from "react";
import { Image as ImageIcon, Mic, Type, Video, Zap } from "lucide-react";
import type { CostPreview } from "@aivideo/shared";
import { api } from "../api";
import Skeleton from "./Skeleton";

const CAPABILITY_META: Record<string, { label: string; icon: typeof Type }> = {
  text: { label: "文本生成", icon: Type },
  image: { label: "图像生成", icon: ImageIcon },
  video: { label: "视频生成", icon: Video },
  speech: { label: "语音合成", icon: Mic }
};

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：挂载时拉取计费预览并渲染徽章卡网格。
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
      <h2>
        <Zap size={15} className="h2-ico" aria-hidden="true" />
        计费预览
      </h2>
      {error && <div className="error-line">{error}</div>}
      {!preview && !error && (
        <div className="cost-grid">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={56} rounded="block" />
          ))}
        </div>
      )}
      {preview && (
        <>
          {preview.anyRemote ? (
            <div className="checkpoint-hint" style={{ marginTop: 0 }}>
              以下能力将调用远端付费接口，确认后再继续。
            </div>
          ) : (
            <div className="notice">全部为本地能力，不产生远端费用。</div>
          )}
          <div className="cost-grid">
            {preview.items.map((item) => {
              const meta = CAPABILITY_META[item.capability] ?? { label: item.capability, icon: Zap };
              const Icon = meta.icon;
              return (
                <div key={item.capability} className={`cost-item${item.remote ? " remote" : ""}`}>
                  <span className="cost-ico">
                    <Icon size={16} aria-hidden="true" />
                  </span>
                  <div className="cost-body">
                    <div className="cost-cap">{meta.label}</div>
                    <div className="muted cost-id" title={item.id}>
                      {item.id}
                    </div>
                  </div>
                  <span className={`badge ${item.remote ? "stale" : "done"}`}>{item.remote ? "远端·计费" : "本地·免费"}</span>
                </div>
              );
            })}
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            预计逐镜生成 {preview.billableShots} 个镜头{preview.billableShots === 0 ? "（分镜尚未生成）" : ""}
          </div>
        </>
      )}
    </section>
  );
}
