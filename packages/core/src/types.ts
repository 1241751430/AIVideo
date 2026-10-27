/**
 * @file types.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 核心领域类型定义：生成请求与 Provider 能力枚举、创作产物（简报/脚本包/分镜/字幕/渲染清单）结构、应用与 Provider 配置结构，以及文本/图片/视频/语音四类模型 Provider 的接口契约。
 * @see https://github.com/1241751430/AIVideo.git
 */

export type GenerationMode = "script" | "video";
export type ProviderCapability = "text" | "image" | "video" | "speech";

export interface GenerateRequest {
  theme?: string;
  content?: string;
  images?: string[];
  skill: string | "auto";
  mode: GenerationMode;
  aspectRatio: string;
  durationSeconds: number;
  language?: string;
  platform?: string;
  persistArtifacts?: boolean;
  cleanupAfterRender?: boolean;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  suitableFor: string[];
  tone: string;
  copyRules: string[];
  shotRules: string[];
  hooks: string[];
  ctas: string[];
  platformRules: Record<string, string[]>;
}

export interface BriefDocument {
  theme?: string;
  content?: string;
  inputImages: string[];
  selectedSkillId: string;
  selectedSkillName: string;
  language: string;
  platform: string;
  aspectRatio: string;
  durationSeconds: number;
  creativeDirection: string;
}

export interface ScriptScene {
  id: string;
  heading: string;
  narration: string;
  visualPrompt: string;
  shotType: string;
  durationSeconds: number;
  caption: string;
}

export interface ScriptPackage {
  title: string;
  summary: string;
  openingHook: string;
  voiceover: string;
  scenes: ScriptScene[];
  bgmStyle: string;
  cta: string;
  hashtags: string[];
}

export interface StoryboardShot {
  id: string;
  title: string;
  narration: string;
  caption: string;
  visualPrompt: string;
  shotType: string;
  durationSeconds: number;
  transition: string;
  assetSource: "reference_image" | "generated_image" | "title_card";
  /**
   * 参考镜绑定的 `brief.inputImages` 下标（按 id 绑定，不随镜头顺序漂移）。
   * 只有 assetSource=reference_image 的镜头有值；早期项目缺该字段时由读取方回退到镜头当前下标。
   */
  inputImageIndex?: number;
}

export interface Storyboard {
  aspectRatio: string;
  durationSeconds: number;
  shots: StoryboardShot[];
}

export interface CaptionCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface RenderShot {
  shotId: string;
  title: string;
  durationSeconds: number;
  assetKind: "image" | "video" | "generated-card";
  assetPath?: string;
  audioPath?: string;
  overlayText: string;
  caption: string;
  visualPrompt: string;
}

/**
 * 平板视图：读盘（`readRenderManifestFile`）后进程内统一使用的形状，
 * 由磁盘上的 `RenderManifestFile.input` + `RenderManifestFile.state` 拼成；
 * 老项目（顶层直接是 shots 数组）也归一化成这个形状。
 */
export interface RenderManifest {
  aspectRatio: string;
  width: number;
  height: number;
  durationSeconds: number;
  bgmStyle: string;
  outputFile: string;
  captionsFile: string;
  shots: RenderShot[];
}

/** 渲染入参：每镜真正决定成片内容的字段（改它们必须重渲）。 */
export interface RenderShotInput {
  shotId: string;
  title: string;
  durationSeconds: number;
  overlayText: string;
  caption: string;
  visualPrompt: string;
}

/** 执行状态：素材/配音阶段原地写入的结果，按 shotId 绑定（重排镜头只动 input.shots，状态天然跟随）。 */
export interface RenderShotState {
  assetKind: RenderShot["assetKind"];
  assetPath?: string;
  audioPath?: string;
}

