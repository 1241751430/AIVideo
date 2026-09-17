/**
 * @file types.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 工作台服务的领域类型：任务（Job）与阶段/检查点/状态机枚举、创建项目入参、事件记录、以及对外 API 的 DTO 形状。
 * @see https://github.com/1241751430/AIVideo.git
 */
import type { GenerationMode } from "@aivideo/core";

/** 执行模式：auto 一路直行；guided 在每个阶段产物后暂停等待检查点确认。 */
export type ExecMode = "auto" | "guided";

/** 流水线阶段（与 job.json 状态机的 running.stage 对应）。 */
export type StageKind = "script" | "assets" | "audio" | "render";

/** guided 模式的检查点：脚本评审、计费确认、镜头墙、旁白试听、成片验收。 */
export type CheckpointKind = "script" | "cost" | "shots" | "audio" | "final";

/** 任务状态机的宏阶段。 */
export type JobPhase = "queued" | "running" | "awaiting" | "done" | "failed" | "cancelled";

/**
 * POST /api/projects 归一化后的创建入参（服务端从 brief 文本 + 显式字段合成）。
 * 落盘进 job.json，供重启后原样重放。
 */
export interface JobRequest {
  theme?: string;
  content?: string;
  generationMode: GenerationMode;
  skill: string;
  aspectRatio: string;
  durationSeconds: number;
  language?: string;
  platform?: string;
  providerProfile?: string;
}

/** 落盘于 project/<id>/job.json 的任务实体。 */
export interface Job {
  id: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  execMode: ExecMode;
  phase: JobPhase;
  /** phase=running 时所在的流水线阶段。 */
  stage?: StageKind;
  /** phase=awaiting 时正在等待确认的检查点。 */
  checkpoint?: CheckpointKind;
  request: JobRequest;
  /** 排队/恢复时要从哪个阶段继续；缺省表示从 script 开始。boot 恢复与检查点推进都靠它定位断点。 */
  resumeStage?: StageKind;
  /** done 之后又编辑了产物时为真，UI 提示重新渲染。 */
  result?: { videoStale?: boolean };
  /** phase=failed 的错误摘要。 */
  error?: string;
}

/** events.jsonl 中的单条事件；id 单调递增，SSE Last-Event-ID 依据它重放。 */
export interface EventRecord {
  id: number;
  at: string;
  type: "status" | "log";
  data: Record<string, unknown>;
}

/** API 返回的任务视图：Job 实体 + 服务端派生字段。 */
export interface JobDto extends Job {
  /** 排队中时的队列位次（1 起），不在队列为 undefined。 */
  queuePosition?: number;
  /** 项目目录是否存在（boot 隔离的损坏任务为 false）。 */
  hasProjectDir: boolean;
  /** job.json 无法解析等损坏情况的标记，UI 需隔离展示。 */
  corrupt?: boolean;
}
