import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPathWithin,
  getVideoReadySummary,
  inferInputLanguage,
  parseArgs,
  parseDuration,
  parseStructuredBrief
} from "./cli.js";

test("parseDuration understands second suffix", () => {
  assert.equal(parseDuration("45s"), 45);
  assert.equal(parseDuration("30"), 30);
});

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

test("parseStructuredBrief understands Chinese structured input", () => {
  const parsed = parseStructuredBrief(
    "主题：夏季防晒喷雾；主要内容：清爽不油腻；输出模式：视频；视频比例：9:16；视频时长：30s；语言：zh-CN"
  );

  assert.equal(parsed.theme, "夏季防晒喷雾");
  assert.equal(parsed.content, "清爽不油腻");
  assert.equal(parsed.mode, "video");
  assert.equal(parsed.aspect, "9:16");
  assert.equal(parsed.duration, "30s");
  assert.equal(parsed.language, "zh-CN");
});

test("parseStructuredBrief understands English keys and falls back to theme", () => {
  const parsed = parseStructuredBrief("Theme: Summer sunscreen spray; Mode: script; Skill: Ecommerce");
  assert.equal(parsed.theme, "Summer sunscreen spray");
  assert.equal(parsed.mode, "script");
  assert.equal(parsed.skill, "ecommerce");

  const fallback = parseStructuredBrief("只有一句主题说明");
  assert.equal(fallback.theme, "只有一句主题说明");
});

test("inferInputLanguage prefers input language when not explicitly provided", () => {
  assert.equal(inferInputLanguage(["夏季防晒喷雾", "清爽不油腻"]), "zh-CN");
  assert.equal(inferInputLanguage(["Summer sunscreen spray", "Lightweight and non-greasy"]), "en-US");
  assert.equal(inferInputLanguage(["夏季防晒喷雾", "Lightweight and non-greasy"]), "zh-CN");
  assert.equal(inferInputLanguage([]), undefined);
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
