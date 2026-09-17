/**
 * @file editing.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 人工编辑落盘与失效矩阵：把脚本元信息与单镜字段（旁白/时长/提示词/字幕等）的修改写回 project 下的各 JSON/MD 文件，并按规则删除随之过期的配音与付费资产，保证下一遍流水线只重做受影响的部分。
 * @see https://github.com/1241751430/AIVideo.git
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BriefDocument, RenderManifest, ScriptPackage, Storyboard } from "./types.js";
import { buildCaptions, toScriptMarkdown, toSrt, MAX_DURATION_SECONDS, MIN_SHOT_DURATION_SECONDS } from "./workflow.js";
import { deleteShotAudio, deleteShotGeneratedAssets, isValidShotId } from "./shotFiles.js";
import { nonEmptyFileExists, writeJsonFile } from "./utils.js";

/**
 * Human-edit mutations applied to a materialized project (script meta and
 * per-shot fields) together with the *invalidation rules* they trigger:
 * which on-disk assets become stale and must be deleted so the next pipeline
 * pass regenerates exactly what changed. The workbench server and any future
 * editor call into these functions instead of re-implementing the matrix.
 */

export interface ShotEditPatch {
  title?: string;
  narration?: string;
  caption?: string;
  visualPrompt?: string;
  durationSeconds?: number;
}

