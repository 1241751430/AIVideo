/**
 * @file TopBar.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 玻璃顶栏：左侧渐变字品牌标，右侧挂服务健康灯与 provider 状态徽章组（ProviderStatus）。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { Clapperboard } from "lucide-react";
import type { SummaryResponse } from "@aivideo/shared";
import ProviderStatus from "./ProviderStatus";

/** TopBar 组件入参。 */
interface Props {
  summary: SummaryResponse | null;
  warnings: string[];
  serviceOk: boolean;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染应用顶栏。
 */
export default function TopBar({ summary, warnings, serviceOk }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <Clapperboard size={18} className="brand-mark" aria-hidden="true" />
        <span className="brand-name">镜头墙工作台</span>
      </div>
      <ProviderStatus summary={summary} warnings={warnings} serviceOk={serviceOk} />
    </header>
  );
}
