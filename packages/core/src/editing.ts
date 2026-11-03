/**
 * @file editing.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 人工编辑落盘与失效矩阵：把脚本元信息与单镜字段（旁白/时长/提示词/字幕/台词/音色/转场等）的修改写回 project 下的各 JSON/MD 文件，并按规则删除随之过期的配音与付费资产；另含拖拽排序 reorderShots（storyboard/manifest/script/captions 四写齐）；保证下一遍流水线只重做受影响的部分。
 * @see https://github.com/1241751430/AIVideo.git
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BriefDocument, RenderManifest, ScriptLine, ScriptPackage, Storyboard } from "./types.js";
import { buildCaptions, resolveInputImageIndex, toScriptMarkdown, toSrt, MAX_DURATION_SECONDS, MAX_LINES_PER_SCENE, MIN_SHOT_DURATION_SECONDS } from "./workflow.js";
import { readRenderManifestFile, writeRenderManifestFile } from "./renderManifest.js";
import { deleteShotAudio, deleteShotGeneratedAssets, isValidShotId } from "./shotFiles.js";
import { stableStringify } from "./fingerprints.js";
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
  /**
   * 镜内台词（整组替换，不是逐条合并）。传空数组即清空台词，该镜回到「只念 narration」。
   * 缺省表示不动台词；给了就必须整体合法，否则整次编辑被拒（不做部分写入）。
   */
  lines?: ScriptLine[];
  /** 逐镜音色；传空串表示清除该镜的覆盖，回到「角色音色 → provider 默认」。 */
  voice?: string;
  /**
   * 本镜与下一镜的转场：`cut`（硬切）或 `fade`（淡出），其它取值一律拒绝——
   * `render.py` 的 `is_hard_cut` 只认 `cut`，放行别的写法等于让用户以为自己改了什么而实际没改。
   * 传空串表示回到默认规则（首镜 `cut`、其余 `fade`，与 `buildStoryboard` 同口径）。
   * 它只影响剪辑，既不删配音也不删素材；成片过期由路由的 `markVideoStale` 标记。
   */
  transition?: string;
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
    writeRenderManifestFile(projectDir, manifest);
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：编辑单个分镜并按失效矩阵清理：旁白/时长/台词/音色变化删配音、visualPrompt 变化删项目内资产（参考镜回退用户图）、转场变化只改清单输入（不删任何产物）；校验时长下限与总时长上限，同步重写 storyboard/manifest/captions.srt 并镜像回 script。
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
  // 先读一次 script.json：台词要按角色表校验 speaker，镜像回 scene 也要它。
  const script = loadScriptPackage(projectDir);
  const lines = patch.lines !== undefined ? normalizeEditLines(patch.lines, script) : undefined;
  const voice = patch.voice !== undefined ? normalizeVoiceOverride(patch.voice) : undefined;
  // 空串 = 回到默认规则（首镜 cut、其余 fade），与 buildStoryboard 同口径：分镜里的 transition 是必填的，
  // 「清除」只能落成一个具体取值，不能像 voice 那样真把键删掉。
  const transition =
    patch.transition !== undefined
      ? normalizeEditTransition(patch.transition) || (shotIndex === 0 ? "cut" : "fade")
      : undefined;

  const narrationChanged = patch.narration !== undefined && patch.narration !== shot.narration;
  const durationChanged = durationSeconds !== undefined && durationSeconds !== shot.durationSeconds;
  const visualPromptChanged = visualPrompt !== undefined && visualPrompt !== shot.visualPrompt;
  const linesChanged = lines !== undefined && stableStringify(lines) !== stableStringify(shot.lines ?? []);
  // 空串表示「清除逐镜覆盖」，与「没有这个字段」是同一件事，比较时先归一化掉。
  const voiceChanged = voice !== undefined && (voice || undefined) !== shot.voice;
  // 转场只决定怎么剪：刻意不进配音/素材的失效矩阵（为一个剪点重配旁白就是白花钱）。
  // 成片过期由路由层的 markVideoStale 标记；是否需要重渲由 renderStageFingerprint 里恒展开的 transition 判定。
  const audioInvalidated = narrationChanged || durationChanged || linesChanged || voiceChanged;
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
  if (lines !== undefined) {
    // 空数组不落键：`lines` 缺失与 `lines: []` 在配音侧等价，但前者能让 storyboard.json
    // 与「引入台词之前」逐字节相同——编辑清空台词后应当回到那个状态。
    if (lines.length > 0) {
      shot.lines = lines;
    } else {
      delete shot.lines;
    }
  }
  if (voice !== undefined) {
    if (voice) {
      shot.voice = voice;
    } else {
      delete shot.voice;
    }
  }
  if (transition !== undefined) {
    shot.transition = transition;
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
    // 转场属于清单的「声明的输入」：素材阶段重写清单时会原样带回（见 renderManifest.writeRenderManifestFile），
    // 这里同步一份，删资产那条分支（deleteShotGeneratedAssets 内部重写清单）也不会把它丢掉。
    if (transition !== undefined) {
      manifestShot.transition = transition;
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
    writeRenderManifestFile(projectDir, manifest);
  }

  writeJsonFile(join(projectDir, "storyboard.json"), storyboard);
  mkdirSync(join(projectDir, "captions"), { recursive: true });
  writeFileSync(join(projectDir, "captions", "captions.srt"), toSrt(buildCaptions(storyboard)), "utf8");

  syncScriptPackageWithShot(projectDir, shotId, shot, script);
  return { assetInvalidated, audioInvalidated, deleted };
}

