/**
 * @file narration.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 流水线的配音合成阶段：并发为每个镜头合成 audio/<id>.wav，跳过磁盘上已存在的非空音频以支持断点续跑，单镜失败不中断整批。
 * @see https://github.com/1241751430/AIVideo.git
 */

import { nonEmptyFileExists, runConcurrent } from "./utils.js";
import { shotAudioPath } from "./shotFiles.js";

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
 * 功能：为每个镜头调用语音 Provider 合成 wav：磁盘已有非空音频则计 reused，未配置 Provider 时直接返回并提示使用静音；单镜异常只计 failed 并继续。
 * @returns 合成/复用/失败三个计数（NarrationResult）
 */
/**
 * Synthesize `audio/<shotId>.wav` for every shot, reusing existing non-empty
 * audio (resume) and never letting one shot's failure abort the stage.
 */
export async function synthesizeNarration(input: {
  projectDir: string;
  shots: Array<{ id: string; narration: string }>;
  speechProvider?: NarrationSpeechProvider;
  /** Progress/log sink; defaults to silent. The CLI wires this to console.log. */
  reportProgress?: (message: string) => void;
}): Promise<NarrationResult> {
  const { projectDir, shots, speechProvider, reportProgress } = input;
  const result: NarrationResult = { synthesized: 0, reused: 0, failed: 0 };
  if (!speechProvider) {
    reportProgress?.("No speech provider configured. Rendering will use silent audio.");
    return result;
  }

  reportProgress?.(`Synthesizing narration for ${shots.length} shot(s)...`);
  const tasks = shots.map((shot, index) => async () => {
    // WAV is the one container both engines produce faithfully: `say -o x.wav`
    // and `espeak-ng -w x.wav` both write real WAV data, whereas espeak would
    // emit WAV bytes under a misleading .aiff name.
    const audioPath = shotAudioPath(projectDir, shot.id);
    // Resume support: a non-empty wav from a previous run means this shot's
    // narration was already synthesized (local engines are free, but
    // re-voicing overwrites a file the render may already reference — skip it).
    if (nonEmptyFileExists(audioPath)) {
      result.reused += 1;
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
    } catch (error) {
      result.failed += 1;
      reportProgress?.(`Speech synthesis skipped for ${shot.id}: ${(error as Error).message}`);
    }
  });
  await runConcurrent(tasks, NARRATION_CONCURRENCY);
  return result;
}
