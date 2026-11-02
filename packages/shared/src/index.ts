/**
 * @file index.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 工作台前后端共享的线协议：任务状态机、事件记录、项目列表、工件快照与系统摘要——apps/server 与 apps/web 以同一契约对话，任何一侧改形状都会在此处编译期暴露；
 * 另含少量随契约一起下发的数值上限（如参考图张数/单张字节数），前端预校验与服务端硬校验读同一个常量，不会各写一个数字然后慢慢走偏。
 * @see https://github.com/1241751430/AIVideo.git
 */

/**
 * 参考图数量上限（0 起序号，即合法序号为 0..MAX_INPUT_IMAGES-1）。
 * 放在 shared 而不是 core：web 只依赖 shared、够不到 core，而前端在选图阶段就要校验；
 * core 的 validateGenerateRequest 反向依赖本常量，保证「上传收得下」与「生成校验过得去」是同一个数字。
 */
export const MAX_INPUT_IMAGES = 20;

/**
 * 单张参考图的字节上限：10MB。
 * 语义是「一次上传落盘的单张体积」，与 core 的 MAX_LOCAL_IMAGE_BYTES（本地文件校验口径）数值相同但彼此独立，
 * 将来若要分别调整（例如 CDN 直传放宽单张），不会牵一发动全身。
 */
export const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * 单个背景音乐文件的字节上限：20MB。
 * 语义是「一次 BGM 上传落盘的体积」，与参考图的 10MB 上限彼此独立——音频动辄数分钟，
 * 按图的口径卡会误伤正常曲目；将来若要给 BGM 单独放宽（例如直传对象存储），改这一个数字即可。
 */
export const MAX_BGM_BYTES = 20 * 1024 * 1024;

/** 产物模式：script 仅生成脚本与分镜；video 走完整流水线。 */
export type GenerationMode = "video" | "script";

/** 执行模式：auto 一路直行；guided 在每个阶段产物后暂停等待检查点确认。 */
export type ExecMode = "auto" | "guided";

/** 流水线阶段（与 job.json 状态机的 running.stage 对应）。 */
export type StageKind = "script" | "assets" | "audio" | "render";

/** guided 模式的检查点：脚本评审、镜头墙、旁白试听、成片验收（与四个阶段一一对应）。 */
export type CheckpointKind = "script" | "shots" | "audio" | "final";

/** provider 能力维度：文案 / 图片 / 视频 / 旁白 / 音乐。系统摘要与能力徽章共用这一组键。 */
export type Capability = "text" | "image" | "video" | "speech" | "music";

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
  /** 用户给出的整段台词：脚本阶段必须以 `src: "user"` 原样进 lines，绝不改写。缺省时产物与没有该字段时一致。 */
  dialogue?: string;
  /**
   * 创建时上传的参考图落盘绝对路径（project/<id>/input/<n>.<ext>）。
   * 字段名在链路上换了三次，但始终是同一个有序列表（下标即镜头绑定关系，重排不换图）：
   * 线协议 inputImagePaths → GenerateRequest.images（服务端 toGenerateRequest）→ brief.inputImages（落盘 brief.json）。
   */
  inputImagePaths?: string[];
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
  /**
   * 显式重跑信号：等于某阶段时，该阶段不得走「输入指纹未变就跳过」的续跑复用。
   * 「要不要重跑」由调用方显式声明，不从产物是否存在反推；四个阶段都会消费它。
   */
  force?: StageKind;
  /**
   * 本次运行的终点阶段：只执行 resumeStage→endStage 这一段，到达终点即收尾为 done。
   * 镜头重试/重新渲染靠它把「重做目标阶段」和「跑完整条链」区分开；缺省表示跑到底。
   */
  endStage?: StageKind;
  /**
   * 失败/取消时的断点阶段：任务停在哪一段。仅在 failed/cancelled 态有值，供「继续」入口定位续跑起点；
   * 重新入队（beginRun）即清除，因为它描述的是「当前这次没有再跑下去」，不是历史记录。
   */
  breakStage?: StageKind;
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
  /**
   * 这一镜素材的来源声明（`AssetProvenance` 原样透传，未经前端收窄）。
   * 它随 render-manifest 条目一起回来；分镜被瘦身删掉、只剩清单时，界面靠它兜底。
   * 保持 `Record<string, unknown> | null` 而不是在这里复刻 core 的类型：web 只依赖 shared，
   * 展示层另有 labels.ts 的 `parseProvenance` 做严格收窄，共享包不该替 UI 决定要哪些字段。
   */
  provenance?: Record<string, unknown> | null;
  files: ShotFileRefs;
}

