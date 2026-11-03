/**
 * @file types.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 核心领域类型定义：生成请求与 Provider 能力枚举、创作产物（简报/脚本包/分镜/字幕/渲染清单）结构、应用与 Provider 配置结构，以及文本/图片/视频/语音/音乐五类模型 Provider 的接口契约。
 * @see https://github.com/1241751430/AIVideo.git
 */

export type GenerationMode = "script" | "video";
export type ProviderCapability = "text" | "image" | "video" | "speech" | "music";

export interface GenerateRequest {
  theme?: string;
  content?: string;
  images?: string[];
  /**
   * 用户给出的整段台词（可多句、可带换行）。**逐字对待**：不做 trim 之外的任何改写，
   * 脚本阶段必须以 `src: "user"` 原样放进对应镜头的 `lines`。缺省时行为与未引入该字段时一致。
   */
  dialogue?: string;
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
  /** 用户提供的整段台词；有值时脚本提示词会要求「逐字放进 lines 且 src=user」。 */
  dialogue?: string;
  selectedSkillId: string;
  selectedSkillName: string;
  language: string;
  platform: string;
  aspectRatio: string;
  durationSeconds: number;
  creativeDirection: string;
}

/**
 * 剧本角色。id 由模型给出（也可以用角色名归一），它只是 `ScriptLine.speaker` 的引用键，
 * 因此允许大小写与 `_`/`-`，**不能过 slugify**（那会把大小写与合法符号抹平，导致 speaker 对不上）。
 */
export interface ScriptRole {
  id: string;
  name: string;
  /** 该角色的音色标识（随提供者而异，如 "Tingting"）；缺省时按镜头/配置档默认回落。 */
  voice?: string;
  /** 外观描述，会被拼进该角色出场镜头的 visualPrompt（一致性取决于图像模型）。 */
  appearance?: string;
}

/**
 * 镜内台词。`text` 是**成句的原文**，渲染时直接交给语音合成，因此 `src: "user"` 的台词必须与用户输入逐字节相等
 * （不 trim 内容内部、不改标点）。`speaker` 指向 `ScriptPackage.roles[].id`，对不上时归一化会丢弃该字段而不是丢整句。
 */
export interface ScriptLine {
  speaker?: string;
  text: string;
  src: "user" | "generated";
}

/**
 * 素材版权溯源。它是**对外交付物的一部分**：片子发出去以后，观众/平台有权利知道某个画面是哪来的。
 *
 * 硬约束（见 `normalizeScriptPackage` / `buildRenderManifest` 的校验）：**无许可的素材一律不进分镜**。
 * `kind === "stock"` 必须同时给出 `sourceUrl` 与 `license`，缺一个就拒绝整份脚本/清单，而不是静默降级成标题卡——
 * 「误导比缺失更伤信任」：一片没有标注来源的素材，用户会以为是自己可以随便用的。
 */
export interface AssetProvenance {
  /** 来源类别：用户上传 / AI 生成 / 网络库存素材 / 本地素材库。 */
  kind: "user_uploaded" | "ai_generated" | "stock" | "library";
  /** 生成方/来源方 id，如 "openai-compatible-image"、"pexels"；`ai_generated` 时必填。 */
  provider?: string;
  /** 许可证标识，如 "CC0-1.0"、"CC-BY-4.0"、"provider-terms"；`stock` 时必填，`user_uploaded` 缺省为 "user-provided"。 */
  license?: string;
  /** 原始出处链接；`stock` 时必填（没有出处的网络素材无法核对许可）。 */
  sourceUrl?: string;
  /** 展示用署名文本，如 "Photo by Jane Doe / Pexels"。 */
  attribution?: string;
  /** 获取时间（ISO 8601），用于许可证版本追溯。 */
  retrievedAt?: string;
}

