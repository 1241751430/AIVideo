/**
 * @file narration.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description narration.ts 的单元测试：无语音提供者时的跳过提示、已有配音复用与新合成计数、单镜合成失败不断链；
 * 另覆盖台词直通：多角色按 speaker 换嗓子逐条合成后拼接、无台词仍走单次直写、换音色触发重配且最终只有一个 wav。
 * @see https://github.com/1241751430/AIVideo.git
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { synthesizeNarration } from "./narration.js";
import { shotAudioPath, shotSegmentsDir } from "./shotFiles.js";

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

test("narration: two speakers get their own voice and the result is still one wav per shot", async () => {
  const dir = tempProject();
  const calls: Array<{ text: string; voice?: string; outputPath: string }> = [];
  const concatCalls: Array<{ segments: string[]; outputPath: string; gapMs: number }> = [];
  const result = await synthesizeNarration({
    projectDir: dir,
    shots: [
      {
        id: "s1",
        narration: "画外音收尾",
        lines: [
          { speaker: "mom", text: "吃饭了", src: "generated" },
          { speaker: "kid", text: "马上来", src: "generated" }
        ]
      }
    ],
    roles: [
      { id: "mom", name: "妈妈", voice: "Tingting" },
      { id: "kid", name: "孩子", voice: "Meijia" }
    ],
    speechProvider: {
      synthesizeSpeech: async ({ text, voice, outputPath }) => {
        calls.push({ text, voice, outputPath });
        writeFileSync(outputPath, `wav:${text}`);
        return { outputPath };
      }
    },
    // 本机没有 ffmpeg：把拼接换成假实现，才测得到「逐条合成 → 拼接 → 落成单文件」这条链。
    concatSegments: async ({ segments, outputPath, gapMs }) => {
      concatCalls.push({ segments: segments.map((segment) => segment.path), outputPath, gapMs });
      writeFileSync(outputPath, segments.map((segment) => readFileSync(segment.path, "utf8")).join("|"));
    }
  });

  assert.deepEqual(result, { synthesized: 1, reused: 0, failed: 0 });
  // 台词在前、旁白在后；每条台词用自己 speaker 的音色，旁白没有音色覆盖就交给 provider 兜底。
  assert.deepEqual(
    calls.map(({ text, voice }) => ({ text, voice })),
    [
      { text: "吃饭了", voice: "Tingting" },
      { text: "马上来", voice: "Meijia" },
      { text: "画外音收尾", voice: undefined }
    ]
  );
  assert.equal(concatCalls.length, 1, "三段只拼一次");
  assert.deepEqual(
    concatCalls[0]!.segments.map((path) => path.replace(dir, "")),
    ["/audio/.segments/s1/0.wav", "/audio/.segments/s1/1.wav", "/audio/.segments/s1/2.wav"]
  );
  assert.ok(concatCalls[0]!.gapMs > 0, "角色之间要留停顿，否则两句会黏在一起");

  const audioPath = shotAudioPath(dir, "s1");
  assert.equal(readFileSync(audioPath, "utf8"), "wav:吃饭了|wav:马上来|wav:画外音收尾");
  assert.ok(!existsSync(shotSegmentsDir(dir, "s1")), "临时分段在收尾时被清掉，不留脏文件");
});

test("narration: user lines reach the provider byte-for-byte (no trimming, no rewriting)", async () => {
  const dir = tempProject();
  const spoken: string[] = [];
  await synthesizeNarration({
    projectDir: dir,
    shots: [
      {
        id: "s1",
        narration: "旁白",
        lines: [{ speaker: "narrator", text: "  他说：「走！」  ", src: "user" }]
      }
    ],
    speechProvider: {
      synthesizeSpeech: async ({ text, outputPath }) => {
        spoken.push(text);
        writeFileSync(outputPath, "wav");
        return { outputPath };
      }
    },
    concatSegments: async ({ segments, outputPath }) => {
      writeFileSync(outputPath, segments.map((segment) => readFileSync(segment.path, "utf8")).join(""));
    }
  });
  assert.equal(spoken[0], "  他说：「走！」  ", "用户台词逐字节交给合成，前后空白也不许动");
});

test("narration: a shot without lines keeps the single-synthesis path and never touches the concat hook", async () => {
  const dir = tempProject();
  const calls: Array<{ text: string; outputPath: string }> = [];
  let concatCalls = 0;
  const result = await synthesizeNarration({
    projectDir: dir,
    shots: [{ id: "s1", narration: "只有旁白", voice: "Tingting" }],
    speechProvider: {
      synthesizeSpeech: async ({ text, voice, outputPath }) => {
        calls.push({ text, outputPath });
        assert.equal(voice, "Tingting");
        writeFileSync(outputPath, "wav");
        return { outputPath };
      }
    },
    concatSegments: async () => {
      concatCalls += 1;
    }
  });
  assert.deepEqual(result, { synthesized: 1, reused: 0, failed: 0 });
  assert.equal(concatCalls, 0, "无台词时必须直写目标文件——这是老项目的既有行为");
  assert.deepEqual(calls, [{ text: "只有旁白", outputPath: shotAudioPath(dir, "s1") }]);
});

test("narration: blank lines fall back to narration-only instead of synthesizing silence", async () => {
  const dir = tempProject();
  const spoken: string[] = [];
  let concatCalls = 0;
  await synthesizeNarration({
    projectDir: dir,
    shots: [{ id: "s1", narration: "旁白正文", lines: [{ text: "   ", src: "generated" }] }],
    speechProvider: {
      synthesizeSpeech: async ({ text, outputPath }) => {
        spoken.push(text);
        writeFileSync(outputPath, "wav");
        return { outputPath };
      }
    },
    concatSegments: async () => {
      concatCalls += 1;
    }
  });
  assert.deepEqual(spoken, ["旁白正文"]);
  assert.equal(concatCalls, 0);
});

test("narration: switching the resolved voice re-synthesizes even though the wav is on disk", async () => {
  const dir = tempProject();
  const calls: string[] = [];
  const provider = {
    synthesizeSpeech: async ({ text, outputPath }: { text: string; outputPath: string }) => {
      calls.push(text);
      writeFileSync(outputPath, "new");
      return { outputPath };
    }
  };
  const shot = { id: "s1", narration: "旁白", lines: [{ speaker: "mom", text: "吃饭了", src: "generated" as const }] };
  const stitch = async ({ segments, outputPath }: { segments: Array<{ path: string }>; outputPath: string }) => {
    writeFileSync(outputPath, segments.map((segment) => readFileSync(segment.path, "utf8")).join("|"));
  };

  const first = await synthesizeNarration({
    projectDir: dir,
    shots: [shot],
    roles: [{ id: "mom", name: "妈妈", voice: "Tingting" }],
    speechProvider: provider,
    concatSegments: stitch
  });
  assert.deepEqual(first, { synthesized: 1, reused: 0, failed: 0 });

  // 同样的输入再来一次：指纹未变、文件在盘 → 复用，不再调 provider。
  calls.length = 0;
  const second = await synthesizeNarration({
    projectDir: dir,
    shots: [shot],
    roles: [{ id: "mom", name: "妈妈", voice: "Tingting" }],
    speechProvider: provider,
    concatSegments: stitch
  });
  assert.deepEqual(second, { synthesized: 0, reused: 1, failed: 0 });
  assert.deepEqual(calls, []);

  // 只改角色音色：文本一个字没变，但产物是另一副嗓子，必须重配。
  const third = await synthesizeNarration({
    projectDir: dir,
    shots: [shot],
    roles: [{ id: "mom", name: "妈妈", voice: "Meijia" }],
    speechProvider: provider,
    concatSegments: stitch
  });
  assert.deepEqual(third, { synthesized: 1, reused: 0, failed: 0 });
  assert.deepEqual(calls, ["吃饭了", "旁白"]);
});
