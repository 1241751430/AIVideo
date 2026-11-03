/**
 * @file workflow.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 视频生成核心流水线：请求校验、技能选择、脚本/分镜/字幕/渲染清单的生成与归一化、项目落盘、场景资产（图/视频）生成与断点续跑复用（按输入指纹判定，显式 force 时全部重做），以及项目清理等编排逻辑。
 * @see https://github.com/1241751430/AIVideo.git
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_INPUT_IMAGES } from "@aivideo/shared";
import {
  AssetProvenance,
  BriefDocument,
  CaptionCue,
  GenerateRequest,
  ProjectArtifacts,
  ProviderSelection,
  RenderManifest,
  ScriptLine,
  ScriptPackage,
  ScriptRole,
  ScriptScene,
  SkillDefinition,
  Storyboard,
  StoryboardShot,
  TextModelProvider
} from "./types.js";
import { autoSelectSkill, getSkillById } from "./skills.js";
import { isWithinBase, nonEmptyFileExists, runConcurrent, writeJsonFile } from "./utils.js";
import { readRenderManifestFile, writeRenderManifestFile } from "./renderManifest.js";
import {
  PROJECT_BGM_BASENAME,
  PROJECT_BGM_EXTS,
  shotImageRelative,
  shotImagePath,
  shotVideoRelative,
  shotVideoPath
} from "./shotFiles.js";
import {
  assetsShotFingerprint,
  compareStageFingerprint,
  readStageFingerprints,
  recordStageFingerprints,
  shotReferenceImagePaths
} from "./fingerprints.js";

const ASPECT_SIZES: Record<string, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 }
};
export const SUPPORTED_ASPECT_RATIOS: readonly string[] = Object.keys(ASPECT_SIZES);
export const MAX_DURATION_SECONDS = 600;
// 参考图上限来自 @aivideo/shared：服务端落盘校验、前端选图预校验、这里的生成前校验必须读同一个数字。
// 常量放在 shared 而不是本包，是因为 apps/web 只依赖 shared、够不到 core；此处只做转发以保持 core 的既有导出面。
export { MAX_INPUT_IMAGES } from "@aivideo/shared";
const MAX_SCENES = 24;
export const MIN_SHOT_DURATION_SECONDS = 1;
/** 角色表上限：超过四个声部，短视频里观众已经分不清谁在说话。 */
const MAX_ROLES = 4;
/** 单镜台词条数上限：再多就念不完这一镜的时长。编辑校验也读这个数（避免界面允许、保存时又拒绝）。 */
export const MAX_LINES_PER_SCENE = 3;
/** 角色 id 允许的字符：字母（含中日韩）、数字、下划线、连字符；与 shotFiles 的镜头 id 同一口径。 */
const ROLE_ID_PATTERN = /^[\p{L}\p{N}_-]+$/u;

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验生成请求：主题/正文/图片至少其一、时长在 [最小时长, 600] 秒且为正、mode 合法、图片不超过 20 张、宽高比受支持；不合法时抛出错误。
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：解析请求指定的技能；skill 为 "auto" 时优先用远端文本模型分类（失败告警后回退关键词启发式 autoSelectSkill）。未知技能 id 抛错。
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：让文本模型以 JSON 形式从六个内置技能 id 中分类，返回其选中的技能 id；模型未返回有效技能时抛错。
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：串联一次生成的全部产物：校验请求 → 构建 brief → 脚本（远端或本地）→ 分镜 → 字幕 → 渲染清单，返回 ProjectArtifacts。
 */
