/**
 * @file narration.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 流水线的配音合成阶段：并发为每个镜头合成 audio/<id>.wav，按输入指纹与磁盘上已存在的非空音频决定复用（断点续跑），显式 force 时全部重做，单镜失败不中断整批。一镜有多条台词时按「台词在前、旁白在后」逐条合成到 audio/.segments/<id>/ 并拼成一个 wav，最终对外仍是单文件契约。
 * @see https://github.com/1241751430/AIVideo.git
 */

import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileAsync, nonEmptyFileExists, runConcurrent } from "./utils.js";
import { shotAudioPath, shotSegmentPath, shotSegmentsDir } from "./shotFiles.js";
import { audioShotFingerprint, compareStageFingerprint, readStageFingerprints, recordStageFingerprints } from "./fingerprints.js";
import { resolveVoice } from "./voice.js";
import type { ScriptLine, ScriptRole } from "./types.js";

/**
 * Narration (speech) stage of the pipeline: synthesizes one wav per shot
 * under `audio/`, skipping shots whose audio already exists on disk so a
 * resumed run never re-pays or re-voicess a shot. Ported from the CLI's
 * private helper so the workbench server reuses the exact same engine.
 *
 * A shot may carry several lines (one per speaker) plus its narration. The
 * renderer's contract is a single audio file per shot, so the lines are
 * synthesized separately and stitched here — `render.py` and `RenderShot`
 * never learn about segments.
 */

const NARRATION_CONCURRENCY = 3;

/** 角色之间的停顿（毫秒）：太短两句会黏在一起，太长会把节奏拖垮。 */
const NARRATION_GAP_MS = 250;

/** 拼接后统一的音频格式：与本地 `say` 的 LEI16@22050 一致，避免每次拼接都换一套参数。 */
const NARRATION_SAMPLE_RATE = 22050;

/** Minimal structural contract the local `say`/`espeak` and remote speech providers satisfy. */
export interface NarrationSpeechProvider {
  synthesizeSpeech(request: { text: string; outputPath: string; voice?: string }): Promise<unknown>;
}

export interface NarrationResult {
  synthesized: number;
  reused: number;
  failed: number;
}

/** 一段待合成的语音：台词原文（逐字交给 provider）与解析后的音色。 */
export interface NarrationSpeechSegment {
  text: string;
  voice?: string;
}

/**
 * 拼接钩子：把已合成好的多段 wav 按顺序拼成一个文件。
 * 之所以做成可注入，是因为拼接依赖 ffmpeg，而「没有 ffmpeg」不该被静默当成合成成功。
 */
export type NarrationConcat = (input: {
  projectDir: string;
  shotId: string;
  /** 已落盘的分段 wav，按播出顺序排列。 */
  segments: Array<{ path: string }>;
  /** 拼接结果的目标路径（调用方随后会把它改名成 audio/<id>.wav）。 */
  outputPath: string;
  /** 相邻分段之间插入的静音时长。 */
  gapMs: number;
}) => Promise<void>;

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：为每个镜头调用语音 Provider 合成 wav：已有非空音频且输入指纹未变则计 reused，未配置 Provider 时直接返回并提示使用静音；单镜异常只计 failed 并继续。
 * 台词与旁白都进配音：有台词时逐条合成（按 speaker 解析音色）后拼接，无台词时仍是「一条旁白直写 audio/<id>.wav」——老项目行为逐字节不变。
 * @returns 合成/复用/失败三个计数（NarrationResult）
 */
/**
 * Synthesize `audio/<shotId>.wav` for every shot, reusing existing non-empty
 * audio (resume) and never letting one shot's failure abort the stage.
 *
 * The reuse decision is "fingerprint matches the narration + duration +
 * dialogue + voice it was synthesized from" and the file is still there — see
 * `fingerprints.ts`. A missing fingerprint (project written before
 * fingerprints existed) falls back to the old presence check, so resumed old
 * projects keep working. `force` bypasses both and re-voices every shot.
 */
