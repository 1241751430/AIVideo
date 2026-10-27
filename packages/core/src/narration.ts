/**
 * @file narration.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 流水线的配音合成阶段：并发为每个镜头合成 audio/<id>.wav，按输入指纹与磁盘上已存在的非空音频决定复用（断点续跑），显式 force 时全部重做，单镜失败不中断整批。
 * @see https://github.com/1241751430/AIVideo.git
 */

import { nonEmptyFileExists, runConcurrent } from "./utils.js";
import { shotAudioPath } from "./shotFiles.js";
import { audioShotFingerprint, compareStageFingerprint, readStageFingerprints, recordStageFingerprints } from "./fingerprints.js";

/**
 * Narration (speech) stage of the pipeline: synthesizes one wav per shot
 * under `audio/`, skipping shots whose audio already exists on disk so a
 * resumed run never re-pays or re-voicess a shot. Ported from the CLI's
 * private helper so the workbench server reuses the exact same engine.
 */

const NARRATION_CONCURRENCY = 3;

/** Minimal structural contract the local `say`/`espeak` and remote speech providers satisfy. */
export interface NarrationSpeechProvider {
  synthesizeSpeech(request: { text: string; outputPath: string }): Promise<unknown>;
}

export interface NarrationResult {
  synthesized: number;
  reused: number;
  failed: number;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：为每个镜头调用语音 Provider 合成 wav：已有非空音频且输入指纹未变则计 reused，未配置 Provider 时直接返回并提示使用静音；单镜异常只计 failed 并继续。
 * @returns 合成/复用/失败三个计数（NarrationResult）
 */
/**
 * Synthesize `audio/<shotId>.wav` for every shot, reusing existing non-empty
 * audio (resume) and never letting one shot's failure abort the stage.
 *
 * The reuse decision is "fingerprint matches the narration + duration it was
 * synthesized from" and the file is still there — see `fingerprints.ts`. A
 * missing fingerprint (project written before fingerprints existed) falls back
 * to the old presence check, so resumed old projects keep working. `force`
 * bypasses both and re-voices every shot.
 */
export async function synthesizeNarration(input: {
  projectDir: string;
  shots: Array<{ id: string; narration: string; durationSeconds?: number }>;
  speechProvider?: NarrationSpeechProvider;
  /** True when the caller explicitly asked for a redo: never reuse existing audio. */
  force?: boolean;
  /** Spoken language; part of the fingerprint so switching voices re-synthesizes. */
  language?: string;
  /** Progress/log sink; defaults to silent. The CLI wires this to console.log. */
  reportProgress?: (message: string) => void;
}): Promise<NarrationResult> {
  const { projectDir, shots, speechProvider, force, language, reportProgress } = input;
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
    const current = audioShotFingerprint({ shot, language });
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
      await speechProvider.synthesizeSpeech({
        text: shot.narration,
        outputPath: audioPath
      });
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
