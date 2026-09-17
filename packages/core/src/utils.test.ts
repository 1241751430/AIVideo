/**
 * @file utils.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description utils.ts 与 config.ts 共享工具的单元测试：路径越界判断、并发限流、execFileAsync 心跳/逐行流式/中断、本地图片校验，以及 Provider 环境变量键与 .env 模板一致性等。
 * @see https://github.com/1241751430/AIVideo.git
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_FILE, collectProviderEnvKeys, getConfigTemplate, getEnvTemplate, loadConfig } from "./config.js";
import {
  assertPathWithin,
  execFileAsync,
  isWithinBase,
  nonEmptyFileExists,
  runConcurrent,
  validateLocalImageFile
} from "./utils.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：创建带 aivideo-utils- 前缀的临时目录并返回其路径。
 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "aivideo-utils-"));
}

test("isWithinBase accepts inner paths and rejects escapes", () => {
  const base = tempDir();
  assert.ok(isWithinBase(base, base));
  assert.ok(isWithinBase(base, join(base, "project", "shot.mp4")));
  assert.ok(isWithinBase(base, join(base, "a", "..", "b")));
  assert.ok(!isWithinBase(base, join(base, "..", "outside")));
  assert.ok(!isWithinBase(base, "/some/other/root"));
  assert.ok(!isWithinBase(base, join(`${base}-sibling`, "x")));
});

test("assertPathWithin throws with the label and base in the message", () => {
  const base = tempDir();
  assert.equal(
    ((): string => {
      try {
        assertPathWithin(base, join(base, "..", "escape"), "Project directory");
        return "no-throw";
      } catch (error) {
        return (error as Error).message;
      }
    })(),
    `Project directory must stay within ${base}.`
  );
  assert.doesNotThrow(() => assertPathWithin(base, join(base, "ok"), "Project directory"));
});

test("nonEmptyFileExists requires a regular non-empty file", () => {
  const dir = tempDir();
  const empty = join(dir, "empty.png");
  const filled = join(dir, "filled.png");
  writeFileSync(empty, "");
  writeFileSync(filled, "x");
  assert.ok(!nonEmptyFileExists(join(dir, "missing.bin")));
  assert.ok(!nonEmptyFileExists(empty));
  assert.ok(!nonEmptyFileExists(dir)); // directory, not a file
  assert.ok(nonEmptyFileExists(filled));
});

test("runConcurrent respects the limit and completes every task", async () => {
  let running = 0;
  let maxRunning = 0;
  let done = 0;
  const tasks = Array.from({ length: 7 }, () => async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    running -= 1;
    done += 1;
  });
  await runConcurrent(tasks, 3);
  assert.equal(done, 7);
  assert.ok(maxRunning <= 3);
});

test("runConcurrent with an empty task list resolves", async () => {
  await runConcurrent([], 4);
});

test("execFileAsync resolves stdout, rejects with merged stderr, and fires heartbeats", async () => {
  const stdout = await execFileAsync("node", ["-e", "process.stdout.write('hello')"]);
  assert.equal(stdout, "hello");

  await assert.rejects(
    execFileAsync("node", ["-e", "console.error('boom'); process.exit(1)"]),
    /boom/
  );

  let beats = 0;
  await execFileAsync("node", ["-e", "setTimeout(() => {}, 40)"], {
    heartbeatMs: 10,
    onHeartbeat: () => {
      beats += 1;
    }
  });
  assert.ok(beats >= 2, `expected heartbeats to fire repeatedly, got ${beats}`);
});

test("validateLocalImageFile messages keep provider-compatible wording", () => {
  const dir = tempDir();
  assert.throws(() => validateLocalImageFile(join(dir, "ghost.png")), /Image not found/);
  assert.throws(() => validateLocalImageFile(dir, "Reference image"), /Reference image is not a regular file/);

  const empty = join(dir, "empty.png");
  writeFileSync(empty, "");
  assert.throws(() => validateLocalImageFile(empty, "Reference image"), /Reference image is empty/);

  const unsupported = join(dir, "note.txt");
  writeFileSync(unsupported, "text");
  assert.throws(
    () => validateLocalImageFile(unsupported, "Reference image"),
    /Unsupported reference image format/
  );

  const ok = join(dir, "frame.png");
  writeFileSync(ok, "fake-png-bytes");
  assert.deepEqual(validateLocalImageFile(ok, "Reference image"), {
    mime: "image/png",
    sizeBytes: "fake-png-bytes".length
  });
});

test("execFileAsync streams stdout lines including a trailing unterminated fragment", async () => {
  const lines: string[] = [];
  await execFileAsync(
    "node",
    ["-e", "process.stdout.write('one\\ntwo\\nthree')"],
    { onStdoutLine: (line) => lines.push(line) }
  );
  assert.deepEqual(lines, ["one", "two", "three"]);
});

test("execFileAsync kills the child when the abort signal fires", async () => {
  const controller = new AbortController();
  const pending = execFileAsync("node", ["-e", "setTimeout(() => {}, 5000)"], {
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending);
});

test("execFileAsync with an already-aborted signal rejects", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    execFileAsync("node", ["-e", "setTimeout(() => {}, 100)"], { signal: controller.signal })
  );
});

test("every provider env key surfaces in the .env template", () => {
  const dir = tempDir();
  writeFileSync(join(dir, CONFIG_FILE), getConfigTemplate(dir), "utf8");
  const config = loadConfig(dir);
  const envTemplate = getEnvTemplate(dir);
  for (const key of collectProviderEnvKeys(config)) {
    assert.ok(
      envTemplate.includes(key),
      `provider references ${key} but the generated env template never mentions it`
    );
  }
  assert.ok(collectProviderEnvKeys(config).length > 0);
});
