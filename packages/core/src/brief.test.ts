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