/** 镜头重排结果。 */
export interface ShotReorderResult {
  /** 生效的新镜头顺序（回显客户端提交的 shotIds）。 */
  order: string[];
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：拖拽排序落盘：校验 shotIds 是分镜镜头 id 的精确重排后，同步重写 storyboard.json、render-manifest.json、
 * （id 集合一致时）script.json 与 script.md 的镜头顺序，并按新序重建 captions.srt。已生成资产随 manifest 条目
 * 自身的 assetPath 迁移、不需重生成；参考镜的用户图按 inputImageIndex（id 绑定）跟随镜头移动，重排不会换图。
 */
export function reorderShots(projectDir: string, shotIds: string[]): ShotReorderResult {
  if (!Array.isArray(shotIds) || shotIds.length === 0) {
    throw new Error("shotIds must be a non-empty array of shot ids.");
  }
  for (const id of shotIds) {
    if (typeof id !== "string" || !isValidShotId(id)) {
      throw new Error(`Invalid shot id: ${JSON.stringify(id)}`);
    }
  }
  const storyboard = loadStoryboard(projectDir);
  const manifest = loadManifest(projectDir);
  const current = storyboard.shots.map((shot) => shot.id);
  const isPermutation =
    shotIds.length === current.length && new Set(shotIds).size === shotIds.length && current.every((id) => shotIds.includes(id));
  if (!isPermutation) {
    throw new Error(`shotIds must be a permutation of the storyboard shots: ${current.join(", ")}`);
  }
  const shotById = new Map(storyboard.shots.map((shot) => [shot.id, shot]));
  const manifestById = new Map(manifest.shots.map((entry) => [entry.shotId, entry]));
  for (const id of shotIds) {
    if (!manifestById.has(id)) {
      throw new Error(`render-manifest.json is missing shot: ${id}`);
    }
  }
  storyboard.shots = shotIds.map((id) => shotById.get(id)!);
  manifest.shots = shotIds.map((id) => manifestById.get(id)!);

  writeJsonFile(join(projectDir, "storyboard.json"), storyboard);
  writeRenderManifestFile(projectDir, manifest);
  mkdirSync(join(projectDir, "captions"), { recursive: true });
  writeFileSync(join(projectDir, "captions", "captions.srt"), toSrt(buildCaptions(storyboard)), "utf8");

  const script = loadScriptPackage(projectDir);
  if (script) {
    const sceneById = new Map(script.scenes.map((scene) => [scene.id, scene]));
    if (script.scenes.length === shotIds.length && shotIds.every((id) => sceneById.has(id))) {
      script.scenes = shotIds.map((id) => sceneById.get(id)!);
      writeJsonFile(join(projectDir, "script.json"), script);
      writeFileSync(join(projectDir, "script.md"), toScriptMarkdown(script), "utf8");
    }
  }
  return { order: [...shotIds] };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：参考图镜头在生成资产被删后回退到该镜头按 id 绑定的用户图（brief.inputImages[inputImageIndex]，旧项目回退到当前位置；仍存在且非空时）；其余镜头返回 undefined（回退标题卡）。
 */
/**
 * A reference shot keeps its (free) user image as the asset fallback after the
 * generated video/image files are deleted; every other shot resets to the
 * title-card placeholder. Mirrors buildRenderManifest's provenance rule: a
 * reference shot points at the image bound to it by id, not at inputImages
 * indexed by its current position.
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
  const userImage = brief?.inputImages?.[resolveInputImageIndex(shot, shotIndex)];
  if (userImage && nonEmptyFileExists(userImage)) {
    return { assetKind: "image", assetPath: userImage };
  }
  return undefined;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验并归一化一次「整组替换」的台词编辑：必须是数组、条数不超过单镜上限、每条 text 非空、src 只能是 user/generated。
 * 与模型输出侧的 normalizeLines 有两处刻意的不同：不做部分写入（一条不合法就整次编辑被拒，避免存下半套台词）；
 * text 只去首尾空白做非空判定、落盘的仍是原文——`src: "user"` 的台词从输入到合成，任何环节都不得改写。
 * @param lines 请求体里的台词（HTTP 层直接 cast，类型未知）
 * @param script 项目的 script.json；缺省时没有角色表，speaker 一律丢弃
 * @returns 可落盘的台词数组（可能为空数组，表示清空该镜台词）
 */
function normalizeEditLines(lines: unknown, script: ScriptPackage | null): ScriptLine[] {
  if (!Array.isArray(lines)) {
    throw new Error("shot.lines must be an array.");
  }
  if (lines.length > MAX_LINES_PER_SCENE) {
    throw new Error(`shot.lines accepts at most ${MAX_LINES_PER_SCENE} lines per shot (got ${lines.length}).`);
  }
  const roleIds = new Set((script?.roles ?? []).map((role) => role.id));
  return lines.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`shot.lines[${index}] must be an object.`);
    }
    const raw = item as Partial<ScriptLine>;
    if (typeof raw.text !== "string" || raw.text.trim().length === 0) {
      throw new Error(`shot.lines[${index}].text must be a non-empty string.`);
    }
    const src = raw.src === undefined ? "generated" : raw.src;
    if (src !== "user" && src !== "generated") {
      throw new Error(`shot.lines[${index}].src must be "user" or "generated".`);
    }
    const speaker = typeof raw.speaker === "string" ? raw.speaker.trim() : "";
    // speaker 对不上角色表就丢掉该字段而不是丢整句：对白比音色重要（与 normalizeLines 同口径）。
    return {
      ...(speaker && roleIds.has(speaker) ? { speaker } : {}),
      text: raw.text,
      src
    };
  });
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验逐镜音色覆盖：必须是字符串，去首尾空白；空串表示清除覆盖（回到「角色音色 → provider 默认」）。
 * @param voice 请求体里的音色（类型未知）
 * @returns 归一化后的音色；空串代表清除
 */
