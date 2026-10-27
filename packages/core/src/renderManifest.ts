/**
 * @file renderManifest.ts
 * @author zhangbaohong
 * @date 2026-10-27
 * @description render-manifest.json 的读写归一化：磁盘上把「渲染入参」（input）与「各阶段写入的执行状态」（state）分节存放，进程内一律用扁平的 RenderManifest 工作；老项目（顶层直接是 shots 数组）原样透传，读失败返回 null，因此升级无需迁移脚本。
 * @see https://github.com/1241751430/AIVideo.git
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RenderManifest, RenderManifestFile, RenderShot, RenderShotState } from "./types.js";
import { writeJsonFile } from "./utils.js";

/** 渲染清单文件名（项目根下）。 */
export const RENDER_MANIFEST_FILE = "render-manifest.json";

/** 清单磁盘格式版本：写盘时盖章，读盘不因版本不同而拒绝（形状兼容即可读）。 */
const RENDER_MANIFEST_VERSION = 1;

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：读取 render-manifest.json 并归一化为扁平清单；文件缺失、无法解析或两种格式都不是时返回 null。
 * 新格式（含 input/state 分节）按 shotId 把 state 合并回 input.shots，老格式（顶层 shots 数组）原样透传——不补默认值、不丢未知字段。
 */
export function readRenderManifestFile(projectDir: string): RenderManifest | null {
  const filePath = join(projectDir, RENDER_MANIFEST_FILE);
  if (!existsSync(filePath)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  return normalizeRenderManifest(parsed);
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：把已解析的 JSON 值归一化为扁平清单，两种磁盘格式都认；结构不认识时返回 null。
 * 供「需要自己区分 JSON 损坏与结构不识别」的调用方（如媒体路由要分别回 500/404）复用，避免二次解析。
 */
export function normalizeRenderManifest(parsed: unknown): RenderManifest | null {
  if (!isRecord(parsed)) {
    return null;
  }
  const input = parsed.input;
  if (isRecord(input) && Array.isArray(input.shots)) {
    return flattenRenderManifest(input as unknown as RenderManifestFile["input"], parsed.state);
  }
  // 老格式：顶层就是扁平清单，调用方按原字段消费，不在这里改写它。
  if (Array.isArray(parsed.shots)) {
    return parsed as unknown as RenderManifest;
  }
  return null;
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：把扁平清单确定性地拆成「入参 + 状态」写盘：每镜的 assetKind/assetPath/audioPath 落到 state.shots[shotId]，
 * 其余字段留在 input.shots；顶层未知字段自然丢弃。重排镜头时只需重排 input.shots，状态按 id 绑定、天然跟随。
 */
export function writeRenderManifestFile(projectDir: string, manifest: RenderManifest): void {
  const file: RenderManifestFile = {
    version: RENDER_MANIFEST_VERSION,
    input: {
      aspectRatio: manifest.aspectRatio,
      width: manifest.width,
      height: manifest.height,
      durationSeconds: manifest.durationSeconds,
      bgmStyle: manifest.bgmStyle,
      outputFile: manifest.outputFile,
      captionsFile: manifest.captionsFile,
      shots: manifest.shots.map((shot) => ({
        shotId: shot.shotId,
        title: shot.title,
        durationSeconds: shot.durationSeconds,
        overlayText: shot.overlayText,
        caption: shot.caption,
        visualPrompt: shot.visualPrompt
      }))
    },
    state: {
      shots: Object.fromEntries(manifest.shots.map((shot) => [shot.shotId, pickShotState(shot)]))
    }
  };
  writeJsonFile(join(projectDir, RENDER_MANIFEST_FILE), file);
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：从扁平清单条目里摘出执行状态；可选字段缺省时不落键（读回来也不会多出 undefined 值键）。
 */
function pickShotState(shot: RenderShot): RenderShotState {
  return {
    assetKind: shot.assetKind,
    ...(shot.assetPath !== undefined ? { assetPath: shot.assetPath } : {}),
    ...(shot.audioPath !== undefined ? { audioPath: shot.audioPath } : {})
  };
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：把 input 与 state 拼回扁平清单：镜头顺序跟随 input.shots，状态按 shotId 取（缺失的镜头视为未生成的标题卡）。
 */
function flattenRenderManifest(input: RenderManifestFile["input"], state: unknown): RenderManifest {
  const stateShots = isRecord(state) ? state.shots : undefined;
  const states = isRecord(stateShots) ? stateShots : {};
  return {
    aspectRatio: input.aspectRatio,
    width: input.width,
    height: input.height,
    durationSeconds: input.durationSeconds,
    bgmStyle: input.bgmStyle,
    outputFile: input.outputFile,
    captionsFile: input.captionsFile,
    shots: input.shots.map((entry) => {
      const recorded = states[entry.shotId];
      const shotState = isRecord(recorded) ? (recorded as Partial<RenderShotState>) : {};
      return {
        shotId: entry.shotId,
        title: entry.title,
        durationSeconds: entry.durationSeconds,
        assetKind: shotState.assetKind ?? "generated-card",
        ...(shotState.assetPath !== undefined ? { assetPath: shotState.assetPath } : {}),
        ...(shotState.audioPath !== undefined ? { audioPath: shotState.audioPath } : {}),
        overlayText: entry.overlayText,
        caption: entry.caption,
        visualPrompt: entry.visualPrompt
      };
    })
  };
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：判断一个 JSON 值是否为普通对象（数组与 null 都不算），用于逐节容错。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
