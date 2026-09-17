/**
 * @file index.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description CLI 入口辅助函数（参数解析、路径校验与渲染摘要）的单元测试；brief 解析与语言推断用例已随实现迁入 core/brief.test.ts
 * @see https://github.com/1241751430/AIVideo.git
 */
import assert from "node:assert/strict";
import test from "node:test";
import { assertPathWithin, getVideoReadySummary, parseArgs } from "./cli.js";

test("parseArgs supports inline and positional arguments", () => {
  const parsed = parseArgs(["generate", "--theme", "新品发布", "--duration=45s", "--live"]);
  assert.deepEqual(parsed.command, ["generate"]);
  assert.equal(parsed.options.theme, "新品发布");
  assert.equal(parsed.options.duration, "45s");
  assert.equal(parsed.options.live, true);
});

test("assertPathWithin rejects paths outside the base directory", () => {
  assert.throws(
    () => assertPathWithin("/tmp/projects", "/tmp/other/project", "Project directory"),
    /must stay within/
  );
});

test("parseArgs supports new safety flags", () => {
  const parsed = parseArgs(["generate", "--no-persist-artifacts", "--cleanup-after-render"]);
  assert.equal(parsed.options["no-persist-artifacts"], true);
  assert.equal(parsed.options["cleanup-after-render"], true);
});

test("parseArgs supports cleanup keep-days option", () => {
  const parsed = parseArgs(["cleanup", "--keep-days", "3"]);
  assert.deepEqual(parsed.command, ["cleanup"]);
  assert.equal(parsed.options["keep-days"], "3");
});

test("parseArgs supports help and create command", () => {
  const helpParsed = parseArgs(["--help"]);
  assert.equal(helpParsed.options.help, true);

  const createParsed = parseArgs(["create"]);
  assert.deepEqual(createParsed.command, ["create"]);
});

test("parseArgs supports dry-run flag", () => {
  const parsed = parseArgs(["generate", "--brief", "test", "--dry-run"]);
  assert.equal(parsed.options["dry-run"], true);
});

test("getVideoReadySummary includes direct video path and file link", () => {
  const lines = getVideoReadySummary("/tmp/project/demo", "/tmp/project/demo/output/final.mp4");
  assert.equal(lines[0], "Video generation complete.");
  assert.match(lines[1] ?? "", /Project directory: \/tmp\/project\/demo/);
  assert.match(lines[2] ?? "", /Final video: \/tmp\/project\/demo\/output\/final\.mp4/);
  assert.match(lines[3] ?? "", /^Open file: file:\/\/\/tmp\/project\/demo\/output\/final\.mp4$/);
  assert.match(lines[5] ?? "", /Next steps/);
  assert.match(lines[6] ?? "", /Re-render/);
  assert.match(lines[7] ?? "", /Cleanup/);
});
