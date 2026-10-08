/**
 * @file Stepper.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 流水线进度 stepper：脚本→素材→旁白→渲染四节点，guided 模式在脚本后加计费检查点菱形闸；节点间渐变连接线按完成度填充，底部进度条与百分比由前端依据阶段与镜头产物完成度估算（SSE 无服务端进度字段，文案与 tooltip 均如实标注）。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { Check, TriangleAlert, Zap } from "lucide-react";
import type { JobDto, ShotArtifactEntry } from "@aivideo/shared";
import { STAGES, STAGE_LABELS, stepperIndex } from "../labels";

/** Stepper 组件入参。 */
interface Props {
  job: JobDto;
  /** 镜头工件列表：用于派生素材/旁白完成度。 */
  shots: ShotArtifactEntry[];
}

/** 单个节点的渲染描述。 */
interface NodeSpec {
  key: string;
  label: string;
  cls: "done" | "current" | "error" | "";
  /** 计费闸用菱形节点呈现。 */
  gate?: boolean;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：统计镜头中具备某类产物的比例（总数为 0 时返回 0）。
 */
function fileRatio(shots: ShotArtifactEntry[], pick: (entry: ShotArtifactEntry) => string | null): number {
  if (shots.length === 0) {
    return 0;
  }
  const ready = shots.filter((entry) => Boolean(pick(entry))).length;
  return ready / shots.length;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：按阶段与镜头产物数派生估算进度百分比与说明文案。
 */
function deriveProgress(job: JobDto, shots: ShotArtifactEntry[]): { percent: number; note: string | null } {
  const total = shots.length;
  if (job.phase === "done") {
    return { percent: 100, note: null };
  }
  if (job.phase === "queued") {
    return { percent: 0, note: job.queuePosition ? `队列第 ${job.queuePosition} 位` : null };
  }
  if (job.phase === "awaiting" && job.checkpoint) {
    const byCheckpoint: Record<string, { percent: number; note: string }> = {
      script: { percent: 8, note: "等待脚本评审" },
      cost: { percent: 10, note: "等待计费确认" },
      shots: { percent: 70, note: "等待镜头墙审阅" },
      audio: { percent: 90, note: "等待旁白试听" },
      final: { percent: 97, note: "等待成片验收" }
    };
    const hit = byCheckpoint[job.checkpoint];
    if (hit) {
      return hit;
    }
  }
  const stageBase: Record<string, { percent: number; note: (ratio: number) => string }> = {
    script: { percent: 5, note: () => "脚本生成中" },
    assets: { percent: 10, note: (r) => `画面 ${Math.round(r * 100)}%` },
    audio: { percent: 70, note: (r) => `配音 ${Math.round(r * 100)}%` },
    render: { percent: 92, note: () => "合成渲染中" }
  };
  const stage = job.stage ?? "script";
  const spec = stageBase[stage] ?? { percent: 5, note: () => "" };
  if (job.phase === "failed" || job.phase === "cancelled") {
    return { percent: spec.percent, note: job.phase === "failed" ? "已中断" : "已取消" };
  }
  let ratio = 0;
  let span = 0;
  if (stage === "assets") {
    ratio = fileRatio(shots, (e) => e.files.video ?? e.files.image ?? e.files.manifestAsset);
    span = 60;
  }
  if (stage === "audio") {
    ratio = fileRatio(shots, (e) => e.files.audio);
    span = 20;
  }
  return { percent: Math.min(99, Math.round(spec.percent + span * ratio)), note: spec.note(ratio) };
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染五/四节点进度条与派生进度（guided 模式含计费闸）。
 */
export default function Stepper({ job, shots }: Props) {
  const current = stepperIndex(job.phase, job.stage, job.checkpoint);
  const nodes: NodeSpec[] = [];
  STAGES.forEach((stage, index) => {
    const cls: NodeSpec["cls"] =
      index < current ? "done" : index === current ? (job.phase === "failed" ? "error" : "current") : "";
    nodes.push({ key: stage, label: STAGE_LABELS[stage], cls });
    if (job.execMode === "guided" && index === 0) {
      const gateDone = current >= 2;
      nodes.push({
        key: "cost",
        label: "计费",
        gate: true,
        cls: gateDone ? "done" : job.checkpoint === "cost" ? "current" : ""
      });
    }
  });
  const { percent, note } = deriveProgress(job, shots);

  return (
    <div className="stepper">
      <div className="stepper-nodes" aria-label="流水线进度">
        {nodes.map((node, index) => {
          const prevDone = index > 0 && nodes[index - 1]?.cls === "done";
          return (
            <span key={node.key} style={{ display: "contents" }}>
              {index > 0 && <span className={`link${prevDone ? " filled" : ""}`} aria-hidden="true" />}
              <span className={`node ${node.cls}${node.gate ? " gate" : ""}`}>
                <span className="node-dot">
                  {node.cls === "done" ? (
                    <Check size={10} aria-hidden="true" />
                  ) : node.cls === "error" ? (
                    <TriangleAlert size={10} aria-hidden="true" />
                  ) : node.gate ? (
                    <Zap size={10} aria-hidden="true" />
                  ) : null}
                </span>
                <span className="node-label">{node.label}</span>
              </span>
            </span>
          );
        })}
      </div>
      <div
        className="stepper-prog"
        title="进度由前端按阶段与镜头产物完成度估算，非服务端精确值"
      >
        <div className="prog-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className={`prog-fill${job.phase === "running" ? " live" : ""}`} style={{ width: `${percent}%` }} />
        </div>
        <span className="prog-num">{percent}%</span>
        {note && <span className="prog-note">{note}</span>}
      </div>
    </div>
  );
}
