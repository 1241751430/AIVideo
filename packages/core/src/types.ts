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

export interface ProviderConfig {
  type: string;
  capability: ProviderCapability;
  vendor?: string;
  enabled?: boolean;
  baseURL?: string;
  allowCustomBaseURL?: boolean;
  apiKeyEnv?: string;
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