export interface ShotEditResult {
  /** Paid scene asset was deleted; the assets stage must regenerate it. */
  assetInvalidated: boolean;
  /** Narration audio was deleted; the audio stage must re-synthesize it. */
  audioInvalidated: boolean;
  /** Absolute paths deleted from disk while applying this edit. */
  deleted: string[];
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：读取项目的 script.json 为 ScriptPackage；缺失或 scenes 非数组时返回 null（兼容无 script.json 的旧项目）。
 */
/** Load the machine-readable script package, or null for pre-script.json projects. */
export function loadScriptPackage(projectDir: string): ScriptPackage | null {
  const parsed = readJsonOrNull<ScriptPackage>(join(projectDir, "script.json"));
  if (!parsed || !Array.isArray(parsed.scenes)) {
    return null;
  }
  return parsed;
}

export interface ScriptMetaPatch {
  title?: string;
  summary?: string;
  openingHook?: string;
  voiceover?: string;
  bgmStyle?: string;
  cta?: string;
  hashtags?: string[];
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：应用非场景级的脚本元信息编辑：重写 script.json 与 script.md，BGM 变化时同步 manifest.bgmStyle；从不触碰 manifest.outputFile 以保持旧下载链接有效。
 */
/**
 * Apply non-scene metadata edits to the script: rewrite script.json and the
 * rendered script.md (and manifest.bgmStyle when the BGM changed). Never
 * touches manifest.outputFile so previously shared download links stay valid.
 */
export function updateScriptMeta(projectDir: string, patch: ScriptMetaPatch): void {
  const script = loadScriptPackage(projectDir);
  if (!script) {
    throw new Error(`script.json not found in ${projectDir}; cannot edit script metadata.`);
  }
  for (const key of ["title", "summary", "openingHook", "voiceover", "bgmStyle", "cta"] as const) {
    const value = patch[key];
    if (value !== undefined) {
      script[key] = requireNonEmptyString(value, `script.${key}`);
    }
  }
  if (patch.hashtags !== undefined) {
    if (!Array.isArray(patch.hashtags) || patch.hashtags.length === 0) {
      throw new Error("script.hashtags must be a non-empty array of strings.");
    }
    script.hashtags = patch.hashtags.map((tag, index) => requireNonEmptyString(tag, `script.hashtags[${index}]`));
  }
  writeJsonFile(join(projectDir, "script.json"), script);
  writeFileSync(join(projectDir, "script.md"), toScriptMarkdown(script), "utf8");

  const manifest = loadManifest(projectDir);
  if (patch.bgmStyle !== undefined && manifest.bgmStyle !== script.bgmStyle) {
    manifest.bgmStyle = script.bgmStyle;
    writeJsonFile(join(projectDir, "render-manifest.json"), manifest);
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：编辑单个分镜并按失效矩阵清理：旁白/时长变化删配音、visualPrompt 变化删项目内资产（参考镜回退用户图）；校验时长下限与总时长上限，同步重写 storyboard/manifest/captions.srt 并镜像回 script。
 * @returns 资产/配音是否被使失效及被删除的文件列表（ShotEditResult）
 */
/**
 * Edit one storyboard shot and enforce the invalidation matrix:
 * narration/duration changes delete `audio/<id>.wav`; visualPrompt changes
 * delete every in-project asset file and reset the manifest entry (reference
 * shots fall back to their user image); caption/title changes only mark the
 * render stale via `videoStale` bookkeeping at the caller.
 */
export function updateShot(projectDir: string, shotId: string, patch: ShotEditPatch): ShotEditResult {
  if (!isValidShotId(shotId)) {
    throw new Error(`Invalid shot id: ${JSON.stringify(shotId)}`);
  }
  const storyboard = loadStoryboard(projectDir);
  const manifest = loadManifest(projectDir);
  const shotIndex = storyboard.shots.findIndex((shot) => shot.id === shotId);
  if (shotIndex < 0) {
    throw new Error(`Unknown shot: ${shotId}`);
  }
  const shot = storyboard.shots[shotIndex]!;

  const title = patch.title !== undefined ? requireNonEmptyString(patch.title, "shot.title") : undefined;
  const caption = patch.caption !== undefined ? requireNonEmptyString(patch.caption, "shot.caption") : undefined;
  const visualPrompt =
    patch.visualPrompt !== undefined
      ? requireNonEmptyString(patch.visualPrompt, "shot.visualPrompt")
      : undefined;
  if (patch.narration !== undefined && typeof patch.narration !== "string") {
    throw new Error("shot.narration must be a string.");
  }
  let durationSeconds: number | undefined;
  if (patch.durationSeconds !== undefined) {
    durationSeconds = Number(patch.durationSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds < MIN_SHOT_DURATION_SECONDS) {
      throw new Error(`Shot duration must be at least ${MIN_SHOT_DURATION_SECONDS} second.`);
    }
  }

  const narrationChanged = patch.narration !== undefined && patch.narration !== shot.narration;
  const durationChanged = durationSeconds !== undefined && durationSeconds !== shot.durationSeconds;
  const visualPromptChanged = visualPrompt !== undefined && visualPrompt !== shot.visualPrompt;
  const audioInvalidated = narrationChanged || durationChanged;
  const assetInvalidated = visualPromptChanged;

  if (title !== undefined) {
    shot.title = title;
  }
  if (patch.narration !== undefined) {
    shot.narration = patch.narration;
  }
  if (caption !== undefined) {
    shot.caption = caption;
  }
  if (visualPrompt !== undefined) {
    shot.visualPrompt = visualPrompt;
  }
  if (durationSeconds !== undefined) {
    shot.durationSeconds = durationSeconds;
  }

  const total = Math.round(storyboard.shots.reduce((sum, entry) => sum + entry.durationSeconds, 0) * 10) / 10;
  if (total > MAX_DURATION_SECONDS) {
    throw new Error(`Total shot duration must be ${MAX_DURATION_SECONDS} seconds or less (got ${total}).`);
  }

  const manifestShot = manifest.shots.find((entry) => entry.shotId === shotId);
  if (manifestShot) {
    if (title !== undefined) {
      manifestShot.title = title;
      manifestShot.overlayText = title;
    }
    if (caption !== undefined) {
      manifestShot.caption = caption;
    }
    if (visualPrompt !== undefined) {
      manifestShot.visualPrompt = visualPrompt;
    }
    if (durationSeconds !== undefined) {
      manifestShot.durationSeconds = durationSeconds;
    }
  }
  manifest.durationSeconds = total;

  const deleted: string[] = [];
  if (audioInvalidated) {
    deleted.push(...deleteShotAudio(projectDir, shotId).deleted);
  }
  if (assetInvalidated) {
    const restore = restoreSpecForShot(projectDir, storyboard, shotIndex);
    deleted.push(...deleteShotGeneratedAssets(projectDir, manifest, shotId, restore).deleted);
  } else {
    writeJsonFile(join(projectDir, "render-manifest.json"), manifest);
  }

  writeJsonFile(join(projectDir, "storyboard.json"), storyboard);
  mkdirSync(join(projectDir, "captions"), { recursive: true });
  writeFileSync(join(projectDir, "captions", "captions.srt"), toSrt(buildCaptions(storyboard)), "utf8");

  syncScriptPackageWithShot(projectDir, shotId, shot);
  return { assetInvalidated, audioInvalidated, deleted };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：参考图镜头在生成资产被删后回退到 brief.inputImages 中同序号的用户图（仍存在且非空时）；其余镜头返回 undefined（回退标题卡）。
 */
/**
 * A reference shot keeps its (free) user image as the asset fallback after the
 * generated video/image files are deleted; every other shot resets to the
 * title-card placeholder. Mirrors buildRenderManifest's provenance rule:
 * shot i owns inputImages[i].
 */
function restoreSpecForShot(
  projectDir: string,
  storyboard: Storyboard,
  shotIndex: number
): { assetKind: "image"; assetPath: string } | undefined {
  const shot = storyboard.shots[shotIndex];
  if (!shot || shot.assetSource !== "reference_image") {
    return undefined;
  }
  const brief = readJsonOrNull<BriefDocument>(join(projectDir, "brief.json"));
  const userImage = brief?.inputImages?.[shotIndex];
  if (userImage && nonEmptyFileExists(userImage)) {
    return { assetKind: "image", assetPath: userImage };
  }
  return undefined;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：当项目存在 script.json 时，把编辑后的镜头字段镜像回对应 scene 并重写 script.json 与 script.md。
 */
/** Mirror the edited shot into script.json/script.md when a script package exists. */
function syncScriptPackageWithShot(projectDir: string, shotId: string, shot: Storyboard["shots"][number]): void {
  const script = loadScriptPackage(projectDir);
  if (!script) {
    return;
  }
  const scene = script.scenes.find((entry) => entry.id === shotId);
  if (scene) {
    scene.heading = shot.title;
    scene.narration = shot.narration;
    scene.caption = shot.caption;
    scene.visualPrompt = shot.visualPrompt;
    scene.durationSeconds = shot.durationSeconds;
    writeJsonFile(join(projectDir, "script.json"), script);
    writeFileSync(join(projectDir, "script.md"), toScriptMarkdown(script), "utf8");
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：读取项目 storyboard.json；缺失、shots 非数组或为空时抛错。
 */
function loadStoryboard(projectDir: string): Storyboard {
  const storyboard = readJsonOrNull<Storyboard>(join(projectDir, "storyboard.json"));
  if (!storyboard || !Array.isArray(storyboard.shots) || storyboard.shots.length === 0) {
    throw new Error(`storyboard.json missing or invalid in ${projectDir}`);
  }
  return storyboard;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：读取项目 render-manifest.json；缺失、shots 非数组或为空时抛错。
 */
function loadManifest(projectDir: string): RenderManifest {
  const manifest = readJsonOrNull<RenderManifest>(join(projectDir, "render-manifest.json"));
  if (!manifest || !Array.isArray(manifest.shots) || manifest.shots.length === 0) {
    throw new Error(`render-manifest.json missing or invalid in ${projectDir}`);
  }
  return manifest;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：读取并解析 JSON 文件；文件不存在或解析失败时返回 null。
 */
function readJsonOrNull<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验 value 为非空字符串并返回 trim 后的值，否则抛出带 label 的错误。
 */
function requireNonEmptyString(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}