function normalizeVoiceOverride(voice: unknown): string {
  if (typeof voice !== "string") {
    throw new Error("shot.voice must be a string.");
  }
  return voice.trim();
}

/**
 * @author zhangbaohong  @date 2026-11-03  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验转场取值：只接受 `cut` / `fade`（大小写与首尾空白归一），空串表示回到默认规则。
 * 不在白名单内的写法直接拒绝而不是落盘——渲染器只认 `cut`，放行 `hard_cut` 之类的写法会让用户
 * 以为自己改了剪点，成片却悄悄按 fade 走。
 * @param transition 请求体里的转场（类型未知）
 * @returns 归一化后的转场；空串代表「回到默认规则」，由调用方补成首镜 cut / 其余 fade
 */
function normalizeEditTransition(transition: unknown): string {
  if (typeof transition !== "string") {
    throw new Error("shot.transition must be a string.");
  }
  const value = transition.trim().toLowerCase();
  if (!value) {
    return "";
  }
  if (value !== "cut" && value !== "fade") {
    throw new Error('shot.transition must be "cut" or "fade".');
  }
  return value;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：当项目存在 script.json 时，把编辑后的镜头字段（含台词）镜像回对应 scene 并重写 script.json 与 script.md。
 * script 由调用方传入（updateShot 已经为校验 speaker 读过一次），避免同一份文件在一处编辑里解析两遍。
 * @param script 已加载的脚本包；null 表示该项目没有 script.json，直接跳过
 */
function syncScriptPackageWithShot(
  projectDir: string,
  shotId: string,
  shot: Storyboard["shots"][number],
  script: ScriptPackage | null
): void {
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
    // 台词镜像回 scene：script.md 的「台词/对白」段落由 scene.lines 渲染，不镜像就会与配音对不上。
    // 空台词同样不落键，保持无台词项目的 script.json 形状不变。
    if (shot.lines && shot.lines.length > 0) {
      scene.lines = shot.lines;
    } else {
      delete scene.lines;
    }
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
 * 功能：读取项目 render-manifest.json 并归一化为扁平清单；缺失、无法解析或 shots 为空时抛错。
 */
function loadManifest(projectDir: string): RenderManifest {
  const manifest = readRenderManifestFile(projectDir);
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