export async function synthesizeNarration(input: {
  projectDir: string;
  shots: Array<{ id: string; narration: string; durationSeconds?: number; lines?: ScriptLine[]; voice?: string }>;
  /** 角色表（来自 script.json）：lines[].speaker 靠它解析音色；缺省时只认镜头自身的 voice。 */
  roles?: ScriptRole[];
  speechProvider?: NarrationSpeechProvider;
  /** True when the caller explicitly asked for a redo: never reuse existing audio. */
  force?: boolean;
  /** Spoken language; part of the fingerprint so switching voices re-synthesizes. */
  language?: string;
  /** 多段拼接的实现；默认走 ffmpeg，测试可注入。缺省且需要拼接时，没有 ffmpeg 会如实报失败。 */
  concatSegments?: NarrationConcat;
  /** Progress/log sink; defaults to silent. The CLI wires this to console.log. */
  reportProgress?: (message: string) => void;
}): Promise<NarrationResult> {
  const { projectDir, shots, roles, speechProvider, force, language, reportProgress } = input;
  const concatSegments = input.concatSegments ?? concatNarrationSegments;
  const result: NarrationResult = { synthesized: 0, reused: 0, failed: 0 };
  if (!speechProvider) {
    reportProgress?.("No speech provider configured. Rendering will use silent audio.");
    return result;
  }

  reportProgress?.(`Synthesizing narration for ${shots.length} shot(s)...`);
  const recorded = readStageFingerprints(projectDir)?.audio;
  // Concurrent shots must not each rewrite stage-fingerprints.json (the last
  // writer wins and would drop the others): accumulate and persist once.
  const fingerprints: Record<string, string> = {};
  const tasks = shots.map((shot, index) => async () => {
    // WAV is the one container both engines produce faithfully: `say -o x.wav`
    // and `espeak-ng -w x.wav` both write real WAV data, whereas espeak would
    // emit WAV bytes under a misleading .aiff name.
    const audioPath = shotAudioPath(projectDir, shot.id);
    const current = audioShotFingerprint({ shot, roles, language });
    const status = compareStageFingerprint(recorded?.[shot.id], current);
    // Resume support: a non-empty wav whose inputs have not changed means this
    // shot's narration was already synthesized (local engines are free, but
    // re-voicing overwrites a file the render may already reference — skip it).
    // `unknown` = no fingerprint on record, fall back to the old file check;
    // the file still has to exist, since editing deletes the wav and does not
    // touch the fingerprint.
    if (!force && status !== "mismatch" && nonEmptyFileExists(audioPath)) {
      result.reused += 1;
      fingerprints[shot.id] = current;
      reportProgress?.(`- Narration ${index + 1}/${shots.length}: ${shot.id} (reused existing audio)`);
      return;
    }
    reportProgress?.(`- Narration ${index + 1}/${shots.length}: ${shot.id}`);
    try {
      const segments = speechSegmentsFor(shot, roles);
      if (segments.length <= 1) {
        // 无台词：与引入台词之前完全同一条路径，一次合成直写目标文件。
        await speechProvider.synthesizeSpeech({
          text: segments[0]?.text ?? shot.narration,
          outputPath: audioPath,
          ...(segments[0]?.voice ? { voice: segments[0].voice } : {})
        });
      } else {
        await synthesizeAndStitch({
          projectDir,
          shotId: shot.id,
          segments,
          audioPath,
          speechProvider,
          concatSegments
        });
      }
      result.synthesized += 1;
      fingerprints[shot.id] = current;
    } catch (error) {
      result.failed += 1;
      reportProgress?.(`Speech synthesis skipped for ${shot.id}: ${(error as Error).message}`);
    }
  });
  await runConcurrent(tasks, NARRATION_CONCURRENCY);
  if (Object.keys(fingerprints).length > 0) {
    recordStageFingerprints(projectDir, { audio: fingerprints });
  }
  return result;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把一个镜头的台词与旁白展开成按播出顺序排列的语音段：lines 在前、narration 在后；每条台词的音色先按 speaker 找角色音色，再回落镜头自身的 voice。
 * 没有台词（或台词全空）时只返回一条旁白——调用方据此走「单次合成直写」的老路径，行为与引入台词之前完全相同。
 * @param shot 分镜镜头（旁白/台词/逐镜音色）
 * @param roles 角色表；缺省时不解析角色音色
 * @returns 按播出顺序排列的语音段（至少一条）
 */
function speechSegmentsFor(
  shot: { narration: string; lines?: ScriptLine[]; voice?: string },
  roles?: ScriptRole[]
): NarrationSpeechSegment[] {
  const spoken: NarrationSpeechSegment[] = (shot.lines ?? [])
    .filter((line) => line.text.trim().length > 0)
    .map((line) => {
      const voice = resolveVoice(line, roles) ?? shot.voice;
      return voice ? { text: line.text, voice } : { text: line.text };
    });
  if (spoken.length === 0) {
    return [shot.voice ? { text: shot.narration, voice: shot.voice } : { text: shot.narration }];
  }
  // 旁白是画外音，永远排在台词之后；空旁白不占一段（否则会多出一次无意义的合成与停顿）。
  const narration: NarrationSpeechSegment[] =
    shot.narration.trim().length > 0
      ? [shot.voice ? { text: shot.narration, voice: shot.voice } : { text: shot.narration }]
      : [];
  return [...spoken, ...narration];
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：逐条合成台词到 audio/.segments/<id>/ 下的临时 wav，交给拼接钩子合成单文件，成功后再改名成 audio/<id>.wav。
 * 先拼到临时文件再改名：ffmpeg 中途失败不会留下一个半截的 audio/<id>.wav 被下游当成「已有配音」复用。
 * @param input 项目目录、镜头 id、语音段、目标路径、provider 与拼接钩子
 */
async function synthesizeAndStitch(input: {
  projectDir: string;
  shotId: string;
  segments: NarrationSpeechSegment[];
  audioPath: string;
  speechProvider: NarrationSpeechProvider;
  concatSegments: NarrationConcat;
}): Promise<void> {
  const { projectDir, shotId, segments, audioPath, speechProvider, concatSegments } = input;
  // 每个镜头一个独立子目录：合成是并发跑的，共用一个目录会让某个镜头收尾时删掉别人正在写的分段。
  const segmentDir = shotSegmentsDir(projectDir, shotId);
  mkdirSync(segmentDir, { recursive: true });
  try {
    const written: Array<{ path: string }> = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const segmentPath = shotSegmentPath(projectDir, shotId, index);
      await speechProvider.synthesizeSpeech({
        text: segment.text,
        outputPath: segmentPath,
        ...(segment.voice ? { voice: segment.voice } : {})
      });
      written.push({ path: segmentPath });
    }
    const stitched = join(segmentDir, "stitched.wav");
    await concatSegments({ projectDir, shotId, segments: written, outputPath: stitched, gapMs: NARRATION_GAP_MS });
    if (!nonEmptyFileExists(stitched)) {
      throw new Error("concat produced no audio");
    }
    renameSync(stitched, audioPath);
  } finally {
    rmSync(segmentDir, { recursive: true, force: true });
  }
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：默认拼接实现：一次 ffmpeg 调用把各分段按顺序串起来，相邻两段之间插入 gapMs 静音；统一重采样成 22050Hz 单声道 16bit。
 * 单条命令而非「先造静音文件再 concat demuxer」：静音由 lavfi 现场生成，少一次落盘，也不会因各段采样率不同而让 concat 失败。
 * @param input 分段路径、目标路径与停顿毫秒
 */
async function concatNarrationSegments(input: {
  projectDir: string;
  shotId: string;
  segments: Array<{ path: string }>;
  outputPath: string;
  gapMs: number;
}): Promise<void> {
  const { segments, outputPath, gapMs } = input;
  if (segments.length === 0) {
    throw new Error("nothing to concat");
  }
  const format = `aresample=${NARRATION_SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono`;
  // 输入 0 是 lavfi 静音源，输入 1..n 是各分段；静音源被拆成 n-1 份插在段与段之间。
  const gaps = Math.max(segments.length - 1, 0);
  const filters: string[] = [];
  if (gaps > 0) {
    filters.push(`[0:a]${format},asplit=${gaps}${Array.from({ length: gaps }, (_, i) => `[g${i}]`).join("")}`);
  }
  segments.forEach((_segment, index) => {
    filters.push(`[${index + 1}:a]${format}[s${index}]`);
  });
  const chain: string[] = [];
  segments.forEach((_, index) => {
    chain.push(`[s${index}]`);
    if (index < gaps) {
      chain.push(`[g${index}]`);
    }
  });
  filters.push(`${chain.join("")}concat=n=${chain.length}:v=0:a=1[out]`);
  const args = [
    "-y",
    "-f",
    "lavfi",
    "-t",
    (gapMs / 1000).toFixed(3),
    "-i",
    `anullsrc=r=${NARRATION_SAMPLE_RATE}:cl=mono`,
    ...segments.flatMap((segment) => ["-i", segment.path]),
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-c:a",
    "pcm_s16le",
    outputPath
  ];
  try {
    await execFileAsync("ffmpeg", args);
  } catch (error) {
    throw new Error(`ffmpeg could not stitch narration segments (${(error as Error).message})`);
  }
}