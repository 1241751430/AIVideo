/**
 * @file fingerprints.ts
 * @author zhangbaohong
 * @date 2026-10-27
 * @description 阶段输入指纹：把「要不要重做某阶段」从「产物文件是否存在」升级为「输入是否变化」。四类载荷（script 的任务请求、assets 的每镜画面输入、audio 的每镜文案、render 的清单与素材文件）经键排序稳定序列化后取 sha256，落盘为项目根下的独立文件 stage-fingerprints.json；文件缺失、损坏或版本不符时一律视为「未知」，调用方回退到旧的文件存在性判据，因此老项目行为不变。另提供只读的 plan 视图：不执行任何阶段即可报出哪些阶段/镜头会被重做。
 * @see https://github.com/1241751430/AIVideo.git
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { BriefDocument, RenderManifest, Storyboard, StoryboardShot } from "./types.js";

/**
 * Stage input fingerprints: the rebuild criterion for each pipeline stage,
 * derived from its *inputs* rather than from the mere presence of an output
 * file. Recorded in `stage-fingerprints.json` at the project root — a separate
 * file that `trimProjectArtifacts`/`cleanupRenderWorkspace` never touch — so a
 * later run can ask "did anything this stage consumes actually change?".
 *
 * Only equality matters, never ordering: every payload is serialized with
 * sorted keys, so an object literal reordered in code cannot invalidate a
 * project. A missing, corrupt or version-mismatched file reports "unknown",
 * which callers must treat as "fall back to the legacy existence check".
 */

/** 指纹文件（项目根下，与渲染产物分离）。 */
export const STAGE_FINGERPRINTS_FILE = "stage-fingerprints.json";

/** 指纹算法版本：参与每次哈希，改算法即整体失效，不会把旧指纹误判为一致。 */
const STAGE_FINGERPRINTS_VERSION = 1;

/** 可记录指纹的四个流水线阶段。 */
export type FingerprintStage = "script" | "assets" | "audio" | "render";

/**
 * 指纹比较结论：`unknown` 表示该项目（或该镜头）没有可用指纹——老项目、
 * 指纹文件缺失/损坏，或该阶段从未成功执行过。调用方此时必须回退到旧判据。
 */
export type FingerprintStatus = "match" | "mismatch" | "unknown";

/** stage-fingerprints.json 的磁盘结构：script/render 为单值，assets/audio 按镜头 id 记录。 */
export interface StageFingerprintFile {
  version: number;
  script?: string;
  assets?: Record<string, string>;
  audio?: Record<string, string>;
  render?: string;
}

/** plan 视图里单个阶段的结论。 */
export interface StagePlanEntry {
  stage: FingerprintStage;
  status: FingerprintStatus;
  /** assets/audio：输入已变化、下次执行会重做的镜头 id（其余阶段不返回）。 */
  staleShots?: string[];
}

/** plan 视图需要的最小产物集合（与 `loadAssetArtifacts` 的返回值结构兼容）。 */
export interface FingerprintArtifacts {
  brief: BriefDocument;
  storyboard: Pick<Storyboard, "shots">;
  renderManifest: RenderManifest;
}

