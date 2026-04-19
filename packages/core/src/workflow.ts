import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  BriefDocument,
  CaptionCue,
  GenerateRequest,
  ProjectArtifacts,
  ProviderSelection,
  RenderManifest,
  ScriptPackage,
  SkillDefinition,
  Storyboard,
  StoryboardShot,
  TextModelProvider
} from "./types.js";
import { autoSelectSkill, getSkillById } from "./skills.js";

const ASPECT_SIZES: Record<string, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 }
};
export const SUPPORTED_ASPECT_RATIOS: readonly string[] = Object.keys(ASPECT_SIZES);
const MAX_DURATION_SECONDS = 600;
const MAX_INPUT_IMAGES = 20;

export function validateGenerateRequest(request: GenerateRequest): void {
  if (!request.theme && !request.content && (!request.images || request.images.length === 0)) {
    throw new Error("At least one of theme, content, or images must be provided.");
  }
  if (!Number.isFinite(request.durationSeconds) || request.durationSeconds <= 0) {
    throw new Error("Duration must be greater than 0 seconds.");
  }
  if (request.mode !== "script" && request.mode !== "video") {
    throw new Error(`Unsupported mode: ${request.mode}`);
  }
  if (request.durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error(`Duration must be ${MAX_DURATION_SECONDS} seconds or less.`);
  }
  if ((request.images?.length ?? 0) > MAX_INPUT_IMAGES) {
    throw new Error(`Images count must be ${MAX_INPUT_IMAGES} or less.`);
  }
  if (!ASPECT_SIZES[request.aspectRatio]) {
    throw new Error(`Unsupported aspect ratio: ${request.aspectRatio}`);
  }
}

export async function selectSkill(
  request: GenerateRequest,
  providers: ProviderSelection
): Promise<SkillDefinition> {
  if (request.skill !== "auto") {
    const selected = getSkillById(request.skill);
    if (!selected) {
      throw new Error(`Unknown skill: ${request.skill}`);
    }
    return selected;
  }

  if (providers.text && providers.text.isRemote) {
    try {
      const selection = await chooseSkillWithModel(request, providers.text);
      const selected = getSkillById(selection);
      if (selected) {
        return selected;
      }
    } catch {
      // Fall back to heuristic selection.
    }
  }

  return autoSelectSkill(request);
}

async function chooseSkillWithModel(
  request: GenerateRequest,
  textProvider: TextModelProvider
): Promise<string> {
  const response = await textProvider.generateText({
    systemPrompt:
      "You classify video generation requests into one skill id. Return JSON only with {\"skill\":\"...\"}. Valid ids: marketing, ecommerce, knowledge, drama, brand, tutorial.",
    userPrompt: JSON.stringify({
      theme: request.theme,
      content: request.content,
      images: request.images?.map((image) => basename(image))
    })
  });
  const parsed = safeParseJson<{ skill?: string }>(response);
  if (!parsed?.skill) {
    throw new Error("Model did not return a valid skill.");
  }
  return parsed.skill;
}

export async function generateArtifacts(input: {
  request: GenerateRequest;
  providers: ProviderSelection;
  skill: SkillDefinition;
}): Promise<ProjectArtifacts> {
  validateGenerateRequest(input.request);
  const brief = buildBrief(input.request, input.skill);
  const script = await buildScriptPackage(brief, input.providers.text, input.skill);
  const storyboard = buildStoryboard(input.request, script);
  const captions = buildCaptions(storyboard);
  const renderManifest = buildRenderManifest({
    request: input.request,
    storyboard,
    script,
    images: input.request.images ?? []
  });

  return {
    skill: input.skill,
    brief,
    script,
    storyboard,
    captions,
    renderManifest
  };
}