/**
 * render-manifest.json 的磁盘结构（v1）：入参（input）与执行状态（state）分节，
 * 重渲染时能一眼看出哪些字段是「用户/上游声明的输入」、哪些是「上一轮跑出来的结果」。
 * 输出路径（outputFile/captionsFile）属于入参的一部分——它们决定写到哪里，但不决定成片内容。
 */
export interface RenderManifestFile {
  version: number;
  input: {
    aspectRatio: string;
    width: number;
    height: number;
    durationSeconds: number;
    bgmStyle: string;
    outputFile: string;
    captionsFile: string;
    shots: RenderShotInput[];
  };
  state: {
    shots: Record<string, RenderShotState>;
  };
}

export interface ProviderConfig {
  type: string;
  capability: ProviderCapability;
  vendor?: string;
  enabled?: boolean;
  baseURL?: string;
  allowCustomBaseURL?: boolean;
  apiKeyEnv?: string;
  /** Secondary credential env (e.g. Volcengine speech console appid). */
  appIdEnv?: string;
  modelEnv?: string;
  model?: string;
  description?: string;
  sizeMap?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

export interface ProviderProfileConfig {
  text?: string;
  image?: string;
  video?: string;
  speech?: string;
}

export interface AppConfig {
  defaults: {
    profile: string;
    aspectRatio: string;
    durationSeconds: number;
    language: string;
    platform: string;
    projectsDir: string;
    gpu?: boolean;
  };
  providers: Record<string, ProviderConfig>;
  profiles: Record<string, ProviderProfileConfig>;
}

export interface ProviderHealth {
  providerId: string;
  capability: ProviderCapability;
  ok: boolean;
  message: string;
  liveChecked: boolean;
}

export interface TextGenerationRequest {
  systemPrompt: string;
  userPrompt: string;
}

export interface TextModelProvider {
  readonly id: string;
  readonly capability: "text";
  readonly isRemote: boolean;
  test(options?: { live?: boolean }): Promise<ProviderHealth>;
  generateText(request: TextGenerationRequest): Promise<string>;
}

export interface ImageGenerationRequest {
  prompt: string;
  outputPath: string;
  referenceImages?: string[];
  width?: number;
  height?: number;
  aspectRatio?: string;
}

export interface ImageModelProvider {
  readonly id: string;
  readonly capability: "image";
  readonly isRemote: boolean;
  test(options?: { live?: boolean }): Promise<ProviderHealth>;
  generateImage(request: ImageGenerationRequest): Promise<{ outputPath: string }>;
}

export interface VideoGenerationRequest {
  prompt: string;
  durationSeconds: number;
  outputPath: string;
  aspectRatio?: string;
  /**
   * Local image files to condition the generation on (image-to-video).
   * Providers that support a first-frame input use the first entry;
   * providers that don't ignore the field. Callers must only pass files they
   * trust to be uploaded (project assets or user-supplied reference images).
   */
  referenceImagePaths?: string[];
}

export interface VideoModelProvider {
  readonly id: string;
  readonly capability: "video";
  readonly isRemote: boolean;
  test(options?: { live?: boolean }): Promise<ProviderHealth>;
  generateVideo(request: VideoGenerationRequest): Promise<{ outputPath: string }>;
}

export interface SpeechGenerationRequest {
  text: string;
  outputPath: string;
  voice?: string;
}

export interface SpeechProvider {
  readonly id: string;
  readonly capability: "speech";
  readonly isRemote: boolean;
  test(options?: { live?: boolean }): Promise<ProviderHealth>;
  synthesizeSpeech(request: SpeechGenerationRequest): Promise<{ outputPath: string }>;
}

export interface ProviderSelection {
  text?: TextModelProvider;
  image?: ImageModelProvider;
  video?: VideoModelProvider;
  speech?: SpeechProvider;
}

export interface ProjectArtifacts {
  skill: SkillDefinition;
  brief: BriefDocument;
  script: ScriptPackage;
  storyboard: Storyboard;
  captions: CaptionCue[];
  renderManifest: RenderManifest;
}
