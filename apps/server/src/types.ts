/**
 * @file types.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 工作台服务的领域类型：统一 re-export @aivideo/shared 的线协议定义（任务状态机、事件记录、DTO、工件快照、计费预览），服务端不再各自维护副本。
 * @see https://github.com/1241751430/AIVideo.git
 */
export type {
  GenerationMode,
  ExecMode,
  StageKind,
  CheckpointKind,
  JobPhase,
  JobRequest,
  Job,
  EventRecord,
  JobDto,
  ProjectListItem,
  ShotFileRefs,
  ShotArtifactEntry,
  ArtifactsSnapshot,
  CostPreviewItem,
  CostPreview,
  SkillCard,
  DefaultsInfo,
  SummaryResponse,
  ReviewDecision,
  ShotEditBody,
  ScriptMetaBody
} from "@aivideo/shared";
