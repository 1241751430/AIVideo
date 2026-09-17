/**
 * @file shotFiles.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 单镜产物路径的唯一事实来源：约定 assets/<id>.mp4、assets/<id>.png、audio/<id>.wav 布局，校验 shotId 字符合法性，并提供资产/配音删除能力，支撑「删文件即重做该镜头」契约。
 * @see https://github.com/1241751430/AIVideo.git
 */

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { RenderManifest, RenderShot } from "./types.js";
import { assertPathWithin, isWithinBase, writeJsonFile } from "./utils.js";

/**
 * Single source of truth for the conventional per-shot file layout inside a
 * project directory (`assets/<id>.mp4`, `assets/<id>.png`, `audio/<id>.wav`).
 * The resume logic in `prepareGeneratedAssets`, the retry/invalidation rules
 * in `editing`, and the web server all derive shot paths from here so the
 * "delete the file to regenerate the shot" contract can never drift.
 */

/**
 * Shot ids are produced by `slugify` in workflow.ts: letters/digits (including
 * CJK) plus `-` and `_`, never a path separator or dot-run. Enforce the same
 * alphabet before ever joining an id into a path.
 */
const SHOT_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：判断 shotId 是否只含字母/数字（含中日韩文）与 - _，且不以分隔符或点开头。
 */
export function isValidShotId(shotId: string): boolean {
  return SHOT_ID_PATTERN.test(shotId);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：shotId 非法时抛出带 JSON 序列化值的错误。
 */
function assertValidShotId(shotId: string): void {
  if (!isValidShotId(shotId)) {
    throw new Error(`Invalid shot id: ${JSON.stringify(shotId)}`);
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：拼接镜头生成视频的项目内路径 assets/<id>.mp4（shotId 先做合法性校验）。
 */
export function shotVideoPath(projectDir: string, shotId: string): string {
  assertValidShotId(shotId);
  return join(projectDir, "assets", `${shotId}.mp4`);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：拼接镜头场景图片的项目内路径 assets/<id>.png（shotId 先做合法性校验）。
 */
export function shotImagePath(projectDir: string, shotId: string): string {
  assertValidShotId(shotId);
  return join(projectDir, "assets", `${shotId}.png`);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：拼接镜头配音的项目内路径 audio/<id>.wav（shotId 先做合法性校验）。
 */
export function shotAudioPath(projectDir: string, shotId: string): string {
  assertValidShotId(shotId);
  return join(projectDir, "audio", `${shotId}.wav`);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：返回视频资产在 manifest 中的相对路径写法 assets/<id>.mp4。
 */
/** Manifest-relative spelling of the conventional video asset. */
export function shotVideoRelative(shotId: string): string {
  assertValidShotId(shotId);
  return `assets/${shotId}.mp4`;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：返回图片资产在 manifest 中的相对路径写法 assets/<id>.png。
 */
/** Manifest-relative spelling of the conventional image asset. */
export function shotImageRelative(shotId: string): string {
  assertValidShotId(shotId);
  return `assets/${shotId}.png`;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：汇总该镜头可能存放付费/场景资产的全部绝对路径（两种约定写法 + manifest 记录的项目内路径），按 resolve 结果去重，并排除越出项目的记录路径以防误删。
 */
/**
 * Absolute paths that could hold this shot's paid/scene asset: both
 * conventional spellings plus the manifest-recorded path when it points
 * inside the project (providers may return a custom path). Deduplicated by
 * resolved form; out-of-project recorded paths are excluded so deletion can
 * never touch user input images or foreign files.
 */
export function manifestAssetPaths(projectDir: string, shot: RenderShot): string[] {
  const candidates = [shotVideoPath(projectDir, shot.shotId), shotImagePath(projectDir, shot.shotId)];
  if (shot.assetPath) {
    const recorded = resolve(projectDir, shot.assetPath);
    if (isWithinBase(projectDir, recorded)) {
      candidates.push(recorded);
    }
  }
  const seen = new Map<string, string>();
  for (const candidate of candidates) {
    seen.set(resolve(candidate), candidate);
  }
  return [...seen.values()];
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：删除某镜头在项目内的所有资产文件，并把 manifest 条目重置为占位（或按 restore 回退到参考图），最后始终重写 render-manifest.json。
 * @returns { deleted } 实际删除的文件路径列表
 */
/**
 * Delete every in-project asset file belonging to a shot and reset its
 * manifest entry to a placeholder (or to `restore` — e.g. a reference shot
 * going back to its user image). The manifest is always rewritten, even when
 * nothing was deleted, so a retry can never leave a stale assetPath behind.
 */
export function deleteShotGeneratedAssets(
  projectDir: string,
  manifest: RenderManifest,
  shotId: string,
  restore?: { assetKind: RenderShot["assetKind"]; assetPath?: string }
): { deleted: string[] } {
  assertValidShotId(shotId);
  const shot = manifest.shots.find((entry) => entry.shotId === shotId);
  if (!shot) {
    throw new Error(`Unknown shot: ${shotId}`);
  }
  const deleted: string[] = [];
  for (const candidate of manifestAssetPaths(projectDir, shot)) {
    assertPathWithin(projectDir, candidate, "Asset file");
    if (existsSync(candidate)) {
      rmSync(candidate, { force: true });
      deleted.push(candidate);
    }
  }
  shot.assetKind = restore?.assetKind ?? "generated-card";
  shot.assetPath = restore?.assetPath;
  writeJsonFile(join(projectDir, "render-manifest.json"), manifest);
  return { deleted };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：删除某镜头已合成的配音 wav（若存在），以便音频阶段下次重新合成。
 * @returns { deleted } 实际删除的文件路径列表
 */
/** Delete a shot's synthesized narration wav so the audio stage re-synths it. */
export function deleteShotAudio(projectDir: string, shotId: string): { deleted: string[] } {
  const audioPath = shotAudioPath(projectDir, shotId);
  assertPathWithin(projectDir, audioPath, "Audio file");
  if (existsSync(audioPath)) {
    rmSync(audioPath, { force: true });
    return { deleted: [audioPath] };
  }
  return { deleted: [] };
}
