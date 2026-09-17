/**
 * @file events.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 事件流测试：events.jsonl 追加与 id 递增、1000 行截断、按 Last-Event-ID 重放、SSE 帧格式与进程内总线订阅/广播。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHub, JobEventLog, MAX_EVENT_LINES, sseFrame } from "./events.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：建临时项目目录并在测试尾清理。
 */
function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aivideo-events-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("append 递增 id 并可按 after 重放", () => {
  const { dir, cleanup } = tempDir();
  try {
    const log = new JobEventLog(dir);
    const first = log.append("status", { phase: "queued" });
    const second = log.append("log", { message: "开始阶段：script" });
    assert.equal(first.id, 1);
    assert.equal(second.id, 2);
    assert.equal(second.type, "log");

    assert.deepEqual(
      log.after(0).map((event) => event.id),
      [1, 2]
    );
    assert.deepEqual(
      log.after(1).map((event) => event.id),
      [2]
    );
    assert.deepEqual(log.after(2), []);
  } finally {
    cleanup();
  }
});

test("损坏行被重放跳过、计数兜底不中断追加", () => {
  const { dir, cleanup } = tempDir();
  try {
    const log = new JobEventLog(dir);
    log.append("status", { phase: "queued" });
    writeFileSync(join(dir, "events.jsonl"), "{broken\n", { flag: "a" });
    const next = log.append("log", { message: "x" });
    assert.ok(next.id >= 2);
    const replayed = log.after(0);
    assert.equal(replayed.length, 2);
    assert.ok(replayed.every((event) => typeof event.id === "number"));
  } finally {
    cleanup();
  }
});

test("超过上限截断为最近 MAX_EVENT_LINES 行且 id 不回退", () => {
  const { dir, cleanup } = tempDir();
  try {
    const log = new JobEventLog(dir);
    const total = MAX_EVENT_LINES + 50;
    for (let index = 0; index < total; index += 1) {
      log.append("log", { message: `m${index}` });
    }
    const lines = readFileSync(join(dir, "events.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    assert.equal(lines.length, MAX_EVENT_LINES);
    const replayed = log.after(0);
    assert.equal(replayed[0]?.id, total - MAX_EVENT_LINES + 1);
    assert.equal(replayed[replayed.length - 1]?.id, total);
  } finally {
    cleanup();
  }
});

test("sseFrame 输出 id 与 JSON data 帧", () => {
  const frame = sseFrame({ id: 7, at: "2026-09-17T00:00:00.000Z", type: "log", data: { message: "hi" } });
  assert.equal(frame, `id: 7\ndata: {"id":7,"at":"2026-09-17T00:00:00.000Z","type":"log","data":{"message":"hi"}}\n\n`);
});

test("EventHub 广播给订阅者且退订后不再收到", () => {
  const hub = new EventHub();
  const seenA: number[] = [];
  const seenB: number[] = [];
  const unsubscribeA = hub.subscribe("job-1", (event) => seenA.push(event.id));
  hub.subscribe("job-2", (event) => seenB.push(event.id));
  hub.subscribe("job-1", () => {
    throw new Error("listener must not break the emitter");
  });

  hub.publish("job-1", { id: 1, at: "", type: "log", data: {} });
  unsubscribeA();
  hub.publish("job-1", { id: 2, at: "", type: "log", data: {} });
  hub.publish("job-2", { id: 3, at: "", type: "log", data: {} });

  assert.deepEqual(seenA, [1]);
  assert.deepEqual(seenB, [3]);
});
