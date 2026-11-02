/**
 * @file brief.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 结构化 brief 解析测试：中英键名识别、单句兜底为主题、输入语言推断与时长解析（原 CLI 用例迁入 core，保证 CLI 与工作台共用同一实现）。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inferInputLanguage, parseStructuredBrief } from "./brief.js";
import { parseDuration } from "./utils.js";

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

test("parseDuration understands second suffix", () => {
  assert.equal(parseDuration("45s"), 45);
  assert.equal(parseDuration("30"), 30);
});

test("parseStructuredBrief 把台词块整段取走，而不是按分号切开", () => {
  // 台词里同时出现半角分号、全角分号和换行——它们全是 brief 的分段符，
  // 若台词不先整块摘走，这里会被切成四段残句，只有第一句能落进 dialogue。
  const parsed = parseStructuredBrief("主题：防晒喷雾\n台词：甲说：你好；乙说：再见;\n第三句！");
  assert.equal(parsed.theme, "防晒喷雾");
  assert.equal(parsed.dialogue, "甲说：你好；乙说：再见;\n第三句！");
  // 摘走台词块之后，其余段落仍按原逻辑解析。
  assert.equal(parsed.content, undefined);
});

test("parseStructuredBrief 保留台词内部换行且不因 CRLF 多出空行", () => {
  // Windows 文本：`\r\n` 只折成一个 `\n`。若把 `\r` 单独换成 `\n`，每行之间会多出一个空行，
  // 台词是要逐字进配音的，那点空行会真的变成朗读里的停顿。
  const parsed = parseStructuredBrief("主题：夏天\r\n台词：第一句。\r\n第二句。\r\n");
  assert.equal(parsed.theme, "夏天");
  assert.equal(parsed.dialogue, "第一句。\n第二句。");
});

test("parseStructuredBrief 只剩台词时不会把台词当主题", () => {
  const parsed = parseStructuredBrief("台词：今天我们来聊聊防晒。");
  assert.equal(parsed.dialogue, "今天我们来聊聊防晒。");
  assert.equal(parsed.theme, undefined);
});

test("parseStructuredBrief 单句台词仍然可用且只去首尾空白", () => {
  const parsed = parseStructuredBrief("  主题：防晒霜；dialogue:   你好，世界。  ");
  assert.equal(parsed.theme, "防晒霜");
  // 句中的标点与空格原样：只允许掐掉标记两侧及首尾的空白。
  assert.equal(parsed.dialogue, "你好，世界。");
});