export function materializeProject(projectDir: string, artifacts: ProjectArtifacts): void {
  mkdirSync(projectDir, { recursive: true });
  for (const child of ["assets", "audio", "captions", "output"]) {
    mkdirSync(join(projectDir, child), { recursive: true });
  }
  writeJson(join(projectDir, "brief.json"), artifacts.brief);
  writeFileSync(join(projectDir, "script.md"), toScriptMarkdown(artifacts.script), "utf8");
  writeJson(join(projectDir, "storyboard.json"), artifacts.storyboard);
  writeJson(join(projectDir, "render-manifest.json"), artifacts.renderManifest);
  writeFileSync(join(projectDir, "captions", "captions.srt"), toSrt(artifacts.captions), "utf8");
}

export function trimProjectArtifacts(projectDir: string): void {
  for (const name of ["brief.json", "script.md", "storyboard.json"]) {
    const target = join(projectDir, name);
    if (existsSync(target)) {
      rmSync(target, { force: true });
    }
  }
}

export function cleanupRenderWorkspace(projectDir: string): void {
  for (const name of ["audio", "captions", ".render_tmp"]) {
    const target = join(projectDir, name);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
  }
}

export function cleanupExpiredProjects(projectsDir: string, maxAgeDays: number): string[] {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error(`maxAgeDays must be a positive number, got: ${maxAgeDays}`);
  }
  if (!existsSync(projectsDir)) {
    return [];
  }

  const now = Date.now()
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const target = join(projectsDir, entry.name);
    const stats = statSync(target);
    if (now - stats.mtimeMs > maxAgeMs) {
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
  }

  return removed;
}

export function createProjectId(seed?: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = slugify(seed || "project");
  return `${stamp}-${slug}`;
}

export function resolveProjectDir(cwd: string, projectsDir: string, projectId: string): string {
  return resolve(cwd, projectsDir, projectId);
}

function buildBrief(request: GenerateRequest, skill: SkillDefinition): BriefDocument {
  const language = request.language ?? "zh-CN";
  const platform = request.platform ?? "douyin";
  const promptSummary = [request.theme, request.content].filter(Boolean).join(" | ");
  const imageSummary =
    request.images && request.images.length > 0
      ? `并参考 ${request.images.length} 张图片素材`
      : "不依赖外部参考图";

  return {
    theme: request.theme,
    content: request.content,
    inputImages: request.images ?? [],
    selectedSkillId: skill.id,
    selectedSkillName: skill.name,
    language,
    platform,
    aspectRatio: request.aspectRatio,
    durationSeconds: request.durationSeconds,
    creativeDirection: `围绕「${promptSummary || skill.description}」生成 ${skill.name} 风格视频，${imageSummary}。`
  };
}

async function buildScriptPackage(
  brief: BriefDocument,
  textProvider: TextModelProvider | undefined,
  skill: SkillDefinition
): Promise<ScriptPackage> {
  if (textProvider) {
    try {
      const raw = await textProvider.generateText({
        systemPrompt: buildScriptSystemPrompt(skill),
        userPrompt: buildScriptUserPrompt(brief)
      });
      const parsed = safeParseJson<ScriptPackage>(raw);
      if (parsed && parsed.title && Array.isArray(parsed.scenes) && parsed.scenes.length > 0) {
        return normalizeScriptPackage(parsed, brief);
      }
    } catch {
      // Fall through to local generator.
    }
  }

  return buildLocalScriptPackage(brief, skill);
}

function buildScriptSystemPrompt(skill: SkillDefinition): string {
  return [
    "你是一名短视频编导。",
    `当前 skill: ${skill.id} / ${skill.name}`,
    `文案风格：${skill.tone}`,
    `文案规则：${skill.copyRules.join("；")}`,
    `镜头规则：${skill.shotRules.join("；")}`,
    "返回 JSON，字段必须包含：title, summary, openingHook, voiceover, scenes, bgmStyle, cta, hashtags。",
    "scenes 是数组；每个元素必须包含 id, heading, narration, visualPrompt, shotType, durationSeconds, caption。"
  ].join("\n");
}

