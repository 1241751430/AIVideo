/**
 * @file Skeleton.tsx
 * @author zhangbaohong
 * @date 2026-10-08
 * @description 骨架屏占位块：渐变微光的矩形条，供任务加载、计费预览拉取等异步空窗使用，取代裸「加载中…」文本。
 * @see https://github.com/1241751430/AIVideo.git
 */

/** Skeleton 组件入参。 */
interface Props {
  /** 高度（px 数字或合法 CSS 值）。 */
  height?: number | string;
  /** 宽度（默认 100%）。 */
  width?: number | string;
  /** 圆角变体：条状 / 块状。 */
  rounded?: "bar" | "block";
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染单个骨架块。
 */
export default function Skeleton({ height = 14, width = "100%", rounded = "bar" }: Props) {
  return <div className={`skeleton ${rounded}`} style={{ height, width }} aria-hidden="true" />;
}
