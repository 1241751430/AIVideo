/**
 * @file index.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 工作台前后端共享的线协议类型：任务状态机、事件记录、项目列表、工件快照、计费预览与系统摘要——apps/server 与 apps/web 以同一契约对话，任何一侧改形状都会在此处编译期暴露。
 * @see https://github.com/1241751430/AIVideo.git
 */

/** 产物模式：script 仅生成脚本与分镜；video 走完整流水线。 */
export type GenerationMode = "video" | "script";

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

/** GET /api/projects 列表条目：任务、无任务旧项目目录、或损坏隔离项。 */
export interface ProjectListItem {
  projectId: string;
  kind: "job" | "project" | "corrupt";
  job?: JobDto;
  title?: string;
  hasVideo?: boolean;
  updatedAt?: string;
}

/** 单镜产物文件引用（相对项目目录；不存在或非空校验失败为 null）。 */
export interface ShotFileRefs {
  video: string | null;
  image: string | null;
  audio: string | null;
  manifestAsset: string | null;
}

/** 镜头条：render-manifest 条目 + 对应分镜字段 + 实际存在的文件引用。 */
export interface ShotArtifactEntry extends Record<string, unknown> {
  storyboard: Record<string, unknown> | null;
  files: ShotFileRefs;
}

/** GET /api/projects/:id/artifacts 工件快照。 */
export interface ArtifactsSnapshot {
  brief: unknown;
  script: unknown;
  storyboard: { shots?: Array<Record<string, unknown>> } | null;
  manifest: { shots?: Array<Record<string, unknown>>; outputFile?: string } | null;
  shots: ShotArtifactEntry[];
  videoReady: boolean;
}

/** 单个能力的计费展示项。 */
export interface CostPreviewItem {
  capability: "text" | "image" | "video" | "speech";
  id: string;
  remote: boolean;
}

/** 计费预览结果（供 cost 检查点卡与开始前的确认展示）。 */
export interface CostPreview {
  items: CostPreviewItem[];
  /** 是否存在任何远端计费能力（全本地时 UI 可省略计费卡）。 */
  anyRemote: boolean;
  /** 预计逐镜生成的镜头数（分镜已存在时给出）。 */
  billableShots: number;
}

/** GET /api/skills 模板卡。 */
export interface SkillCard {
  id: string;
  name: string;
  description: string;
  suitableFor: string[];
  tone: string;
}

/** 服务端配置默认值摘要。 */
export interface DefaultsInfo {
  profile: string;
  aspectRatio: string;
  durationSeconds: number;
  language: string;
  platform: string;
  projectsDir: string;
  gpu?: boolean;
}

/** GET /api/summary 响应。 */
export interface SummaryResponse {
  activeProfile: string;
  profiles: string[];
  defaults: DefaultsInfo;
  providers: Record<CostPreviewItem["capability"], { id: string; remote: boolean } | null>;
  render: { gpu: boolean };
}

/** 检查点决策请求体。 */
export interface ReviewDecision {
  decision: "approve" | "cancel" | "redo-stage";
  stage?: StageKind;
}

/** 镜头编辑请求体（与 core ShotEditPatch 对齐）。 */
export interface ShotEditBody {
  title?: string;
  narration?: string;
  caption?: string;
  visualPrompt?: string;
  durationSeconds?: number;
}

/** 脚本元信息编辑请求体（与 core ScriptMetaPatch 对齐）。 */
export interface ScriptMetaBody {
  title?: string;
  summary?: string;
  openingHook?: string;
  voiceover?: string;
  bgmStyle?: string;
  cta?: string;
  hashtags?: string[];
}
