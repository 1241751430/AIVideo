import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
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
const MAX_SCENES = 24;
const MIN_SHOT_DURATION_SECONDS = 1;

export function validateGenerateRequest(request: GenerateRequest): void {
  if (!request.theme && !request.content && (!request.images || request.images.length === 0)) {
    throw new Error("At least one of theme, content, or images must be provided.");
  }
  if (!Number.isFinite(request.durationSeconds) || request.durationSeconds <= 0) {
    throw new Error("Duration must be greater than 0 seconds.");
  }
  if (request.durationSeconds < MIN_SHOT_DURATION_SECONDS) {
    throw new Error(`Duration must be at least ${MIN_SHOT_DURATION_SECONDS} second.`);
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
    } catch (error) {
      console.warn(`Skill selection via model failed, falling back to heuristic: ${(error as Error).message}`);
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

const ASSET_PREP_CONCURRENCY = 3;

/**
 * The subset of project artifacts the asset-preparation phase consumes. Kept
 * as a Pick so a resumed run can rebuild it from the project's on-disk JSON
 * files without regenerating the (paid) script or needing the skill object.
 */
export type AssetArtifacts = Pick<ProjectArtifacts, "brief" | "storyboard" | "renderManifest">;

/**
 * Rebuild asset-prep artifacts from a materialized project directory. Returns
 * null when any required file is missing or unparsable — the caller should
 * treat that as "this directory is not a resumable project" rather than
 * silently generating against a half-known state.
 */
export function loadAssetArtifacts(projectDir: string): AssetArtifacts | null {
  try {
    const brief = JSON.parse(readFileSync(join(projectDir, "brief.json"), "utf8")) as BriefDocument;
    const storyboard = JSON.parse(readFileSync(join(projectDir, "storyboard.json"), "utf8")) as Storyboard;
    const renderManifest = JSON.parse(
      readFileSync(join(projectDir, "render-manifest.json"), "utf8")
    ) as RenderManifest;
    if (
      !brief ||
      !Array.isArray(storyboard?.shots) ||
      storyboard.shots.length === 0 ||
      !Array.isArray(renderManifest?.shots) ||
      renderManifest.shots.length === 0
    ) {
      return null;
    }
    return { brief, storyboard, renderManifest };
  } catch {
    return null;
  }
}

/**
 * A remote provider controls the path it reports back as the generated file's
 * location. Refuse to reference anything outside the project directory so a
 * misbehaving provider cannot redirect the renderer to arbitrary local files.
 */
function assertPathWithinProject(projectDir: string, filePath: string, kind: string): void {
  const root = resolve(projectDir);
  const target = resolve(filePath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`provider returned a ${kind} path outside the project directory`);
  }
}

export interface AssetPrepResult {
  attempted: number;
  succeeded: number;
  failed: number;
  /** Shots whose paid asset was already present in the project dir from a previous run. */
  reused: number;
  videoSucceeded: number;
  imageSucceeded: number;
}

/**
 * True when `filePath` names a regular file with non-empty content. A crashed
 * run can truncate an asset to 0 bytes, and a directory can never be a usable
 * media file — neither counts.
 */
function nonEmptyFileExists(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }
  try {
    return statSync(filePath).isFile() && statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/**
 * True when `filePath` points at a regular file inside `projectDir` with
 * non-empty content. Used to detect assets produced by an earlier run so a
 * resume pass can skip the paid API call. The resolved-path check makes this
 * safe against a shot id smuggling a traversal outside the project.
 */
function reusableAssetExists(projectDir: string, filePath: string): boolean {
  if (!nonEmptyFileExists(filePath)) {
    return false;
  }
  const root = resolve(projectDir);
  const target = resolve(filePath);
  return target !== root && target.startsWith(root + sep);
}

/**
 * Generate the scene assets promised by the storyboard. Shots with
 * `assetSource: "generated_image"` get a paid asset: when the selected video
 * provider is remote, each shot becomes a real motion clip ("video");
 * otherwise a remote image provider produces scene images ("image"). Shots
 * with `assetSource: "reference_image"` keep their user image as the manifest
 * asset — and when a remote video provider exists, it animates that image
 * (image-to-video) instead of spending a second call on a fresh scene image.
 * Failures degrade gracefully: a failed video falls back to the image flow
 * when available and then to the manifest's existing asset (scene image or
 * user reference image), or a title card if neither exists.
 *
 * No-ops when both the video and image providers are local/noop — those never
 * create real files, and the manifest must keep pointing at title cards.
 */
export async function prepareGeneratedAssets(input: {
  projectDir: string;
  artifacts: AssetArtifacts;
  providers: ProviderSelection;
}): Promise<AssetPrepResult> {
  const { projectDir, artifacts, providers } = input;
  const result: AssetPrepResult = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    reused: 0,
    videoSucceeded: 0,
    imageSucceeded: 0
  };
  const videoProvider = providers.video;
  const imageProvider = providers.image;
  const useVideo = Boolean(videoProvider && videoProvider.isRemote);
  const useImage = Boolean(imageProvider && imageProvider.isRemote);
  if (!useVideo && !useImage) {
    return result;
  }

  const generatedShots = artifacts.storyboard.shots.filter(
    (shot) =>
      shot.assetSource === "generated_image" ||
      (shot.assetSource === "reference_image" && useVideo)
  );
  if (generatedShots.length === 0) {
    return result;
  }

  const manifestByShotId = new Map(
    artifacts.renderManifest.shots.map((shot) => [shot.shotId, shot])
  );
  const size = ASPECT_SIZES[artifacts.brief.aspectRatio] ?? { width: 1080, height: 1920 };

  // Each user image is pinned to the shot at its own index (see buildStoryboard)
  // — the same mapping buildRenderManifest records per-shot. Provenance is
  // pinned to the brief, never to the manifest, so a tampered manifest cannot
  // smuggle an arbitrary local file into a provider upload.
  const inputImages = artifacts.brief.inputImages ?? [];
  const shotIndexById = new Map(
    artifacts.storyboard.shots.map((shot, index) => [shot.id, index])
  );

  type PendingShot = (typeof generatedShots)[number];
  type ManifestShot = (typeof artifacts.renderManifest.shots)[number];

  /**
   * The image a shot's video should start from, or undefined for a plain
   * text-to-video call. Reference shots animate the user's own image; a
   * generated shot whose scene image already exists in the project (paid for
   * by an earlier run whose video failed) animates from that image instead of
   * being regenerated blind.
   */
  function firstFrameFor(shot: PendingShot, manifestShot: ManifestShot): string[] | undefined {
    if (shot.assetSource === "reference_image") {
      const index = shotIndexById.get(shot.id);
      if (index === undefined || index >= inputImages.length) {
        return undefined;
      }
      const candidate = inputImages[index]!;
      return nonEmptyFileExists(candidate) ? [candidate] : undefined;
    }
    if (manifestShot.assetKind === "image" && manifestShot.assetPath) {
      const sceneImage = resolve(projectDir, manifestShot.assetPath);
      return reusableAssetExists(projectDir, sceneImage) ? [sceneImage] : undefined;
    }
    return undefined;
  }

  const queue: PendingShot[] = [...generatedShots];
  result.attempted = queue.length;

  async function generateVideoFor(shot: PendingShot, manifestShot: ManifestShot): Promise<boolean> {
    if (!videoProvider || !videoProvider.isRemote) {
      return false;
    }
    const relativePath = `assets/${shot.id}.mp4`;
    const outputPath = join(projectDir, relativePath);
    // Resume support: if an earlier run already produced this shot's video —
    // either at the conventional path or the provider-returned path still
    // recorded in the manifest — reuse it instead of paying for a duplicate
    // generation. Only files inside the project dir are ever trusted.
    if (reusableAssetExists(projectDir, outputPath)) {
      manifestShot.assetKind = "video";
      manifestShot.assetPath = relativePath;
      result.reused += 1;
      result.succeeded += 1;
      return true;
    }
    if (manifestShot.assetKind === "video" && manifestShot.assetPath) {
      const recorded = resolve(projectDir, manifestShot.assetPath);
      if (reusableAssetExists(projectDir, recorded)) {
        result.reused += 1;
        result.succeeded += 1;
        return true;
      }
    }
    try {
      const generated = await videoProvider.generateVideo({
        prompt: shot.visualPrompt,
        durationSeconds: shot.durationSeconds,
        outputPath,
        aspectRatio: artifacts.brief.aspectRatio,
        referenceImagePaths: firstFrameFor(shot, manifestShot)
      });
      const finalPath = generated.outputPath || outputPath;
      if (!existsSync(finalPath)) {
        throw new Error("provider returned no video file");
      }
      assertPathWithinProject(projectDir, finalPath, "video");
      manifestShot.assetKind = "video";
      manifestShot.assetPath = finalPath === outputPath ? relativePath : finalPath;
      result.succeeded += 1;
      result.videoSucceeded += 1;
      return true;
    } catch (error) {
      // A reference shot that fails to animate still has its user image in
      // the manifest — a complete asset that cost nothing. Keep it instead of
      // spending a paid image call to replace a free user-supplied picture.
      const keepsImage =
        shot.assetSource === "reference_image" &&
        manifestShot.assetKind === "image" &&
        Boolean(manifestShot.assetPath) &&
        nonEmptyFileExists(resolve(projectDir, manifestShot.assetPath!));
      const fallback = keepsImage ? "the reference image" : useImage ? "scene image" : "title card";
      console.warn(
        `Video generation failed for shot ${shot.id}, falling back to ${fallback}: ${(error as Error).message}`
      );
      if (keepsImage) {
        result.succeeded += 1;
        result.reused += 1;
        return true;
      }
      return false;
    }
  }

  async function generateImageFor(shot: PendingShot, manifestShot: ManifestShot): Promise<boolean> {
    if (!imageProvider || !imageProvider.isRemote) {
      return false;
    }
    const relativePath = `assets/${shot.id}.png`;
    const outputPath = join(projectDir, relativePath);
    // Same resume logic as the video branch: reuse a previously generated
    // scene image when the file is already present inside the project dir.
    if (reusableAssetExists(projectDir, outputPath)) {
      manifestShot.assetKind = "image";
      manifestShot.assetPath = relativePath;
      result.reused += 1;
      result.succeeded += 1;
      return true;
    }
    if (manifestShot.assetKind === "image" && manifestShot.assetPath) {
      const recorded = resolve(projectDir, manifestShot.assetPath);
      if (reusableAssetExists(projectDir, recorded)) {
        result.reused += 1;
        result.succeeded += 1;
        return true;
      }
    }
    try {
      const generated = await imageProvider.generateImage({
        prompt: shot.visualPrompt,
        outputPath,
        width: size.width,
        height: size.height,
        aspectRatio: artifacts.brief.aspectRatio
      });
      const finalPath = generated.outputPath || outputPath;
      if (!existsSync(finalPath)) {
        throw new Error("provider returned no image file");
      }
      assertPathWithinProject(projectDir, finalPath, "image");
      manifestShot.assetKind = "image";
      manifestShot.assetPath = finalPath === outputPath ? relativePath : finalPath;
      result.succeeded += 1;
      result.imageSucceeded += 1;
      return true;
    } catch (error) {
      console.warn(
        `Image generation failed for shot ${shot.id}, falling back to title card: ${(error as Error).message}`
      );
      return false;
    }
  }

  async function generateOne(shot: PendingShot): Promise<void> {
    const manifestShot = manifestByShotId.get(shot.id);
    if (!manifestShot) {
      result.failed += 1;
      return;
    }
    if (useVideo && (await generateVideoFor(shot, manifestShot))) {
      return;
    }
    if (useImage && (await generateImageFor(shot, manifestShot))) {
      return;
    }
    result.failed += 1;
  }

  const workers = Array.from({ length: Math.min(ASSET_PREP_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const shot = queue.shift();
      if (!shot) {
        break;
      }
      await generateOne(shot);
    }
  });
  await Promise.all(workers);

  if (result.succeeded > 0) {
    writeJson(join(projectDir, "render-manifest.json"), artifacts.renderManifest);
  }
  return result;
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
  return `${stamp}-${slug}-${randomUUID().slice(0, 8)}`;
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
      if (parsed && Array.isArray(parsed.scenes) && parsed.scenes.length > 0) {
        return normalizeScriptPackage(parsed, brief);
      }
    } catch (error) {
      console.warn(`Remote script generation failed, falling back to local: ${(error as Error).message}`);
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
  const fallback = buildLocalScriptPackage(brief, getSkillById(brief.selectedSkillId)!);
  const rawScenes = Array.isArray(script.scenes) ? script.scenes.slice(0, MAX_SCENES) : [];
  const scenes = rawScenes.map((scene, index) => {
    const heading = sanitizeText(scene.heading, `镜头 ${index + 1}`);
    const narration = sanitizeText(scene.narration, heading);
    return {
      ...scene,
      id: sanitizeId(scene.id, index + 1),
      heading,
      narration,
      visualPrompt: sanitizeText(scene.visualPrompt, heading),
      caption: sanitizeText(scene.caption, heading),
      shotType: sanitizeText(scene.shotType, "medium"),
      durationSeconds: normalizeDurationValue(scene.durationSeconds)
    };
  });

  const usableScenes = scenes.length > 0 ? scenes : fallback.scenes;
  const durations = normalizeDurations(
    usableScenes.map((scene) => scene.durationSeconds),
    brief.durationSeconds
  );
  usableScenes.forEach((scene, index) => {
    scene.durationSeconds = durations[index] ?? MIN_SHOT_DURATION_SECONDS;
  });

  return {
    title: sanitizeText(script.title, fallback.title),
    summary: sanitizeText(script.summary, fallback.summary),
    openingHook: sanitizeText(script.openingHook, fallback.openingHook),
    voiceover: sanitizeText(script.voiceover, usableScenes.map((scene) => scene.narration).join(" ")),
    scenes: usableScenes,
    bgmStyle: sanitizeText(script.bgmStyle, fallback.bgmStyle),
    cta: sanitizeText(script.cta, fallback.cta),
    hashtags: Array.isArray(script.hashtags) && script.hashtags.length > 0 ? script.hashtags : fallback.hashtags
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
    // Per-shot mixing: each user image is spent on exactly one shot (shot i
    // takes images[i]); once they run out, later shots fall back to generated
    // assets. Reusing one photo across the whole video reads as a slideshow.
    assetSource:
      request.images && index < request.images.length
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
    // Mirror buildStoryboard's per-shot rule: a reference shot consumes the
    // image at its own index (reference shots are exactly the first N shots);
    // every other shot starts as a title card and gets a generated asset.
    const referencedImage =
      shot.assetSource === "reference_image" ? input.images[index] : undefined;
    const hasReference = Boolean(referencedImage);
    return {
      shotId: shot.id,
      title: shot.title,
      durationSeconds: shot.durationSeconds,
      assetKind: hasReference ? ("image" as const) : ("generated-card" as const),
      assetPath: referencedImage,
      audioPath: `audio/${shot.id}.wav`,
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
    return JSON.parse(value) as T;
  } catch {
    // Model may wrap JSON in markdown or extra text; extract the outermost block.
  }
  try {
    const match = value.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    return match ? (JSON.parse(match[0]) as T) : null;
  } catch {
    return null;
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "ai-video";
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

function normalizeDurations(values: number[], total: number): number[] {
  if (values.length === 0) {
    return [];
  }
  const minimumTotal = values.length * MIN_SHOT_DURATION_SECONDS;
  if (total < minimumTotal) {
    return splitDuration(total, values.length);
  }

  const normalized = values.map((value) =>
    Number.isFinite(value) && value > 0 ? Math.max(value, MIN_SHOT_DURATION_SECONDS) : MIN_SHOT_DURATION_SECONDS
  );
  const currentTotal = normalized.reduce((sum, value) => sum + value, 0);
  if (currentTotal <= 0) {
    return splitDuration(total, values.length);
  }

  const scale = total / currentTotal;
  const scaled = normalized.map((value) => Math.max(MIN_SHOT_DURATION_SECONDS, Math.round(value * scale * 10) / 10));
  let delta = Math.round((total - scaled.reduce((sum, value) => sum + value, 0)) * 10) / 10;
  let index = scaled.length - 1;
  while (Math.abs(delta) >= 0.1 && index >= 0) {
    const next = Math.round(((scaled[index] ?? MIN_SHOT_DURATION_SECONDS) + delta) * 10) / 10;
    if (next >= MIN_SHOT_DURATION_SECONDS) {
      scaled[index] = next;
      delta = 0;
    } else {
      delta = Math.round((delta + ((scaled[index] ?? MIN_SHOT_DURATION_SECONDS) - MIN_SHOT_DURATION_SECONDS)) * 10) / 10;
      scaled[index] = MIN_SHOT_DURATION_SECONDS;
      index -= 1;
    }
  }
  return scaled;
}

function normalizeDurationValue(value: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MIN_SHOT_DURATION_SECONDS;
}

function sanitizeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function sanitizeId(value: unknown, index: number): string {
  const raw = sanitizeText(value, `scene-${index}`);
  const id = slugify(raw);
  return id || `scene-${index}`;
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
