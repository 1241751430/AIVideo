/**
 * @file narration.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description narration.ts 的单元测试：无语音提供者时的跳过提示、已有配音复用与新合成计数、单镜合成失败不断链。
 * @see https://github.com/1241751430/AIVideo.git
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { synthesizeNarration } from "./narration.js";
import { shotAudioPath } from "./shotFiles.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：创建含 audio/ 子目录的临时项目目录并返回其路径。
 */
function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aivideo-narration-"));
  mkdirSync(join(dir, "audio"), { recursive: true });
  return dir;
}

test("synthesizeNarration without a provider logs and returns empty counts", async () => {
  const dir = tempProject();
  const lines: string[] = [];
  const result = await synthesizeNarration({
    projectDir: dir,
    shots: [{ id: "s1", narration: "hi" }],
    reportProgress: (message) => lines.push(message)
  });
  assert.deepEqual(result, { synthesized: 0, reused: 0, failed: 0 });
  assert.match(lines.join("\n"), /No speech provider configured/);
});

test("synthesizeNarration synthesizes each missing shot and reuses existing audio", async () => {
  const dir = tempProject();
  writeFileSync(shotAudioPath(dir, "s1"), "existing"); // non-empty → reused
  const requested: string[] = [];
  const result = await synthesizeNarration({
    projectDir: dir,
    shots: [
      { id: "s1", narration: "one" },
      { id: "s2", narration: "two" }
    ],
    speechProvider: {
      synthesizeSpeech: async ({ text, outputPath }) => {
        requested.push(text);
        writeFileSync(outputPath, `wav:${text}`);
        return { outputPath };
      }
    }
  });
  assert.deepEqual(result, { synthesized: 1, reused: 1, failed: 0 });
  assert.deepEqual(requested, ["two"]);
});

test("synthesizeNarration keeps going when one shot fails", async () => {
  const dir = tempProject();
  const lines: string[] = [];
  const result = await synthesizeNarration({
    projectDir: dir,
    shots: [
      { id: "bad", narration: "x" },
      { id: "good", narration: "y" }
    ],
    speechProvider: {
      synthesizeSpeech: async ({ outputPath }) => {
        if (outputPath.includes("bad")) {
          throw new Error("boom");
        }
        writeFileSync(outputPath, "wav");
        return { outputPath };
      }
    },
    reportProgress: (message) => lines.push(message)
  });
  assert.deepEqual(result, { synthesized: 1, reused: 0, failed: 1 });
  assert.match(lines.join("\n"), /Speech synthesis skipped for bad: boom/);
});