/**
 * 本片画面的实际来源模式，供工作台顶部给出「你现在看到的是什么」的常驻提示。
 * - `generated`：每一镜都有真实画面（模型生成的图/视频，或用户给的参考图）；
 * - `mixed`：部分镜头只有标题卡占位，其余是真实画面；
 * - `title-card`：全部镜头都是标题卡占位（默认配置下没启用 image/video 提供者时就是这种）。
 *
 * 只回答「有没有真实画面」，不回答「这张图是谁画的」——后者是镜头里的 `provenance`。
 * 刻意不区分「用户参考图」与「模型生成」：两者都是真实画面，混在一句话里只会让提示更难懂。
 */
export type AssetMode = "generated" | "mixed" | "title-card";

/** GET /api/projects/:id/artifacts 工件快照。 */
export interface ArtifactsSnapshot {
  brief: unknown;
  script: unknown;
  /**
   * 全片 BGM 的来源声明（`script.json` 的 `bgmProvenance`）。
   * 它与 script 是同一份数据，但交付面板要在「BGM 那一行」和「素材来源清单」两处独立渲染，
   * 由服务端抬到顶层，前端就不必每处都对 `script` 做一次 `as` 断言。未登记时为 null。
   */
  bgmProvenance: Record<string, unknown> | null;
  storyboard: { shots?: Array<Record<string, unknown>> } | null;
  manifest: { shots?: Array<Record<string, unknown>>; outputFile?: string; captionsFile?: string } | null;
  /**
   * 本片画面的实际来源模式，由服务端按 render-manifest 里每镜的 `assetKind` 推导。
   * 脚本模式（`generationMode === "script"`）不产画面、或清单里还没有镜头时为 null——那时没有「画面模式」可谈，
   * 前端据此不渲染提示，不把「无镜头」当成「全是标题卡」。
   */
  assetMode: AssetMode | null;
  shots: ShotArtifactEntry[];
  /**
   * 项目自定义背景音乐的项目内相对路径（如 `audio/bgm.mp3`）；没有则 null。
   * 只回路径不回字节：试听走 /api/projects/:id/file?path=…，与成片/素材同一条读取通道。
   */
  bgm: string | null;
  videoReady: boolean;
  /** 项目根下的 script.md 是否在盘（交付面板据此决定是否给出下载入口）。 */
  scriptMdReady: boolean;
  /** captions/captions.srt 是否在盘。 */
  captionsReady: boolean;
  /**
   * 上一版成片（重渲覆盖前的备份）是否在盘。
   * 重渲是覆盖式操作，只留一个备份槽位（output/final.prev.mp4），不建版本树。
   */
  previousVideoReady: boolean;
  /** 上一版成片的项目内相对路径；不在盘时为 null。 */
  previousVideoFile: string | null;
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
  providers: Record<Capability, { id: string; remote: boolean } | null>;
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
  /**
   * 镜内台词，整组替换（不是逐条合并）。传空数组即清空该镜台词，回到「只念 narration」。
   * 形状与 core 的 ScriptLine 一致，但 shared 不依赖任何包，故内联声明：
   * `src: "user"` 是用户原文，界面必须只读展示、不得让它被改写。
   */
  lines?: Array<{ speaker?: string; text: string; src: "user" | "generated" }>;
  /** 逐镜音色覆盖；传空串表示清除覆盖，回到「角色音色 → provider 默认」。 */
  voice?: string;
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

/** POST /api/projects/:id/open-folder 响应：本机打开文件管理器；容器环境降级返回宿主路径提示。 */
export interface OpenFolderResponse {
  ok: boolean;
  /** 项目目录绝对路径。 */
  path: string;
  /** 打开失败或容器降级时的操作提示。 */
  hint?: string;
}