function buildScriptUserPrompt(brief: BriefDocument): string {
  return JSON.stringify(
    {
      theme: brief.theme,
      content: brief.content,
      skill: brief.selectedSkillId,
      language: brief.language,
      platform: brief.platform,
      aspectRatio: brief.aspectRatio,
      durationSeconds: brief.durationSeconds,
      inputImages: brief.inputImages.map((image) => basename(image))
    },
    null,
    2
  );
}

function buildLocalScriptPackage(brief: BriefDocument, skill: SkillDefinition): ScriptPackage {
  const shotCount = computeShotCount(brief.durationSeconds);
  const durations = splitDuration(brief.durationSeconds, shotCount);
  const titleCore = brief.theme ?? brief.content?.slice(0, 18) ?? "AI 自动视频";
  const openingHook = pickByIndex(skill.hooks, 0);
  const cta = pickByIndex(skill.ctas, 0);
  const focus = brief.content ?? brief.theme ?? "核心卖点";

  const scenes = durations.map((durationSeconds, index) => {
    const step = index + 1;
    const heading = buildSceneHeading(step, shotCount);
    const narration = [
      step === 1 ? openingHook : `第 ${step} 个重点直接展开`,
      `${focus} 的关键点是 ${pickByIndex(skill.copyRules, index)}`,
      `画面呈现建议：${pickByIndex(skill.shotRules, index)}。`
    ].join("，");
    const caption = index === shotCount - 1 ? cta : `重点 ${step}`;
    return {
      id: `scene-${step}`,
      heading,
      narration,
      visualPrompt: `${skill.name} 风格，${heading}，${pickByIndex(skill.shotRules, index)}，突出 ${titleCore}`,
      shotType: index % 2 === 0 ? "medium" : "close-up",
      durationSeconds,
      caption
    };
  });

  return {
    title: `${titleCore}｜${skill.name}视频方案`,
    summary: `围绕 ${titleCore} 生成 ${brief.durationSeconds} 秒 ${skill.name} 风格视频脚本。`,
    openingHook,
    voiceover: scenes.map((scene) => scene.narration).join(" "),
    scenes,
    bgmStyle: `${skill.name} 节奏感背景音乐`,
    cta,
    hashtags: [skill.id, "AI视频", brief.platform, "内容生成"]
  };
}

function normalizeScriptPackage(script: ScriptPackage, brief: BriefDocument): ScriptPackage {
  const scenes = script.scenes.map((scene, index) => ({
    ...scene,
    id: scene.id || `scene-${index + 1}`,
    caption: scene.caption || scene.heading,
    shotType: scene.shotType || "medium"
  }));

  const total = scenes.reduce((sum, scene) => sum + Number(scene.durationSeconds || 0), 0);
  if (total <= 0) {
    const durations = splitDuration(brief.durationSeconds, scenes.length || 1);
    scenes.forEach((scene, index) => {
      scene.durationSeconds = durations[index] ?? 1;
    });
  }

  return {
    ...script,
    scenes
  };
}

function buildStoryboard(request: GenerateRequest, script: ScriptPackage): Storyboard {
  const shots: StoryboardShot[] = script.scenes.map((scene, index) => ({
    id: scene.id,
    title: scene.heading,
    narration: scene.narration,
    caption: scene.caption,
    visualPrompt: scene.visualPrompt,
    shotType: scene.shotType,
    durationSeconds: scene.durationSeconds,
    transition: index === 0 ? "cut" : "fade",
    assetSource:
      request.images && request.images.length > 0
        ? "reference_image"
        : request.mode === "video"
          ? "generated_image"
          : "title_card"
  }));

  return {
    aspectRatio: request.aspectRatio,
    durationSeconds: request.durationSeconds,
    shots
  };
}

function buildCaptions(storyboard: Storyboard): CaptionCue[] {
  let cursor = 0;
  return storyboard.shots.map((shot) => {
    const cue = {
      startSeconds: cursor,
      endSeconds: cursor + shot.durationSeconds,
      text: shot.caption || shot.narration
    };
    cursor += shot.durationSeconds;
    return cue;
  });
}