/** script 阶段的输入：任务请求本身（`skill: "auto"` 用原值，不展开成具体模板）。 */
export interface ScriptFingerprintInput {
  theme?: string;
  content?: string;
  images?: string[];
  skill: string;
  mode: string;
  aspectRatio: string;
  durationSeconds: number;
  language?: string;
  platform?: string;
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：稳定序列化：对象键按字典序输出、undefined 值跳过，使同一份输入无论字面量顺序如何都得到同一字符串。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：对载荷做 sha256（版本号一并参与，改算法即让全部旧指纹失效）。
 */
function fingerprintOf(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(stableStringify({ v: STAGE_FINGERPRINTS_VERSION, ...payload }))
    .digest("hex");
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：用「文件名 + 字节数」描述一张参考图：内容被替换（同名同大小以外的情形）即改变指纹，同时避免为每张图读全量内容。
 */
function describeInputImage(filePath: string): { name: string; size: number } {
  let size = -1;
  try {
    size = statSync(filePath).size;
  } catch {
    size = -1;
  }
  return { name: basename(filePath), size };
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：用「清单里的相对写法 + 字节数 + mtime」描述一个渲染输入文件；文件缺失记 null（删除素材本身即改变指纹）。视频动辄上百 MB，故不读内容，靠 size+mtime 识别替换。
 */
function describeRenderInput(
  projectDir: string,
  filePath: string | undefined
): { path: string; size: number; mtimeMs: number } | null {
  if (!filePath) {
    return null;
  }
  try {
    const stats = statSync(resolve(projectDir, filePath));
    return { path: filePath, size: stats.size, mtimeMs: Math.round(stats.mtimeMs) };
  } catch {
    return null;
  }
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：script 阶段指纹：主题/正文/用户要求/模板/mode/宽高比/时长/语言/平台 + 参考图（文件名与字节数）。
 */
export function scriptStageFingerprint(input: ScriptFingerprintInput): string {
  return fingerprintOf({
    stage: "script",
    theme: input.theme ?? "",
    content: input.content ?? "",
    skill: input.skill,
    mode: input.mode,
    aspectRatio: input.aspectRatio,
    durationSeconds: input.durationSeconds,
    language: input.language ?? "",
    platform: input.platform ?? "",
    images: (input.images ?? []).map((imagePath) => describeInputImage(imagePath))
  });
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：assets 阶段的单镜指纹：跟随 editing.ts 的失效矩阵——画面只认 visualPrompt（改时长/字幕不该重花图片钱），
 * 另加宽高比（决定出图尺寸）、资产来源与参考镜绑定的用户图下标（决定动的是哪张图）。不依赖 workflow.ts 以避免循环引用，下标由调用方解析后传入。
 */
export function assetsShotFingerprint(input: {
  shot: Pick<StoryboardShot, "visualPrompt" | "assetSource" | "inputImageIndex">;
  aspectRatio: string;
  /** 参考镜绑定的 brief.inputImages 下标（调用方用 resolveInputImageIndex 解析）。 */
  referenceImageIndex?: number;
}): string {
  return fingerprintOf({
    stage: "assets",
    visualPrompt: input.shot.visualPrompt,
    assetSource: input.shot.assetSource,
    aspectRatio: input.aspectRatio,
    ...(input.shot.assetSource === "reference_image"
      ? { referenceImageIndex: input.referenceImageIndex ?? input.shot.inputImageIndex ?? null }
      : {})
  });
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：audio 阶段的单镜指纹：与失效矩阵同口径——旁白文本或镜头时长变化即需重新合成（改画面/字幕不需要）。
 */
export function audioShotFingerprint(input: {
  shot: { narration: string; durationSeconds?: number };
  language?: string;
}): string {
  return fingerprintOf({
    stage: "audio",
    narration: input.shot.narration,
    durationSeconds: input.shot.durationSeconds ?? null,
    language: input.language ?? ""
  });
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：render 阶段指纹：清单里的全部渲染入参（尺寸/时长/BGM + 每镜标题、字幕、时长、画面素材与配音文件的 size/mtime）。
 * 素材被重新生成或删除都会改变指纹，因此「素材更新后成片未重渲」可以被精确识别。
 * 刻意不含 outputFile/captionsFile：它们只决定写到哪里，不决定成片内容，改路径不该触发重渲。
 */
export function renderStageFingerprint(input: {
  projectDir: string;
  manifest: RenderManifest;
}): string {
  const manifest = input.manifest;
  return fingerprintOf({
    stage: "render",
    aspectRatio: manifest.aspectRatio,
    width: manifest.width,
    height: manifest.height,
    durationSeconds: manifest.durationSeconds,
    bgmStyle: manifest.bgmStyle,
    shots: manifest.shots.map((shot) => ({
      shotId: shot.shotId,
      title: shot.title,
      overlayText: shot.overlayText,
      caption: shot.caption,
      durationSeconds: shot.durationSeconds,
      assetKind: shot.assetKind,
      asset: describeRenderInput(input.projectDir, shot.assetPath),
      audio: describeRenderInput(input.projectDir, shot.audioPath)
    }))
  });
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：判断一张「镜头 id → 指纹」表是否形状合法（损坏文件按未知处理，不让半截数据参与判断）。
 */
function isFingerprintMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：读取 stage-fingerprints.json；文件缺失、无法解析、版本不符或字段形状不对时返回 null（= 无指纹，回退旧判据）。
 */
export function readStageFingerprints(projectDir: string): StageFingerprintFile | null {
  const filePath = join(projectDir, STAGE_FINGERPRINTS_FILE);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StageFingerprintFile> | null;
    if (!parsed || typeof parsed !== "object" || parsed.version !== STAGE_FINGERPRINTS_VERSION) {
      return null;
    }
    return {
      version: STAGE_FINGERPRINTS_VERSION,
      ...(typeof parsed.script === "string" ? { script: parsed.script } : {}),
      ...(isFingerprintMap(parsed.assets) ? { assets: parsed.assets } : {}),
      ...(isFingerprintMap(parsed.audio) ? { audio: parsed.audio } : {}),
      ...(typeof parsed.render === "string" ? { render: parsed.render } : {})
    };
  } catch {
    return null;
  }
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：原子写入指纹文件（先写 .tmp 再 rename，与 job.json 同一套写法），避免并发/中断留下半截 JSON。
 */
export function writeStageFingerprints(projectDir: string, file: StageFingerprintFile): void {
  const target = join(projectDir, STAGE_FINGERPRINTS_FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...file, version: STAGE_FINGERPRINTS_VERSION }, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：合并记录：script/render 覆盖写，assets/audio 按镜头 id 合并（单镜重试只更新该镜，不会抹掉其他镜头的记录）。
 */
export function recordStageFingerprints(
  projectDir: string,
  patch: { script?: string; assets?: Record<string, string>; audio?: Record<string, string>; render?: string }
): void {
  const existing = readStageFingerprints(projectDir) ?? { version: STAGE_FINGERPRINTS_VERSION };
  writeStageFingerprints(projectDir, {
    ...existing,
    ...(patch.script !== undefined ? { script: patch.script } : {}),
    ...(patch.assets !== undefined ? { assets: { ...existing.assets, ...patch.assets } } : {}),
    ...(patch.audio !== undefined ? { audio: { ...existing.audio, ...patch.audio } } : {}),
    ...(patch.render !== undefined ? { render: patch.render } : {})
  });
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：比较「记录过的指纹」与「当前算出的指纹」；未记录时为 unknown，调用方须回退到旧的复用判据。
 */
export function compareStageFingerprint(recorded: string | undefined, current: string): FingerprintStatus {
  if (recorded === undefined) {
    return "unknown";
  }
  return recorded === current ? "match" : "mismatch";
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：按镜头汇总某阶段的指纹结论：任一镜头输入已变即 mismatch（值得重做），全部镜头都无记录才是 unknown。
 * @returns 阶段状态与该阶段需要重做的镜头 id
 */
function summarizeShotFingerprints(
  shots: StoryboardShot[],
  recorded: Record<string, string> | undefined,
  compute: (shot: StoryboardShot) => string
): { status: FingerprintStatus; staleShots: string[] } {
  const staleShots: string[] = [];
  let unknown = 0;
  for (const shot of shots) {
    const known = recorded?.[shot.id];
    if (known === undefined) {
      unknown += 1;
      continue;
    }
    if (known !== compute(shot)) {
      staleShots.push(shot.id);
    }
  }
  const status: FingerprintStatus =
    staleShots.length > 0 ? "mismatch" : unknown === shots.length ? "unknown" : "match";
  return { status, staleShots };
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：plan 视图：不执行任何阶段，只凭磁盘上的指纹与产物算出各阶段「会不会重做」以及会重做哪些镜头；
 * 老项目（无指纹文件）全部报 unknown，等价于旧行为（文件存在即复用）。
 * @param input projectDir + 可选的任务请求（缺省则 script 报 unknown，因为请求无法从磁盘还原）+ 可选产物
 * @returns 按 script → assets → audio → render 顺序的阶段结论
 */
export function buildStagePlan(input: {
  projectDir: string;
  request?: ScriptFingerprintInput;
  artifacts?: FingerprintArtifacts | null;
}): StagePlanEntry[] {
  const recorded = readStageFingerprints(input.projectDir);
  const script: StagePlanEntry = {
    stage: "script",
    status: input.request
      ? compareStageFingerprint(recorded?.script, scriptStageFingerprint(input.request))
      : "unknown"
  };
  const artifacts = input.artifacts;
  if (!artifacts) {
    return [
      script,
      { stage: "assets", status: "unknown" },
      { stage: "audio", status: "unknown" },
      { stage: "render", status: "unknown" }
    ];
  }
  const shotIndexes = new Map(artifacts.storyboard.shots.map((shot, index) => [shot.id, index]));
  const assets = summarizeShotFingerprints(artifacts.storyboard.shots, recorded?.assets, (shot) =>
    assetsShotFingerprint({
      shot,
      aspectRatio: artifacts.brief.aspectRatio,
      ...(shot.assetSource === "reference_image"
        ? { referenceImageIndex: shot.inputImageIndex ?? shotIndexes.get(shot.id) ?? 0 }
        : {})
    })
  );
  const audio = summarizeShotFingerprints(artifacts.storyboard.shots, recorded?.audio, (shot) =>
    audioShotFingerprint({ shot, language: artifacts.brief.language })
  );
  return [
    script,
    { stage: "assets", status: assets.status, staleShots: assets.staleShots },
    { stage: "audio", status: audio.status, staleShots: audio.staleShots },
    {
      stage: "render",
      status: compareStageFingerprint(
        recorded?.render,
        renderStageFingerprint({ projectDir: input.projectDir, manifest: artifacts.renderManifest })
      )
    }
  ];
}