export interface ScriptScene {
  id: string;
  heading: string;
  narration: string;
  visualPrompt: string;
  shotType: string;
  durationSeconds: number;
  caption: string;
  /**
   * 镜内对白。**为空数组或缺失时，该镜的一切行为与引入台词之前完全相同**（旁白取 `narration`）。
   * 有值时 `narration` 退居「旁白/画外音」，配音顺序为 lines 在前、narration 在后。
   */
  lines?: ScriptLine[];
  /** 本镜画面的来源声明（模型可给出）；归一化时按 [[AssetProvenance]] 的硬约束校验后带到分镜。 */
  provenance?: AssetProvenance;
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
  /** 角色表（最多 4 个，id 唯一）。缺省或空时台词只保留 `text`，不引用音色。 */
  roles?: ScriptRole[];
  /**
   * 全片 BGM 的来源声明。用户上传的曲子走 `kind: "user_uploaded"`；音乐提供者生成的走 `ai_generated`
   * （`provider` 必填）。缺省时视为「未声明」——交付面板与 `script.md` 会显示为未知来源，而不是编一个。
   */
  bgmProvenance?: AssetProvenance;
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
  /**
   * 镜内台词，由 `script.json` 的 `scenes[].lines` 原样带下来。**缺失或为空时该镜行为与引入台词之前完全相同**
   * （配音只念 `narration`）；有值时 `lines` 在前、`narration` 作为旁白/画外音在后，合成进同一个 `audio/<id>.wav`。
   * 字段按需展开写入：无台词的镜头不落这个键，故事 board.json 与今天逐字节相同。
   */
  lines?: ScriptLine[];
  /** 逐镜覆盖音色；缺省时先按 `lines[].speaker` 找角色音色，再交给 provider 的默认音色。 */
  voice?: string;
  /**
   * 该镜画面的来源声明，由 `script.json` 的 `scenes[].provenance` 原样带下来。
   * 与 [[StoryboardShot.lines]] 同样按需展开：没有声明就不落这个键，storyboard.json 与今天逐字节相同。
   */
  provenance?: AssetProvenance;
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
  /**
   * 本镜与下一镜之间的转场：`cut` 为硬切，其余（含缺省）按 `fade` 淡出。
   * 由分镜的 `transition` 直接带下来，渲染器据此决定是否在镜尾叠淡出；
   * 老清单没有该字段 ⇒ 恒按 `fade`，成片与升级前逐帧一致。
   */
  transition?: string;
  /** 该镜画面的来源声明，随清单落盘，交付面板与导出文稿据此展示版权信息。 */
  provenance?: AssetProvenance;
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
  /**
   * 转场（`cut` / `fade`）。它决定成片怎么剪，属于「声明的输入」而非执行结果，
   * 与 visualPrompt 同处 input 分节，素材阶段重写清单时必须原样带回去。
   */
  transition?: string;
  /**
   * 该镜画面的来源声明（来自分镜）。它是「声明的输入」而非执行结果，因此与 visualPrompt 同处 input 分节——
   * 素材阶段重写清单时必须原样带回去，否则来源信息会在第一次跑素材时凭空消失。
   */
  provenance?: AssetProvenance;
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
  /**
   * 图片提供者：参考图（图生图）在请求体里的字段名，例如 Ark Seedream 的 `image`。
   * 只有显式声明才会下发——OpenAI 官方 /images/generations 不接受该字段，
   * 无条件带上会让原本能用的纯文生图配置直接 400。
   */
  referenceImageField?: string;
  /**
   * 视频提供者如何消费参考图：
   * - `first_frame`（缺省）：1 张作首帧，2 张作首帧 + 尾帧；
   * - `reference_image`：每张都以参考图下发，仅 Seedance 2.0 / 2.5 系列支持。
   * 两者互斥，混用会被 API 拒绝，所以由配置而不是代码猜模型系列。
   */
  referenceImageRole?: "first_frame" | "reference_image";
  /** 单次请求最多下发几张参考图（图片与视频侧共用）；缺省按内置保守上限。 */
  maxReferenceImages?: number;
}

export interface ProviderProfileConfig {
  text?: string;
  image?: string;
  video?: string;
  speech?: string;
  music?: string;
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
  /**
   * Local images that condition the generation (image-to-image), e.g. the
   * user's own photos, so every shot in a film keeps the same look. Providers
   * only send them when their config declares `referenceImageField` (Ark
   * Seedream) and cap the count with `maxReferenceImages`; providers without
   * that field ignore the list. Callers must only pass files they trust to be
   * uploaded (project assets or user-supplied reference images).
   */
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
   * Local image files to condition the generation on (image-to-video). How
   * they are consumed is the provider's config decision: `first_frame` (the
   * default) uses one as the opening frame and, when two are given, the second
   * as the closing frame; `reference_image` sends each one as a character /
   * scene reference (Seedance 2.0 / 2.5 only). Providers that support neither
   * ignore the field. Callers must only pass files they trust to be uploaded
   * (project assets or user-supplied reference images).
   */
  referenceImagePaths?: string[];
}

export interface VideoModelProvider {
  readonly id: string;
  readonly capability: "video";
  readonly isRemote: boolean;
  /**
   * How the provider consumes `referenceImagePaths`: `first_frame` (the
   * default) treats the first as the opening frame and a second as the closing
   * frame; `reference_image` treats each one as a character/scene reference.
   * Callers read this to decide whether the user's photos can guide a shot
   * that has no bound image of its own — sending photos to a first-frame
   * provider would make one of them an unrelated closing frame.
   */
  readonly referenceImageMode?: "first_frame" | "reference_image";
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

export interface MusicGenerationRequest {
  prompt: string;
  outputPath: string;
  durationSeconds: number;
  /** 成片风格，来自 script.bgmStyle，供 provider 拼提示词 */
  style?: string;
}

export interface MusicProvider {
  readonly id: string;
  readonly capability: "music";
  readonly isRemote: boolean;
  /**
   * 该提供者的曲子属于哪一种来源，用于写进 `bgmProvenance`：本地素材库出来的记 `library`（曲目本身另有许可），
   * 模型现生成的记 `ai_generated`。缺省按 `ai_generated` 处理——宁可把「未知」说成 AI 生成，也不要把
   * 一首模型生成的曲子标成「素材库」而让用户以为它来自某个有明确许可的曲库。
   */
  readonly provenanceKind?: "library" | "ai_generated";
  test(options?: { live?: boolean }): Promise<ProviderHealth>;
  /**
   * 合成（或从素材库取）一首曲子写到 outputPath。
   * **返回 null 表示「这个 provider 提供不了」**（如素材库里没有匹配曲目），而不是失败：
   * 上层据此跳过 BGM 并在阶段日志与交付面板里明示「无 BGM」，绝不静默产出一个空音频。
   */
  synthesizeMusic(request: MusicGenerationRequest): Promise<{ outputPath: string } | null>;
}

export interface ProviderSelection {
  text?: TextModelProvider;
  image?: ImageModelProvider;
  video?: VideoModelProvider;
  speech?: SpeechProvider;
  music?: MusicProvider;
}

export interface ProjectArtifacts {
  skill: SkillDefinition;
  brief: BriefDocument;
  script: ScriptPackage;
  storyboard: Storyboard;
  captions: CaptionCue[];
  renderManifest: RenderManifest;
}