function buildRenderManifest(input: {
  request: GenerateRequest;
  storyboard: Storyboard;
  script: ScriptPackage;
  images: string[];
}): RenderManifest {
  const size = ASPECT_SIZES[input.request.aspectRatio]!;
  const shots = input.storyboard.shots.map((shot, index) => {
    const referencedImage = input.images[index % Math.max(input.images.length, 1)];
    const hasReference = Boolean(referencedImage);
    return {
      shotId: shot.id,
      title: shot.title,
      durationSeconds: shot.durationSeconds,
      assetKind: hasReference ? ("image" as const) : ("generated-card" as const),
      assetPath: referencedImage,
      audioPath: `audio/${shot.id}.aiff`,
      overlayText: shot.title,
      caption: shot.caption,
      visualPrompt: shot.visualPrompt
    };
  });

  return {
    aspectRatio: input.request.aspectRatio,
    width: size.width,
    height: size.height,
    durationSeconds: input.request.durationSeconds,
    bgmStyle: input.script.bgmStyle,
    outputFile: `output/${slugify(input.script.title)}.mp4`,
    captionsFile: "captions/captions.srt",
    shots
  };
}

export function toSrt(captions: CaptionCue[]): string {
  return captions
    .map((caption, index) => {
      return [
        String(index + 1),
        `${formatSrtTime(caption.startSeconds)} --> ${formatSrtTime(caption.endSeconds)}`,
        caption.text,
        ""
      ].join("\n");
    })
    .join("\n");
}

export function toScriptMarkdown(script: ScriptPackage): string {
  const scenes = script.scenes
    .map(
      (scene, index) =>
        `## 镜头 ${index + 1}: ${scene.heading}\n- 时长: ${scene.durationSeconds}s\n- 旁白: ${scene.narration}\n- 字幕: ${scene.caption}\n- 提示词: ${scene.visualPrompt}`
    )
    .join("\n\n");

  return [
    `# ${script.title}`,
    "",
    "## 摘要",
    script.summary,
    "",
    "## 开头钩子",
    script.openingHook,
    "",
    "## 旁白总稿",
    script.voiceover,
    "",
    "## 分镜",
    scenes,
    "",
    "## BGM",
    script.bgmStyle,
    "",
    "## CTA",
    script.cta,
    "",
    "## Hashtags",
    script.hashtags.map((tag) => `#${tag}`).join(" ")
  ].join("\n");
}

function writeJson(target: string, value: unknown): void {
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeParseJson<T>(value: string): T | null {
  try {
    const match = value.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    return match ? (JSON.parse(match[0]) as T) : null;
  } catch {
    return null;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function computeShotCount(durationSeconds: number): number {
  if (durationSeconds <= 20) {
    return 4;
  }
  if (durationSeconds <= 40) {
    return 5;
  }
  if (durationSeconds <= 60) {
    return 6;
  }
  return 8;
}

function splitDuration(total: number, segments: number): number[] {
  const base = Math.floor((total / segments) * 10) / 10;
  const result = Array.from({ length: segments }, () => base);
  const used = result.reduce((sum, item) => sum + item, 0);
  const delta = Math.round((total - used) * 10) / 10;
  const lastIndex = result.length - 1;
  result[lastIndex] = Math.round(((result[lastIndex] ?? 0) + delta) * 10) / 10;
  return result;
}

function buildSceneHeading(step: number, total: number): string {
  if (step === 1) {
    return "开场钩子";
  }
  if (step === total) {
    return "结尾收束";
  }
  return `核心亮点 ${step - 1}`;
}

function pickByIndex<T>(values: T[], index: number): T {
  return values[index % values.length]!;
}

function formatSrtTime(value: number): string {
  const totalMilliseconds = Math.round(value * 1000);
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":") +
    `,${String(milliseconds).padStart(3, "0")}`;
}
