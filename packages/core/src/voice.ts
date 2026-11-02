/**
 * @file voice.ts
 * @author zhangbaohong
 * @date 2026-10-30
 * @description 音色解析的唯一事实来源（叶子模块，只依赖 types）：把 `ScriptLine.speaker` 解析成角色声明的音色。
 *              单独成文件是为了让 narration（合成）与 fingerprints（失效判定）共用同一段解析，
 *              又不让 fingerprints 反向依赖 narration（那会成环，且 fingerprints 明令禁止 import workflow）。
 * @see https://github.com/1241751430/AIVideo.git
 */

import type { ScriptLine, ScriptRole } from "./types.js";

/**
 * 多角色配音的建议音色（macOS `say` 的中文音色），供界面/提示词在给角色分配音色时选用。
 *
 * 刻意**不由 core 自动套用**：Ark 等远端 TTS 的 `voice_type` 是另一套 id，把 `Tingting` 硬塞进远端请求
 * 会直接让该镜合成失败。音色的缺省兜底只能由知道厂商的那一方做（provider 的 `request.voice ?? 默认`）。
 */
export const DEFAULT_ROLE_VOICES = ["Tingting", "Meijia", "Sinji", "Li-mu"] as const;

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：解析一句台词该用的音色：`speaker` 命中角色表且该角色声明了 voice 时返回它；
 * 没有 speaker、对不上角色或角色未声明音色时返回 undefined，由调用方继续回落「逐镜 voice → provider 默认」。
 * @param line 台词（至少含 speaker）；缺省视为无角色
 * @param roles 角色表；为空时一律返回 undefined（本镜走默认音色）
 * @returns 解析出的音色标识；无法解析时为 undefined
 */
export function resolveVoice(
  line: Pick<ScriptLine, "speaker"> | undefined,
  roles?: ScriptRole[]
): string | undefined {
  const speaker = line?.speaker;
  if (!speaker || !roles || roles.length === 0) {
    return undefined;
  }
  const declared = roles.find((role) => role.id === speaker)?.voice;
  return declared && declared.trim() ? declared : undefined;
}