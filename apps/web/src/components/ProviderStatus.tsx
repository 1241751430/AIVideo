/**
 * @file ProviderStatus.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 顶栏服务与模型状态徽章组：服务健康灯、四能力（文案/图片/视频/旁白）本地-远端计费点、GPU 标记与配置告警汇总，数据源为 /api/summary 与 /api/healthz。
 * @see https://github.com/1241751430/AIVideo.git
 */
import type { CostPreviewItem, SummaryResponse } from "@aivideo/shared";
import { Image, Mic, TriangleAlert, Type, Video, Zap } from "lucide-react";

/** ProviderStatus 组件入参。 */
interface Props {
  summary: SummaryResponse | null;
  warnings: string[];
  serviceOk: boolean;
}

/** 四能力与图标的对应（键即 SummaryResponse.providers 的字段）。 */
const CAPABILITIES: Array<{ key: CostPreviewItem["capability"]; label: string; Icon: typeof Type }> = [
  { key: "text", label: "文案", Icon: Type },
  { key: "image", label: "图片", Icon: Image },
  { key: "video", label: "视频", Icon: Video },
  { key: "speech", label: "旁白", Icon: Mic }
];

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染服务健康灯 + provider 能力徽章 + GPU/告警标记；徽章 title 给出 provider id 与计费属性。
 */
export default function ProviderStatus({ summary, warnings, serviceOk }: Props) {
  return (
    <div className="provider-status" aria-label="服务与模型状态">
      <span
        className={`service-dot ${serviceOk ? "ok" : "down"}`}
        role="img"
        title={serviceOk ? "服务正常" : "服务不可达"}
        aria-label={serviceOk ? "服务正常" : "服务不可达"}
      />
      {CAPABILITIES.map(({ key, label, Icon }) => {
        const provider = summary?.providers[key] ?? null;
        const title = provider ? `${label}：${provider.id}${provider.remote ? " · 远端（计费）" : " · 本地（免费）"}` : `${label}：未配置`;
        return (
          <span key={key} className={`cap-chip ${provider ? (provider.remote ? "remote" : "local") : "none"}`} title={title}>
            <Icon size={13} />
            <span className="cap-name">{label}</span>
            <span className="cap-dot" />
          </span>
        );
      })}
      {summary?.render.gpu && (
        <span className="cap-chip local" title="GPU 硬件编码已启用">
          <Zap size={13} />
          <span className="cap-name">GPU</span>
        </span>
      )}
      {warnings.length > 0 && (
        <span className="warn-badge" title={warnings.join("\n")} role="img" aria-label={`${warnings.length} 条配置告警`}>
          <TriangleAlert size={13} />
          {warnings.length}
        </span>
      )}
    </div>
  );
}