export async function generateArtifacts(input: {
  request: GenerateRequest;
  providers: ProviderSelection;
  skill: SkillDefinition;
}): Promise<ProjectArtifacts> {
  validateGenerateRequest(input.request);
  const brief = buildBrief(input.request, input.skill);
  const script = await buildScriptPackage(brief, input.providers.text, input.skill);
  // 分镜的 assetSource 描述的是「这一镜的画面最终会怎么来」，不是「这一镜想要什么」。
  // 没有远端图/视频能力时，素材阶段根本不会调用任何模型（见 prepareGeneratedAssets 的早退），
  // 所以这里必须问一遍能力再落盘，否则 storyboard.json 会写着 generated_image 而实际出一张标题卡。
  const hasRemoteVisual = Boolean(
    (input.providers.video && input.providers.video.isRemote) ||
      (input.providers.image && input.providers.image.isRemote)
  );
  const storyboard = buildStoryboard(input.request, script, hasRemoteVisual);
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：创建项目目录及 assets/audio/captions/output 子目录，把 brief、script（json+md）、storyboard、manifest、captions.srt 全部写盘。
 */
export function materializeProject(projectDir: string, artifacts: ProjectArtifacts): void {
  mkdirSync(projectDir, { recursive: true });
  for (const child of ["assets", "audio", "captions", "output"]) {
    mkdirSync(join(projectDir, child), { recursive: true });
  }
  writeJsonFile(join(projectDir, "brief.json"), artifacts.brief);
  writeJsonFile(join(projectDir, "script.json"), artifacts.script);
  writeFileSync(join(projectDir, "script.md"), toScriptMarkdown(artifacts.script), "utf8");
  writeJsonFile(join(projectDir, "storyboard.json"), artifacts.storyboard);
  writeRenderManifestFile(projectDir, artifacts.renderManifest);
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
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：从已落盘项目目录重建资产阶段所需的 brief/storyboard/manifest；任一必需文件缺失、解析失败或 shots 为空时返回 null（表示该目录不可续跑）。
 */
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
    const renderManifest = readRenderManifestFile(projectDir);
    if (
      !brief ||
      !Array.isArray(storyboard?.shots) ||
      storyboard.shots.length === 0 ||
      !renderManifest ||
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
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：Provider 回报的文件路径若越出项目目录则抛错，防止异常 Provider 把渲染器指向任意本地文件。
 */
/**
 * A remote provider controls the path it reports back as the generated file's
 * location. Refuse to reference anything outside the project directory so a
 * misbehaving provider cannot redirect the renderer to arbitrary local files.
 */
function assertPathWithinProject(projectDir: string, filePath: string, kind: string): void {
  if (!isWithinBase(projectDir, filePath)) {
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
  /**
   * Why this pass generated nothing, when it generated nothing.
   *
   * The three early returns used to be indistinguishable from "ran and did
   * nothing", so callers could only report a vague "no remote providers" even
   * when the real cause was that every shot was already bound to a user image.
   * Naming the reason lets the UI say what this film will actually look like
   * instead of guessing.
   */
  skippedReason?: "no-remote-provider" | "all-shots-bound-to-reference" | "no-shots";
}

/**
 * @author zhangbaohong  @date 2026-11-03  @see https://github.com/1241751430/AIVideo.git
 * 功能：把素材阶段的零产出原因翻成一句面向用户的说明，CLI 终端与工作台日志共用同一份文案——
 * 两处各写一份的话，同一次空转就会给出两种解释，用户不知道该信哪个。
 * 只在 attempted 为 0 时有意义；调用方应先判 attempted，再取这句话。
 * @param reason 素材阶段的 skippedReason（正常产出时缺省，走兜底文案而不是静默）
 * @returns 一句解释「这一趟为什么什么都没画」
 */
export function describeAssetPrepSkip(reason: AssetPrepResult["skippedReason"]): string {
  switch (reason) {
    case "no-remote-provider":
      return "未配置图片/视频模型，本片将由标题卡构成。要生成画面请在配置档中启用 image 或 video 提供者。";
    case "all-shots-bound-to-reference":
      return "全部镜头都已绑定参考图，素材阶段无需调用远端；参考图本身不会额外计费。";
    case "no-shots":
      return "分镜为空，素材阶段没有可处理的镜头——请检查脚本阶段产物。";
    default:
      // attempted 为 0 却没有任何原因：多半是新加了早退分支却忘了标注。宁可给一句含糊的说明，
      // 也不要静默——用户至少要能区分「跳过了」和「在等 AI 画图」。
      return "素材阶段没有生成任何画面，本片将由标题卡构成。";
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：判断 filePath 是否为项目内（不含目录本身）的非空普通文件，用于续跑时跳过已付费资产；resolve 比较可防 shotId 夹带路径穿越。
 */
/**
 * True when `filePath` points at a regular file inside `projectDir` (but not
 * the directory itself) with non-empty content. Used to detect assets produced
 * by an earlier run so a resume pass can skip the paid API call. The
 * resolved-path check makes this safe against a shot id smuggling a traversal
 * outside the project.
 */
function reusableAssetExists(projectDir: string, filePath: string): boolean {
  if (!nonEmptyFileExists(filePath)) {
    return false;
  }
  return isWithinBase(projectDir, filePath) && resolve(filePath) !== resolve(projectDir);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：为分镜承诺的付费资产并发调用远端 Provider：优先图生视频/文生视频，失败降级场景图片再降级标题卡；磁盘已有资产直接复用不再付费，参考镜失败则保留免费用户图；有新资产产出时重写 manifest。
 * @returns 尝试/成功/失败/复用与视频/图片成功计数（AssetPrepResult）
 */
/**
 * Generate the scene assets promised by the storyboard. Shots with
 * `assetSource: "generated_image"` or `"title_card"` get a paid asset: when the
 * selected video provider is remote, each shot becomes a real motion clip
 * ("video"); otherwise a remote image provider produces scene images ("image").
 * `title_card` counts because it is a placeholder for "no picture yet", not a
 * verdict — a project scripted under a config with no visual provider records
 * title cards, and adding a provider before resuming must still animate it.
 * Shots with `assetSource: "reference_image"` keep their user image as the
 * manifest asset — and when a remote video provider exists, it animates that
 * image (image-to-video) instead of spending a second call on a fresh scene image.
 * Failures degrade gracefully: a failed video falls back to the image flow
 * when available and then to the manifest's existing asset (scene image or
 * user reference image), or a title card if neither exists.
 *
 * No-ops when both the video and image providers are local/noop — those never
 * create real files, and the manifest must keep pointing at title cards.
 *
 * Reuse is decided by the shot's input fingerprint (prompt, asset source,
 * aspect ratio, bound reference image) plus the file still being on disk — not
 * by file presence alone, so a reworded prompt regenerates the asset while a
 * resumed run that changed nothing still reuses it. `force` skips reuse
 * entirely; projects without recorded fingerprints fall back to file presence.
 */
export async function prepareGeneratedAssets(input: {
  projectDir: string;
  artifacts: AssetArtifacts;
  providers: ProviderSelection;
  /** True when the caller explicitly asked for a redo: never reuse on-disk assets. */
  force?: boolean;
  /** Optional progress sink (e.g. a CLI spinner); defaults to silent. */
  reportProgress?: (message: string) => void;
}): Promise<AssetPrepResult> {
  const { projectDir, artifacts, providers, force, reportProgress } = input;
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
    // No paid capability at all: every shot renders as its title card. This is
    // the common path on a stock config, so the reason has to survive to the
    // caller — an empty counter set alone reads like a silent no-op.
    result.skippedReason = "no-remote-provider";
    return result;
  }

  // `title_card` is a placeholder, not a verdict: a project whose script stage ran
  // on a config without any visual provider records title cards, and the user may
  // add an image/video provider before resuming. Prep is the stage that turns
  // pictures into reality, so any shot that is not pinned to a user image (and is
  // not a reference shot we cannot animate) is fair game. This mirrors the
  // manifest, which already writes `generated-card` as a to-be-replaced placeholder.
  const generatedShots = artifacts.storyboard.shots.filter(
    (shot) =>
      shot.assetSource === "generated_image" ||
      shot.assetSource === "title_card" ||
      (shot.assetSource === "reference_image" && useVideo)
  );
  if (generatedShots.length === 0) {
    // Distinguish "there was nothing to draw" from "every shot is already a
    // real picture": the first means the run is broken, the second means the
    // film is fully illustrated without spending anything.
    result.skippedReason = artifacts.storyboard.shots.length === 0 ? "no-shots" : "all-shots-bound-to-reference";
    return result;
  }

  const manifestByShotId = new Map(
    artifacts.renderManifest.shots.map((shot) => [shot.shotId, shot])
  );
  const size = ASPECT_SIZES[artifacts.brief.aspectRatio] ?? { width: 1080, height: 1920 };

  // Each user image is bound to its shot by id (StoryboardShot.inputImageIndex)
  // at build time, never by the shot's current position — reordering the
  // storyboard must not hand a shot somebody else's photo. Projects written
  // before the field existed fall back to the position, which was correct back
  // then because builds assign reference shots to the first N positions.
  // Provenance is pinned to the brief, never to the manifest, so a tampered
  // manifest cannot smuggle an arbitrary local file into a provider upload.
  const inputImages = artifacts.brief.inputImages ?? [];
  const shotIndexById = new Map(
    artifacts.storyboard.shots.map((shot, index) => [shot.id, index])
  );
  type PendingShot = (typeof generatedShots)[number];
  type ManifestShot = (typeof artifacts.renderManifest.shots)[number];

  /**
   * Every user photo a shot may be conditioned on. Reference shots animate the
   * single image bound to them by id; generated shots are the ones that need
   * the *whole* set — that is what keeps the same character and location
   * looking alike from shot to shot. The list is resolved once here so the
   * request, the resume fingerprint and the plan view all read the same thing.
   */
  function userImagesFor(shot: PendingShot): string[] {
    const shotIndex = shotIndexById.get(shot.id);
    if (shotIndex === undefined) {
      return [];
    }
    return shotReferenceImagePaths({ shot, shotIndex, inputImages });
  }

  /**
   * The images a shot's video should be conditioned on, or undefined for a
   * plain text-to-video call. Reference shots animate the user's own image; a
   * generated shot whose scene image already exists in the project (paid for
   * by an earlier run whose video failed) animates from that image instead of
   * being regenerated blind.
   *
   * Generated shots only receive the user's photos when the provider takes them
   * as `reference_image`. Under the default `first_frame` mode a second photo
   * would become the *closing* frame — a hard cut to an unrelated picture at
   * the end of the shot, which is worse than ignoring the photo.
   */
  function videoReferencesFor(shot: PendingShot, manifestShot: ManifestShot): string[] | undefined {
    if (shot.assetSource === "reference_image") {
      const shotIndex = shotIndexById.get(shot.id);
      if (shotIndex === undefined) {
        return undefined;
      }
      const candidate = inputImages[resolveInputImageIndex(shot, shotIndex)];
      return candidate && nonEmptyFileExists(candidate) ? [candidate] : undefined;
    }
    const sceneImage =
      manifestShot.assetKind === "image" && manifestShot.assetPath
        ? resolve(projectDir, manifestShot.assetPath)
        : undefined;
    const reusableSceneImage =
      sceneImage && reusableAssetExists(projectDir, sceneImage) ? sceneImage : undefined;
    if ((videoProvider?.referenceImageMode ?? "first_frame") === "reference_image") {
      const references = userImagesFor(shot);
      if (references.length > 0) {
        // The earlier scene image is this shot's own look; keep it as one more
        // reference so a resumed run pins the location instead of drifting.
        return reusableSceneImage ? [...references, reusableSceneImage] : references;
      }
      return reusableSceneImage ? [reusableSceneImage] : undefined;
    }
    return reusableSceneImage ? [reusableSceneImage] : undefined;
  }

  result.attempted = generatedShots.length;
  let settled = 0;

  // Fingerprint of a shot's asset inputs: the same invalidation matrix as
  // editing.ts (the visual prompt) widened with the aspect ratio, the user
  // image a reference shot is bound to, and — for generated shots — the whole
  // set of user photos the image call is conditioned on. The indices go
  // through the same id-bound resolution as the requests below, so reordering
  // shots cannot make an unrelated image look like a change, and swapping
  // photo #2 does register as a change instead of silently reusing the old
  // picture (the user would read that as "my new photo had no effect").
  function assetsFingerprintFor(shot: PendingShot): string {
    const shotIndex = shotIndexById.get(shot.id);
    return assetsShotFingerprint({
      shot,
      aspectRatio: artifacts.brief.aspectRatio,
      referenceImages: userImagesFor(shot),
      ...(shot.assetSource === "reference_image" && shotIndex !== undefined
        ? { referenceImageIndex: resolveInputImageIndex(shot, shotIndex) }
        : {})
    });
  }

  // Reuse gate: the recorded fingerprint must not have changed — a project
  // with no record keeps the legacy presence check — and the caller must not
  // have asked for an explicit redo. The file itself still has to exist, since
  // editing deletes generated assets without touching the fingerprint file.
  const recordedAssets = readStageFingerprints(projectDir)?.assets;
  function assetInputsUnchanged(shot: PendingShot): boolean {
    return (
      !force &&
      compareStageFingerprint(recordedAssets?.[shot.id], assetsFingerprintFor(shot)) !== "mismatch"
    );
  }

  // Shots run concurrently, so each one must not rewrite stage-fingerprints.json
  // on its own (the last writer would erase the others): accumulate and persist
  // once the batch settles.
  const fingerprints: Record<string, string> = {};
  function rememberAssetInputs(shot: PendingShot): void {
    fingerprints[shot.id] = assetsFingerprintFor(shot);
  }

  async function generateVideoFor(shot: PendingShot, manifestShot: ManifestShot): Promise<boolean> {
    if (!videoProvider || !videoProvider.isRemote) {
      return false;
    }
    const relativePath = shotVideoRelative(shot.id);
    const outputPath = shotVideoPath(projectDir, shot.id);
    // Resume support: if an earlier run already produced this shot's video —
    // either at the conventional path or the provider-returned path still
    // recorded in the manifest — and the inputs behind it are unchanged, reuse
    // it instead of paying for a duplicate generation. Only files inside the
    // project dir are ever trusted.
    if (assetInputsUnchanged(shot) && reusableAssetExists(projectDir, outputPath)) {
      manifestShot.assetKind = "video";
      manifestShot.assetPath = relativePath;
      rememberAssetInputs(shot);
      result.reused += 1;
      result.succeeded += 1;
      return true;
    }
    if (manifestShot.assetKind === "video" && manifestShot.assetPath) {
      const recorded = resolve(projectDir, manifestShot.assetPath);
      if (assetInputsUnchanged(shot) && reusableAssetExists(projectDir, recorded)) {
        rememberAssetInputs(shot);
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
        referenceImagePaths: videoReferencesFor(shot, manifestShot)
      });
      const finalPath = generated.outputPath || outputPath;
      if (!existsSync(finalPath)) {
        throw new Error("provider returned no video file");
      }
      assertPathWithinProject(projectDir, finalPath, "video");
      manifestShot.assetKind = "video";
      manifestShot.assetPath = finalPath === outputPath ? relativePath : finalPath;
      rememberAssetInputs(shot);
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
        // The kept image is a valid asset for these inputs; record it so the
        // next run reuses the same way instead of re-attempting the video.
        rememberAssetInputs(shot);
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
    const relativePath = shotImageRelative(shot.id);
    const outputPath = shotImagePath(projectDir, shot.id);
    // Same resume logic as the video branch: reuse a previously generated
    // scene image when the inputs are unchanged and the file is already
    // present inside the project dir.
    if (assetInputsUnchanged(shot) && reusableAssetExists(projectDir, outputPath)) {
      manifestShot.assetKind = "image";
      manifestShot.assetPath = relativePath;
      rememberAssetInputs(shot);
      result.reused += 1;
      result.succeeded += 1;
      return true;
    }
    if (manifestShot.assetKind === "image" && manifestShot.assetPath) {
      const recorded = resolve(projectDir, manifestShot.assetPath);
      if (assetInputsUnchanged(shot) && reusableAssetExists(projectDir, recorded)) {
        rememberAssetInputs(shot);
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
        aspectRatio: artifacts.brief.aspectRatio,
        // The user's own photos keep the character and the location consistent
        // across shots — without them every shot is an unrelated text-to-image
        // roll. Providers that cannot take references ignore the list, so this
        // stays a plain text-to-image call for e.g. OpenAI's endpoint.
        referenceImages: userImagesFor(shot)
      });
      const finalPath = generated.outputPath || outputPath;
      if (!existsSync(finalPath)) {
        throw new Error("provider returned no image file");
      }
      assertPathWithinProject(projectDir, finalPath, "image");
      manifestShot.assetKind = "image";
      manifestShot.assetPath = finalPath === outputPath ? relativePath : finalPath;
      rememberAssetInputs(shot);
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

  await runConcurrent(
    generatedShots.map((shot) => async () => {
      await generateOne(shot);
      settled += 1;
      reportProgress?.(`Scene assets ${settled}/${generatedShots.length} done`);
    }),
    ASSET_PREP_CONCURRENCY
  );

  if (result.succeeded > 0) {
    writeRenderManifestFile(projectDir, artifacts.renderManifest);
  }
  if (Object.keys(fingerprints).length > 0) {
    recordStageFingerprints(projectDir, { assets: fingerprints });
  }
  return result;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：删除项目根下的 brief.json、script.json、script.md、storyboard.json 中间产物（渲染完成后瘦身）。
 */
export function trimProjectArtifacts(projectDir: string): void {
  for (const name of ["brief.json", "script.json", "script.md", "storyboard.json"]) {
    const target = join(projectDir, name);
    if (existsSync(target)) {
      rmSync(target, { force: true });
    }
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：清空渲染工作目录 captions、.render_tmp，并清掉 audio 下全部可再生中间产物。
 * `audio/bgm.*` 是用户上传或外部来源的**资产**，不是可再生的中间物——清理阶段无权删除它，
 * 否则用户勾上「渲染后清理」就会连同自己选的背景音乐一起丢掉。
 */
export function cleanupRenderWorkspace(projectDir: string): void {
  for (const name of ["captions", ".render_tmp"]) {
    const target = join(projectDir, name);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
  }
  const audioDir = join(projectDir, "audio");
  if (!existsSync(audioDir)) {
    return;
  }
  for (const entry of readdirSync(audioDir, { withFileTypes: true })) {
    // 只认 `bgm.<扩展名>` 这一种保留，其余（逐镜 wav、.segments/ 临时分段）一律清掉；
    // 用 basename 精确比对而非前缀匹配，避免把 `bgm-v2.mp3` 这类同前缀文件也当成资产保留。
    if (entry.isFile() && PROJECT_BGM_EXTS.some((ext) => entry.name === `${PROJECT_BGM_BASENAME}.${ext}`)) {
      continue;
    }
    rmSync(join(audioDir, entry.name), { recursive: true, force: true });
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：扫描 projectsDir 下的子目录，递归删除 mtime 超过 maxAgeDays 天的项目并返回删除路径列表；maxAgeDays 非正数时抛错。
 * @param options.skip 对每个过期目录的额外否决权：返回 true 时不删（服务端用它保护仍在跑/等人工的任务）。
 *                    只按 mtime 判断的清理无法知道哪些项目正被任务引擎持有，所以把判断权留给调用方。
 */
export function cleanupExpiredProjects(
  projectsDir: string,
  maxAgeDays: number,
  options: { skip?: (projectDir: string, projectId: string) => boolean } = {}
): string[] {
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
      if (options.skip?.(target, entry.name)) {
        continue;
      }
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
  }

  return removed;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：生成「时间戳-slug 种子-随机 8 位」形式的项目 id。
 */
export function createProjectId(seed?: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = slugify(seed || "project");
  return `${stamp}-${slug}-${randomUUID().slice(0, 8)}`;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：拼出项目目录的绝对路径 resolve(cwd, projectsDir, projectId)。
 */
export function resolveProjectDir(cwd: string, projectsDir: string, projectId: string): string {
  return resolve(cwd, projectsDir, projectId);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：由请求与技能构建创作简报：补默认语言/平台，汇总素材图片说明并生成中文创意方向描述。
 */
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
    ...(request.dialogue ? { dialogue: request.dialogue } : {}),
    selectedSkillId: skill.id,
    selectedSkillName: skill.name,
    language,
    platform,
    aspectRatio: request.aspectRatio,
    durationSeconds: request.durationSeconds,
    creativeDirection: `围绕「${promptSummary || skill.description}」生成 ${skill.name} 风格视频，${imageSummary}。`
  };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：优先调用文本模型生成脚本 JSON（解析出非空 scenes 才采用并归一化，异常告警回退），否则走本地规则生成。
 */
async function buildScriptPackage(
  brief: BriefDocument,
  textProvider: TextModelProvider | undefined,
  skill: SkillDefinition
): Promise<ScriptPackage> {
  if (textProvider) {
    try {
      const raw = await textProvider.generateText({
        systemPrompt: buildScriptSystemPrompt(skill, brief),
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：拼装脚本生成的系统提示词：注入技能的语气/文案规则/镜头规则与该技能为当前平台准备的平台规则，并声明必须返回的 JSON 字段结构。
 * 无论有没有台词都追加画面一致性约束：图像模型逐镜独立推理，同一场景的几镜不会「自己保持一致」，只能靠提示词每镜写全。
 * 台词段只在用户给了台词时追加：roles/lines 的形状与「逐字使用、不得改写」的硬约束。
 * 没给台词时提示词只比引入台词功能之前多出上面这段一致性约束——台词段一字不加，
 * 模型不会凭空编出对白（那会把一个纯旁白片变成对不上嘴型的「对话片」）。
 * @param skill 选中的技能
 * @param brief 创作简报；只有 brief.dialogue 存在时才追加台词段
 */
function buildScriptSystemPrompt(skill: SkillDefinition, brief: BriefDocument): string {
  const platform = brief.platform;
  const platformRules = skill.platformRules[platform] ?? [];
  return [
    "你是一名短视频编导。",
    `当前 skill: ${skill.id} / ${skill.name}`,
    `文案风格：${skill.tone}`,
    `文案规则：${skill.copyRules.join("；")}`,
    `镜头规则：${skill.shotRules.join("；")}`,
    ...(platformRules.length > 0 ? [`发布平台：${platform}`, `平台规则：${platformRules.join("；")}`] : []),
    "返回 JSON，字段必须包含：title, summary, openingHook, voiceover, scenes, bgmStyle, cta, hashtags。",
    "scenes 是数组；每个元素必须包含 id, heading, narration, visualPrompt, shotType, durationSeconds, caption。",
    ...SCENE_CONTINUITY_PROMPT_RULES,
    ...(brief.dialogue ? DIALOGUE_PROMPT_RULES : [])
  ].join("\n");
}

/**
 * 无条件追加的画面一致性约束。远端图/视频模型是「一镜一次调用」，同一个人物、同一个场景在第二镜就是全新的推理，
 * 前一镜长什么样它根本看不见；能跨镜传下去的只有写进每一镜 visualPrompt 的文字。所以不要求模型「保持连贯」，
 * 而是要求它把连贯所依赖的东西（地点、光线、人物外观）在每一镜里重复写全——这是提示词层面唯一能兑现的锚定。
 * 刻意不含「平台规则：」四字：既有单测用它判定平台段有没有被注入。
 */
const SCENE_CONTINUITY_PROMPT_RULES = [
  "画面一致性是硬约束：每个镜头的 visualPrompt 都要自包含，因为画面由模型逐镜独立生成，它看不到其他镜头。",
  "同一场景（同一地点、同一时段）的多个镜头，必须在该镜 visualPrompt 里重复写明相同的地点、光线、色调与人物外观；不许这一镜写「咖啡店靠窗」、下一镜只写「她抬起头」。",
  "人物外观每次出场都按同一套说法写全（发型、服装、体型、年龄段），不要中途换装、换发型或换年龄段。",
  "同一场景的镜头只用镜头景别、机位和动作来区分，不为区分而改变地点与人物外观。"
];

/**
 * 用户提供了台词时才追加的提示词段落。三条都写死成硬约束：
 * 1. 台词逐字进 lines 且 src="user"——这是用户在界面上的原始说法，改写一句都算违约；
 * 2. roles 是可选的角色表，最多 4 个，id 由你自己定但要与 lines[].speaker 对得上；
 * 3. 没台词的镜头也允许有 lines（你新写的对白），必须标 src="generated"。
 * 刻意不含「平台规则：」四字：既有单测用它判定平台段有没有被注入。
 */
const DIALOGUE_PROMPT_RULES = [
  "本片有用户提供的台词（dialogue）。用户台词是最强约束：必须原样放进对应镜头的 scenes[].lines[].text，",
  "标 src=\"user\"，一个字、一个标点、一个空格都不许改，不许润色、缩写、扩写或换语序。",
  "可以新增角色对话（src=\"generated\"），但不得改动用户台词本身。",
  "可选 roles 字段：数组，最多 4 个，元素为 { id, name, voice?, appearance? }；id 只用字母、数字、下划线或连字符。",
  "scenes[].lines 是数组，元素为 { speaker?, text, src }；speaker 必须是 roles 里出现过的 id；一镜最多 3 条，单条不超过 30 字。",
  "lines 与 narration 并存：lines 是镜内对白，narration 是旁白/画外音；不要为了写对白而把旁白清空。"
];

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把 brief 的关键字段序列化为 JSON 作为脚本生成的用户提示词（图片只传文件名）。
 * 台词原样带进提示词；没有台词时 JSON.stringify 会略去该键，提示词形状与引入台词之前逐字节一致。
 */
function buildScriptUserPrompt(brief: BriefDocument): string {
  return JSON.stringify(
    {
      theme: brief.theme,
      content: brief.content,
      dialogue: brief.dialogue,
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

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：离线规则生成脚本包：按时长选择镜头数并均分时长，套用技能的 hooks/ctas/文案与镜头规则逐镜拼出旁白、字幕与提示词。
 * 平台规则并入文案规则轮转：平台差异不再只体现为一个 hashtag，而是真的改变旁白写法；该技能没为当前平台写规则时行为与加入前一致。
 * 用户给了台词时，把台词按行铺到各镜的 lines 上（src="user"）：没有远端模型时台词同样不能丢，
 * 否则「我给的台词」在离线路径上会被整段静默丢弃——这比生成得不好更不可接受。
 */
function buildLocalScriptPackage(brief: BriefDocument, skill: SkillDefinition): ScriptPackage {
  const shotCount = computeShotCount(brief.durationSeconds);
  const durations = splitDuration(brief.durationSeconds, shotCount);
  const titleCore = brief.theme ?? brief.content?.slice(0, 18) ?? "AI 自动视频";
  const openingHook = pickByIndex(skill.hooks, 0);
  const cta = pickByIndex(skill.ctas, 0);
  const focus = brief.content ?? brief.theme ?? "核心卖点";
  const copyRules = [...skill.copyRules, ...(skill.platformRules[brief.platform] ?? [])];
  const dialogueLines = splitDialogueIntoLines(brief.dialogue);

  const scenes = durations.map((durationSeconds, index) => {
    const step = index + 1;
    const heading = buildSceneHeading(step, shotCount);
    const narration = [
      step === 1 ? openingHook : `第 ${step} 个重点直接展开`,
      `${focus} 的关键点是 ${pickByIndex(copyRules, index)}`,
      `画面呈现建议：${pickByIndex(skill.shotRules, index)}。`
    ].join("，");
    const caption = index === shotCount - 1 ? cta : `重点 ${step}`;
    // 台词逐句均分到各镜（末镜收余数）：均分而不是全塞第一镜，是为了让每段画面都有话说。
    const lines = collectSceneDialogue(dialogueLines, index, shotCount);
    return {
      id: `scene-${step}`,
      heading,
      narration,
      visualPrompt: `${skill.name} 风格，${heading}，${pickByIndex(skill.shotRules, index)}，突出 ${titleCore}`,
      shotType: index % 2 === 0 ? "medium" : "close-up",
      durationSeconds,
      caption,
      ...(lines.length > 0 ? { lines } : {})
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

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把用户台词切成一句一条：只按换行与句末标点切（标点留在句内），切完去掉首尾空白，内容一个字不改。
 * 不切分的话整段台词会挤进一个镜头，30 秒的片子配 200 字台词根本念不完；过度切分则会把一句话拆成两段半句。
 * @param dialogue 用户提供的整段台词；缺省时返回空数组
 * @returns 逐句台词原文（已去首尾空白，内部字符原样）
 */
function splitDialogueIntoLines(dialogue: string | undefined): string[] {
  if (!dialogue || !dialogue.trim()) {
    return [];
  }
  return dialogue
    .split(/(?<=[。！？!?…；;])|\n+/u)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：按「第几个镜头 / 总共几个镜头」取出该镜应说的台词，逐句均分，末镜收下所有余数。
 * 均分**不受单镜上限约束**：台词是用户给的，宁可一镜多念两句，也不能因为镜头不够多就把后面的话丢掉。
 * @param all 逐句台词
 * @param sceneIndex 镜头下标（0 起）
 * @param sceneCount 镜头总数
 * @returns 该镜的台词（src 一律为 "user"）
 */
function collectSceneDialogue(all: string[], sceneIndex: number, sceneCount: number): ScriptLine[] {
  if (all.length === 0) {
    return [];
  }
  const count = Math.max(1, sceneCount);
  const perScene = Math.ceil(all.length / count);
  const start = sceneIndex * perScene;
  const end = sceneIndex >= count - 1 ? all.length : start + perScene;
  return all.slice(start, end).map((text) => ({ text, src: "user" as const }));
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：归一化角色表：丢弃非对象与 id 不合法的项、按 id 去重、截断到 MAX_ROLES 个；name 缺省回落到 id。
 * id 单独校验而不走 slugify——它是 lines[].speaker 的引用键，改写 id 会让台词与角色对不上。
 * @param roles 模型返回的原始 roles（类型未知，可能是任何 JSON）
 * @returns 清洗后的角色表（可能为空，调用方据此决定是否落字段）
 */
function normalizeRoles(roles: unknown): ScriptRole[] {
  if (!Array.isArray(roles)) {
    return [];
  }
  const seen = new Set<string>();
  const result: ScriptRole[] = [];
  for (const item of roles) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const raw = item as Partial<ScriptRole>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || !ROLE_ID_PATTERN.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const voice = typeof raw.voice === "string" ? raw.voice.trim() : "";
    const appearance = typeof raw.appearance === "string" ? raw.appearance.trim() : "";
    result.push({
      id,
      name: sanitizeText(raw.name, id),
      ...(voice ? { voice } : {}),
      ...(appearance ? { appearance } : {})
    });
    if (result.length >= MAX_ROLES) {
      break;
    }
  }
  return result;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：归一化单镜台词：非数组一律视为没有台词（不构造空数组字段，保证无台词项目产物逐字节不变）；
 * 文本只去首尾空白、内部原样保留（src="user" 是用户原话，改一个标点都算违约）；
 * speaker 必须能在角色表里找到，否则丢掉该字段而不是丢掉整句——对白比音色重要。
 * @param lines 模型返回的原始 lines
 * @param roleIds 已归一化角色表的 id 集合
 * @returns 清洗后的台词（超出一镜上限的部分丢弃）
 */
function normalizeLines(lines: unknown, roleIds: Set<string>): ScriptLine[] {
  if (!Array.isArray(lines)) {
    return [];
  }
  const result: ScriptLine[] = [];
  for (const item of lines) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const raw = item as Partial<ScriptLine>;
    if (typeof raw.text !== "string" || !raw.text.trim()) {
      continue;
    }
    const text = raw.text.trim();
    const speaker = typeof raw.speaker === "string" ? raw.speaker.trim() : "";
    result.push({
      ...(speaker && roleIds.has(speaker) ? { speaker } : {}),
      text,
      src: raw.src === "user" ? "user" : "generated"
    });
    if (result.length >= MAX_LINES_PER_SCENE) {
      break;
    }
  }
  return result;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：归一化并校验一份素材来源声明：不是对象、或 kind 不在四种来源内时视为「未声明」（返回 undefined，调用方不落字段）。
 * `stock` 缺 `sourceUrl` 或 `license`、`ai_generated` 缺 `provider` 时抛出明确错误，而不是静默降级成标题卡——
 * 一片没有标注出处的素材，用户会以为是自己可以随便用的（误导比缺失更伤信任）；错误信息带上定位文案，便于指出是哪一镜。
 * `user_uploaded` 的 `license` 缺省记 "user-provided"；其余字段去首尾空白后按需展开，空值不落键。
 * @param raw 模型或调用方给出的原始声明（类型未知，可能是任何 JSON）
 * @param where 出错时的定位文案，如「镜头 2」「全片 BGM」
 * @returns 清洗后的声明；没有声明时返回 undefined
 */
function normalizeProvenance(raw: unknown, where: string): AssetProvenance | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const item = raw as Partial<AssetProvenance>;
  const { kind } = item;
  if (kind !== "user_uploaded" && kind !== "ai_generated" && kind !== "stock" && kind !== "library") {
    return undefined;
  }
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const provider = text(item.provider);
  const license = text(item.license);
  const sourceUrl = text(item.sourceUrl);
  const attribution = text(item.attribution);
  const retrievedAt = text(item.retrievedAt);
  if (kind === "stock" && (!sourceUrl || !license)) {
    throw new Error(`${where} 的素材声明不合法：kind="stock" 必须同时给出 sourceUrl 与 license（无出处或无许可的素材不进分镜）。`);
  }
  if (kind === "ai_generated" && !provider) {
    throw new Error(`${where} 的素材声明不合法：kind="ai_generated" 必须给出 provider。`);
  }
  const resolvedLicense = license ?? (kind === "user_uploaded" ? "user-provided" : undefined);
  return {
    kind,
    ...(provider ? { provider } : {}),
    ...(resolvedLicense ? { license: resolvedLicense } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(attribution ? { attribution } : {}),
    ...(retrievedAt ? { retrievedAt } : {})
  };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：归一化模型返回的脚本：逐字段清洗兜底（空值用本地脚本补齐）、裁剪场景数上限，并把各镜时长缩放至总和等于请求时长。
 * 台词在这里过两道关：角色表先归一化（后面校验 speaker 要用），每镜 lines 显式覆盖——不清洗就会被 `...scene` 原样透传落盘；
 * 用户台词再按「逐字节比对 + 缺失补回」收口，模型改写或漏掉的那一句会被换成用户原文，而不是照单全收。
 * 素材来源声明也在这里收口（镜级与全片 BGM 各一道）：它是对外交付物的一部分，不合规就如实抛错。
 */
function normalizeScriptPackage(script: ScriptPackage, brief: BriefDocument): ScriptPackage {
  const fallback = buildLocalScriptPackage(brief, getSkillById(brief.selectedSkillId)!);
  const roles = normalizeRoles((script as { roles?: unknown }).roles);
  const roleIds = new Set(roles.map((role) => role.id));
  const authenticDialogue = new Set(splitDialogueIntoLines(brief.dialogue));
  // 模型几乎不会主动给 bgmProvenance（提示词里没有这个字段），但真给了就必须过同一道校验，
  // 不能让它带着「stock 却没有 license」的声明落进 script.json。
  const bgmProvenance = normalizeProvenance(script.bgmProvenance, "全片 BGM");

  const rawScenes = Array.isArray(script.scenes) ? script.scenes.slice(0, MAX_SCENES) : [];
  const scenes = rawScenes.map((scene, index) => {
    const heading = sanitizeText(scene.heading, `镜头 ${index + 1}`);
    const narration = sanitizeText(scene.narration, heading);
    // 把模型给的 lines 从透传字段里摘出来：只保留与用户原话逐字节相等的那几句 src="user"，
    // 其余交给经典清洗。这样模型若悄悄润色了台词，成品里出现的一定是用户自己写的版本。
    // 反过来，模型把用户原话标成了 generated 的，就地改回 user——那句话本来就是用户说的，
    // 不认回来补句阶段还会再补一遍，同一句台词在片子里念两次。
    const { lines: rawLines, provenance: rawProvenance, ...rest } = scene;
    const lines = normalizeLines(rawLines, roleIds)
      .filter((line) => line.src !== "user" || authenticDialogue.has(line.text))
      .map((line) => (authenticDialogue.has(line.text) ? { ...line, src: "user" as const } : line));
    const provenance = normalizeProvenance(rawProvenance, `镜头 ${index + 1}`);
    return {
      ...rest,
      id: sanitizeId(scene.id, index + 1),
      heading,
      narration,
      visualPrompt: sanitizeText(scene.visualPrompt, heading),
      caption: sanitizeText(scene.caption, heading),
      shotType: sanitizeText(scene.shotType, "medium"),
      durationSeconds: normalizeDurationValue(scene.durationSeconds),
      ...(lines.length > 0 ? { lines } : {}),
      ...(provenance ? { provenance } : {})
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
  restoreUserDialogue(usableScenes, authenticDialogue);
  // 角色外观在这里收口而不是等到调用远端前一刻：落到 scene.visualPrompt 上，
  // storyboard.json / script.md / 镜头墙 / assets 指纹看到的才是同一份提示词，用户也能看见并改。
  // 只有同时「声明了外观」且「本镜台词里真的出场」的角色才参与拼接：旁白镜不该被塞进一个没露脸的人。
  const appearances = new Map(
    roles.flatMap((role) =>
      role.appearance ? [[role.id, { name: role.name, appearance: role.appearance }] as const] : []
    )
  );
  for (const scene of usableScenes) {
    scene.visualPrompt = withCharacterAppearance(scene, appearances);
  }

  return {
    title: sanitizeText(script.title, fallback.title),
    summary: sanitizeText(script.summary, fallback.summary),
    openingHook: sanitizeText(script.openingHook, fallback.openingHook),
    voiceover: sanitizeText(script.voiceover, usableScenes.map((scene) => scene.narration).join(" ")),
    scenes: usableScenes,
    bgmStyle: sanitizeText(script.bgmStyle, fallback.bgmStyle),
    cta: sanitizeText(script.cta, fallback.cta),
    hashtags: Array.isArray(script.hashtags) && script.hashtags.length > 0 ? script.hashtags : fallback.hashtags,
    ...(roles.length > 0 ? { roles } : {}),
    ...(bgmProvenance ? { bgmProvenance } : {})
  };
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把用户台词里「没有出现在任何一镜 lines 中」的句子补回去（src="user"），保证给定的每一句都真的进了成片。
 * 先放还有余量的镜头，全都满了再从台词最少的那镜插队——宁可一镜多一句，也不能让用户的话凭空消失。
 * @param scenes 已归一化的镜头（就地修改）
 * @param authentic 用户台词全集（逐句原文）
 */
function restoreUserDialogue(scenes: ScriptScene[], authentic: Set<string>): void {
  if (authentic.size === 0 || scenes.length === 0) {
    return;
  }
  const present = new Set<string>();
  for (const scene of scenes) {
    for (const line of scene.lines ?? []) {
      if (line.src === "user") {
        present.add(line.text);
      }
    }
  }
  const missing = [...authentic].filter((text) => !present.has(text));
  for (const text of missing) {
    const target =
      scenes.find((scene) => (scene.lines?.length ?? 0) < MAX_LINES_PER_SCENE) ??
      scenes.reduce((fewest, scene) =>
        (scene.lines?.length ?? 0) < (fewest.lines?.length ?? 0) ? scene : fewest
      );
    target.lines = [...(target.lines ?? []), { text, src: "user" }];
  }
}

/**
 * @author zhangbaohong  @date 2026-10-26  @see https://github.com/1241751430/AIVideo.git
 * 功能：解析参考镜绑定的 brief.inputImages 下标：优先用镜头自带的 inputImageIndex（按 id 绑定），缺失时回退到当前下标——旧项目在生成时参考镜恰好占据前 N 个位置，回退即正确。
 * @param shot 分镜镜头（至少含 inputImageIndex）
 * @param fallbackIndex 该镜头在当前 storyboard 中的位置
 * @returns 应使用的 brief.inputImages 下标
 */
export function resolveInputImageIndex(
  shot: Pick<StoryboardShot, "inputImageIndex">,
  fallbackIndex: number
): number {
  return shot.inputImageIndex ?? fallbackIndex;
}

/**
 * @author zhangbaohong  @date 2026-11-03  @see https://github.com/1241751430/AIVideo.git
 * 功能：把本镜出场角色的外观描述拼到 visualPrompt 末尾——兑现 `ScriptRole.appearance` 在类型注释里承诺过、
 * 但此前全仓没有任何代码兑现的那句话。图像模型逐镜独立推理，角色表里写好的外观若只存在于 script.json，
 * 远端根本收不到，同一个角色在每一镜都会重新「长」一张脸。
 * 只拼「本镜台词里点名的 speaker 且声明了外观」的角色：旁白镜不塞没露脸的人，没声明外观的角色也不硬编。
 * 产物里不含外观的镜头与改动前逐字节一致——没有台词/外观的项目不受影响。
 * @param scene 已归一化的镜头（取 visualPrompt 与 lines[].speaker）
 * @param appearances 角色 id → { name, appearance }；只含确实声明了外观的角色
 * @returns 拼好外观的提示词（没有出场角色或已拼过时原样返回）
 */
function withCharacterAppearance(
  scene: ScriptScene,
  appearances: Map<string, { name: string; appearance: string }>
): string {
  if (appearances.size === 0) {
    return scene.visualPrompt;
  }
  const seen = new Set<string>();
  const described: string[] = [];
  for (const line of scene.lines ?? []) {
    const role = line.speaker ? appearances.get(line.speaker) : undefined;
    // 同一角色一镜里说了几句：外观只说一次，重复描述只会让提示词变长而不变准。
    if (!role || seen.has(line.speaker!)) {
      continue;
    }
    seen.add(line.speaker!);
    described.push(`${role.name}：${role.appearance}`);
  }
  if (described.length === 0) {
    return scene.visualPrompt;
  }
  const suffix = `（人物外观：${described.join("；")}）`;
  // 幂等：editing.ts 会把 storyboard 的 visualPrompt 单向镜像回 script，重排或再次构建时别叠第二遍。
  return scene.visualPrompt.includes(suffix) ? scene.visualPrompt : `${scene.visualPrompt}${suffix}`;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：由脚本 scenes 构建分镜：首镜 cut 其余 fade；按「每张用户图只喂一个镜头」规则分配 reference_image/generated_image/title_card 资产来源。
 * 角色外观已在 normalizeScriptPackage 里拼进 scene.visualPrompt（见 withCharacterAppearance），这里只做搬运，
 * 因此 storyboard.json、素材指纹与 script.md 看到的是同一份提示词。
 * @param request 归一化后的生成请求
 * @param script 脚本包
 * @param hasRemoteVisual 是否存在远端图片/视频能力；为 false 时 video 模式也不标 generated_image
 */
function buildStoryboard(request: GenerateRequest, script: ScriptPackage, hasRemoteVisual: boolean): Storyboard {
  const shots: StoryboardShot[] = script.scenes.map((scene, index) => {
    // Per-shot mixing: each user image is spent on exactly one shot (shot i
    // takes images[i]); once they run out, later shots fall back to generated
    // assets. Reusing one photo across the whole video reads as a slideshow.
    const ownsImage = Boolean(request.images && index < request.images.length);
    return {
      id: scene.id,
      title: scene.heading,
      narration: scene.narration,
      caption: scene.caption,
      visualPrompt: scene.visualPrompt,
      shotType: scene.shotType,
      durationSeconds: scene.durationSeconds,
      transition: index === 0 ? "cut" : "fade",
      // `generated_image` 只在真有能力生成时才写：没有远端图/视频能力时，
      // 这一镜最终一定是一张标题卡，标成「生成图」会让界面显示「AI 生成」而实际什么都没有。
      // 这是刻意的语义修正，会改变 storyboard.json 的内容——误导比缺失更伤信任。
      assetSource: ownsImage
        ? "reference_image"
        : request.mode === "video" && hasRemoteVisual
          ? "generated_image"
          : "title_card",
      // The binding is recorded once, by id, at build time: reordering shots
      // later must not move the user's photo to a different shot. Only
      // reference shots carry the key, so the in-memory storyboard stays
      // byte-identical to what storyboard.json round-trips back.
      ...(ownsImage ? { inputImageIndex: index } : {}),
      // Dialogue rides along only when the scene actually has some: a project
      // without lines must keep producing a byte-identical storyboard.json,
      // and the audio stage treats a missing `lines` as "speak narration only".
      ...(scene.lines && scene.lines.length > 0 ? { lines: scene.lines } : {}),
      // 来源声明同理按需展开：没有声明的项目，storyboard.json 与引入该字段前逐字节相同。
      ...(scene.provenance ? { provenance: scene.provenance } : {})
    };
  });

  return {
    aspectRatio: request.aspectRatio,
    durationSeconds: request.durationSeconds,
    shots
  };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：按各镜时长累加时间轴游标，把分镜逐条转换为 startSeconds/endSeconds 字幕 cue。
 */
export function buildCaptions(storyboard: Storyboard): CaptionCue[] {
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：构建渲染清单：解析宽高比对应尺寸，参考镜指向对应序号用户图、其余指向 generated-card 占位，输出文件名为标题 slug 的 mp4。
 */
function buildRenderManifest(input: {
  request: GenerateRequest;
  storyboard: Storyboard;
  script: ScriptPackage;
  images: string[];
}): RenderManifest {
  const size = ASPECT_SIZES[input.request.aspectRatio]!;
  const shots = input.storyboard.shots.map((shot, index) => {
    // A reference shot points at the user image bound to it by id
    // (inputImageIndex), not at whatever position it currently occupies; every
    // other shot starts as a title card and gets a generated asset.
    const referencedImage =
      shot.assetSource === "reference_image"
        ? input.images[resolveInputImageIndex(shot, index)]
        : undefined;
    const hasReference = Boolean(referencedImage);
    // 第二道关：分镜可能来自落盘的 storyboard.json（不是刚归一化的脚本），
    // 所以在写进清单之前再过一次同一套校验——不合规的声明宁可让这一整次生成失败，
    // 也不能悄悄写进对外交付的 render-manifest.json。
    const provenance = normalizeProvenance(shot.provenance, `镜头 ${index + 1}`);
    return {
      shotId: shot.id,
      title: shot.title,
      durationSeconds: shot.durationSeconds,
      assetKind: hasReference ? ("image" as const) : ("generated-card" as const),
      assetPath: referencedImage,
      audioPath: `audio/${shot.id}.wav`,
      overlayText: shot.title,
      caption: shot.caption,
      visualPrompt: shot.visualPrompt,
      // 转场是渲染器真正会读的输入（cut 硬切 / 其余淡出）。老 storyboard.json 没有该字段时
      // 不落键，清单与升级前逐字节相同，渲染器那边按 fade 兜底。
      ...(shot.transition ? { transition: shot.transition } : {}),
      // 同样条件展开：没有来源声明的清单与升级前逐字节相同。
      ...(provenance ? { provenance } : {})
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把字幕 cue 序列渲染成标准 SRT 文本。
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把脚本包渲染为 Markdown 文稿：摘要/开头钩子/旁白总稿/分镜/BGM/CTA/Hashtags 各成小节。
 * 镜头有台词时在「旁白」后补台词行（用户台词标「台词」、模型写的标「对白」）；没有台词时输出与引入台词前逐字节相同。
 * 有任何来源声明（镜级或全片 BGM）时，末尾再补一节「素材与版权清单」——script.md 是对外交付物，
 * 版权标注必须跟着它走；一条声明都没有时整节不出现，输出与升级前逐字节相同。
 */
export function toScriptMarkdown(script: ScriptPackage): string {
  const scenes = script.scenes
    .map((scene, index) => {
      const base = `## 镜头 ${index + 1}: ${scene.heading}\n- 时长: ${scene.durationSeconds}s\n- 旁白: ${scene.narration}`;
      const lines = (scene.lines ?? []).map(
        (line) => `\n- ${line.src === "user" ? "台词" : "对白"}${line.speaker ? `(${line.speaker})` : ""}: ${line.text}`
      );
      return `${base}${lines.join("")}\n- 字幕: ${scene.caption}\n- 提示词: ${scene.visualPrompt}`;
    })
    .join("\n\n");

  const kindLabels: Record<AssetProvenance["kind"], string> = {
    user_uploaded: "用户上传",
    ai_generated: "AI 生成",
    stock: "网络素材",
    library: "素材库"
  };
  // 表格单元格里的竖线会把列切断（标题是自由文本），转义后再落。
  const cell = (value: string): string => value.replace(/\|/g, "\\|");
  const rows: string[] = [];
  script.scenes.forEach((scene, index) => {
    if (!scene.provenance) {
      return;
    }
    const p = scene.provenance;
    rows.push(
      `| ${cell(`镜头 ${index + 1}（${scene.heading}）`)} | ${kindLabels[p.kind]} | ${cell(p.provider ?? "—")} | ${cell(p.license ?? "—")} | ${cell(p.sourceUrl ?? "—")} | ${cell(p.attribution ?? "—")} | ${cell(p.retrievedAt ?? "—")} |`
    );
  });
  if (script.bgmProvenance) {
    const p = script.bgmProvenance;
    rows.push(
      `| 全片 BGM | ${kindLabels[p.kind]} | ${cell(p.provider ?? "—")} | ${cell(p.license ?? "—")} | ${cell(p.sourceUrl ?? "—")} | ${cell(p.attribution ?? "—")} | ${cell(p.retrievedAt ?? "—")} |`
    );
  }
  const credits =
    rows.length > 0
      ? [
          "## 素材与版权清单",
          "| 位置 | 来源 | 提供方 | 许可 | 出处 | 署名 | 获取时间 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...rows
        ].join("\n")
      : null;

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
    script.hashtags.map((tag) => `#${tag}`).join(" "),
    ...(credits ? ["", credits] : [])
  ].join("\n");
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：先直接 JSON.parse；失败则用正则抽取文本中最外层 {...}/[...] 块再解析，仍失败返回 null。
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把任意标题转为文件名安全的 slug：小写、非字母数字（含中日韩）字符归一为 -，截断 32 字符；结果为空时回退 "ai-video"。
 */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "ai-video";
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：按总时长选择镜头数：≤20 秒 4 个、≤40 秒 5 个、≤60 秒 6 个，否则 8 个。
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把总时长均分成 segments 段（0.1 秒精度），余数并入最后一段。
 */
function splitDuration(total: number, segments: number): number[] {
  const base = Math.floor((total / segments) * 10) / 10;
  const result = Array.from({ length: segments }, () => base);
  const used = result.reduce((sum, item) => sum + item, 0);
  const delta = Math.round((total - used) * 10) / 10;
  const lastIndex = result.length - 1;
  result[lastIndex] = Math.round(((result[lastIndex] ?? 0) + delta) * 10) / 10;
  return result;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：缩放一组时长使其总和精确等于 total：先按最小值清洗非法值，再等比换算并从后向前回补舍入误差，且每段不低于最小时长。
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：清洗单个时长值：非有限数或 ≤0 时回退最小镜头时长，否则原样返回。
 */
function normalizeDurationValue(value: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MIN_SHOT_DURATION_SECONDS;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：字符串且 trim 后非空则返回 trim 值，否则用 fallback。
 */
function sanitizeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把模型给的 scene id 清洗为合法 slug，空或非法时回退 scene-<序号>。
 */
function sanitizeId(value: unknown, index: number): string {
  const raw = sanitizeText(value, `scene-${index}`);
  const id = slugify(raw);
  return id || `scene-${index}`;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：按镜头序号生成中文小节标题：首镜「开场钩子」、末镜「结尾收束」、中间「核心亮点 N」。
 */
function buildSceneHeading(step: number, total: number): string {
  if (step === 1) {
    return "开场钩子";
  }
  if (step === total) {
    return "结尾收束";
  }
  return `核心亮点 ${step - 1}`;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：以 index 对数组长度取模循环取值（非空数组下一定能取到值）。
 */
function pickByIndex<T>(values: T[], index: number): T {
  return values[index % values.length]!;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把秒数格式化为 SRT 时间戳 HH:MM:SS,mmm。
 */
function formatSrtTime(value: number): string {
  const totalMilliseconds = Math.round(value * 1000);
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":") +
    `,${String(milliseconds).padStart(3, "0")}`;
}
