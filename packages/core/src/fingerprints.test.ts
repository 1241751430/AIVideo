/**
 * @file fingerprints.test.ts
 * @author zhangbaohong
 * @date 2026-10-27
 * @description fingerprints.ts 的单元测试：稳定序列化、四类阶段指纹对各自输入变化的敏感度（以及对无关字段的不敏感）、
 * 指纹文件的读取容错与按镜头 id 合并写入、unknown 语义，以及 plan 视图对老项目/新项目的判定。
 * @see https://github.com/1241751430/AIVideo.git
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  STAGE_FINGERPRINTS_FILE,
  assetsShotFingerprint,
  audioShotFingerprint,
  buildStagePlan,
  compareStageFingerprint,
  readStageFingerprints,
  recordStageFingerprints,
  renderStageFingerprint,
  scriptStageFingerprint,
  stableStringify,
  writeStageFingerprints
} from "./fingerprints.js";
import type { BriefDocument, RenderManifest, StoryboardShot } from "./types.js";

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：创建临时项目目录（指纹文件按需由用例写入）。
 */
function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "aivideo-fingerprints-"));
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：一份完整的任务请求指纹输入。
 */
function scriptInput(): Parameters<typeof scriptStageFingerprint>[0] {
  return {
    theme: "露营装备",
    content: "三件必买",
    images: [],
    skill: "auto",
    mode: "video",
    aspectRatio: "9:16",
    durationSeconds: 30,
    language: "zh-CN",
    platform: "douyin"
  };
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：可直接展开覆盖字段的镜头。
 */
function shot(overrides: Partial<StoryboardShot> = {}): StoryboardShot {
  return {
    id: "s1",
    title: "开场",
    narration: "第一句旁白",
    caption: "第一句旁白",
    visualPrompt: "帐篷在湖边",
    shotType: "wide",
    durationSeconds: 5,
    transition: "fade",
    assetSource: "generated_image",
    ...overrides
  };
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：最小可用 brief。
 */
function brief(overrides: Partial<BriefDocument> = {}): BriefDocument {
  return {
    theme: "露营装备",
    content: "三件必买",
    inputImages: [],
    selectedSkillId: "auto",
    selectedSkillName: "自动",
    language: "zh-CN",
    platform: "douyin",
    aspectRatio: "9:16",
    durationSeconds: 30,
    creativeDirection: "",
    ...overrides
  };
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：最小可用渲染清单。
 */
function manifest(overrides: Partial<RenderManifest> = {}): RenderManifest {
  return {
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    durationSeconds: 5,
    bgmStyle: "calm",
    outputFile: "output/final.mp4",
    captionsFile: "captions.srt",
    shots: [
      {
        shotId: "s1",
        title: "开场",
        durationSeconds: 5,
        assetKind: "image",
        overlayText: "开场",
        caption: "第一句旁白",
        visualPrompt: "帐篷在湖边"
      }
    ],
    ...overrides
  };
}

test("fingerprints: stableStringify ignores key order and drops undefined", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify({ a: 1, b: undefined }), stableStringify({ a: 1 }));
  assert.equal(stableStringify([{ b: 1, a: [2, 3] }]), '[{"a":[2,3],"b":1}]');
});

test("fingerprints: script fingerprint tracks every request field that changes the script", () => {
  const base = scriptStageFingerprint(scriptInput());
  assert.equal(scriptStageFingerprint(scriptInput()), base, "同一份输入必须得到同一指纹");

  for (const patch of [
    { theme: "别的主题" },
    { content: "别的正文" },
    { skill: "product-showcase" },
    { mode: "script" },
    { aspectRatio: "16:9" },
    { durationSeconds: 60 },
    { language: "en-US" },
    { platform: "bilibili" }
  ]) {
    assert.notEqual(
      scriptStageFingerprint({ ...scriptInput(), ...patch }),
      base,
      `script 指纹应对 ${JSON.stringify(patch)} 变化`
    );
  }
});

test("fingerprints: script fingerprint tracks reference image identity and size", () => {
  const dir = tempProject();
  const small = join(dir, "ref.png");
  const large = join(dir, "ref2.png");
  writeFileSync(small, "x");
  writeFileSync(large, "xx");

  const none = scriptStageFingerprint(scriptInput());
  const withSmall = scriptStageFingerprint({ ...scriptInput(), images: [small] });
  const withLarge = scriptStageFingerprint({ ...scriptInput(), images: [large] });
  const withMissing = scriptStageFingerprint({ ...scriptInput(), images: [join(dir, "absent.png")] });

  assert.notEqual(withSmall, none);
  assert.notEqual(withLarge, withSmall);
  assert.notEqual(withMissing, none);
  // 同名同大小的替换无法识别（有意为之：不为每张图读全量内容）。
  assert.equal(scriptStageFingerprint({ ...scriptInput(), images: [small] }), withSmall);
});

test("fingerprints: assets fingerprint follows the editing invalidation matrix", () => {
  const base = assetsShotFingerprint({ shot: shot(), aspectRatio: "9:16" });
  assert.equal(assetsShotFingerprint({ shot: shot(), aspectRatio: "9:16" }), base);

  assert.notEqual(assetsShotFingerprint({ shot: shot({ visualPrompt: "换成夜景" }), aspectRatio: "9:16" }), base);
  assert.notEqual(assetsShotFingerprint({ shot: shot(), aspectRatio: "16:9" }), base);
  assert.notEqual(assetsShotFingerprint({ shot: shot({ assetSource: "title_card" }), aspectRatio: "9:16" }), base);
  // 改旁白/字幕/时长不该重花图片钱。
  assert.equal(assetsShotFingerprint({ shot: shot({ narration: "新旁白", caption: "新字幕", durationSeconds: 9 }), aspectRatio: "9:16" }), base);
});

test("fingerprints: assets fingerprint tracks the bound reference image only for reference shots", () => {
  const reference = shot({ assetSource: "reference_image", inputImageIndex: 0 });
  const withFirst = assetsShotFingerprint({ shot: reference, aspectRatio: "9:16", referenceImageIndex: 0 });
  const withSecond = assetsShotFingerprint({ shot: reference, aspectRatio: "9:16", referenceImageIndex: 1 });
  assert.notEqual(withSecond, withFirst, "换绑另一张参考图必须重做");

  // 非参考镜不携带下标：多传一个下标也不该改变指纹。
  const generated = shot();
  assert.equal(
    assetsShotFingerprint({ shot: generated, aspectRatio: "9:16", referenceImageIndex: 1 }),
    assetsShotFingerprint({ shot: generated, aspectRatio: "9:16" })
  );
});

test("fingerprints: audio fingerprint tracks narration, duration and language", () => {
  const base = audioShotFingerprint({ shot: shot(), language: "zh-CN" });
  assert.equal(audioShotFingerprint({ shot: shot(), language: "zh-CN" }), base);
  assert.notEqual(audioShotFingerprint({ shot: shot({ narration: "新旁白" }), language: "zh-CN" }), base);
  assert.notEqual(audioShotFingerprint({ shot: shot({ durationSeconds: 8 }), language: "zh-CN" }), base);
  assert.notEqual(audioShotFingerprint({ shot: shot(), language: "en-US" }), base);
  assert.equal(audioShotFingerprint({ shot: shot({ visualPrompt: "换画面", caption: "换字幕" }), language: "zh-CN" }), base);
});

test("fingerprints: render fingerprint tracks manifest inputs and asset file state", () => {
  const dir = tempProject();
  const assetPath = join(dir, "assets", "s1.png");
  const audioPath = join(dir, "audio", "s1.wav");
  const renderManifest = manifest({
    shots: [
      {
        shotId: "s1",
        title: "开场",
        durationSeconds: 5,
        assetKind: "image",
        assetPath: "assets/s1.png",
        audioPath: "audio/s1.wav",
        overlayText: "开场",
        caption: "第一句旁白",
        visualPrompt: "帐篷在湖边"
      }
    ]
  });
  const fingerprint = (): string => renderStageFingerprint({ projectDir: dir, manifest: renderManifest });

  // 素材尚未落盘：恰好是渲染阶段启动前的状态。
  const beforeAssets = fingerprint();
  assert.equal(fingerprint(), beforeAssets);

  mkdirSync(join(dir, "assets"), { recursive: true });
  mkdirSync(join(dir, "audio"), { recursive: true });
  writeFileSync(assetPath, "png");
  writeFileSync(audioPath, "wav");
  const rendered = fingerprint();
  assert.notEqual(rendered, beforeAssets, "素材出现即改变指纹");

  // 素材被重新生成（内容长度变化）同样改变指纹。
  writeFileSync(assetPath, "png-longer");
  assert.notEqual(fingerprint(), rendered);

  const stable = fingerprint();
  const mtimeMs = statSync(assetPath).mtimeMs;
  assert.equal(fingerprint(), stable, "同一状态重复计算必须一致");
  assert.ok(mtimeMs > 0);

  // 清单字段变化（尺寸、BGM、字幕文本）都要重渲。
  const withCaption = manifest({ ...renderManifest, shots: [{ ...renderManifest.shots[0]!, caption: "改过的字幕" }] });
  assert.notEqual(renderStageFingerprint({ projectDir: dir, manifest: withCaption }), stable);
  const withBgm = manifest({ ...renderManifest, bgmStyle: "energetic" });
  assert.notEqual(renderStageFingerprint({ projectDir: dir, manifest: withBgm }), stable);
  const withSize = manifest({ ...renderManifest, width: 720, height: 1280 });
  assert.notEqual(renderStageFingerprint({ projectDir: dir, manifest: withSize }), stable);
});

test("fingerprints: readStageFingerprints reports unknown for missing, corrupt or version-mismatched files", () => {
  const dir = tempProject();
  assert.equal(readStageFingerprints(dir), null, "缺失 = 无指纹");
  assert.equal(readStageFingerprints(join(dir, "nope")), null);

  const filePath = join(dir, STAGE_FINGERPRINTS_FILE);
  writeFileSync(filePath, "{ not json");
  assert.equal(readStageFingerprints(dir), null, "损坏 = 无指纹");

  writeFileFingerprintFile(filePath, { version: 99, script: "abc" });
  assert.equal(readStageFingerprints(dir), null, "版本不符 = 无指纹（旧算法结论不可信）");

  writeFileFingerprintFile(filePath, { version: 1, script: "abc", assets: "oops", audio: { s1: 1 } });
  assert.deepEqual(readStageFingerprints(dir), { version: 1, script: "abc" }, "形状不对的字段被丢弃");

  writeFileFingerprintFile(filePath, { version: 1, script: "abc", assets: { s1: "x" }, render: "r" });
  assert.deepEqual(readStageFingerprints(dir), { version: 1, script: "abc", assets: { s1: "x" }, render: "r" });
});

test("fingerprints: recordStageFingerprints merges shot maps and overwrites singletons", () => {
  const dir = tempProject();
  recordStageFingerprints(dir, { script: "script-1", assets: { s1: "a1" } });
  recordStageFingerprints(dir, { assets: { s2: "a2" }, audio: { s1: "au1" } });
  recordStageFingerprints(dir, { script: "script-2", render: "r1" });

  assert.deepEqual(readStageFingerprints(dir), {
    version: 1,
    script: "script-2",
    assets: { s1: "a1", s2: "a2" },
    audio: { s1: "au1" },
    render: "r1"
  });
});

test("fingerprints: compareStageFingerprint treats a missing record as unknown", () => {
  assert.equal(compareStageFingerprint(undefined, "x"), "unknown");
  assert.equal(compareStageFingerprint("x", "x"), "match");
  assert.equal(compareStageFingerprint("x", "y"), "mismatch");
});

test("fingerprints: buildStagePlan reports unknown everywhere for a legacy project", () => {
  const dir = tempProject();
  const plan = buildStagePlan({
    projectDir: dir,
    request: scriptInput(),
    artifacts: { brief: brief(), storyboard: { shots: [shot()] }, renderManifest: manifest() }
  });
  assert.deepEqual(plan.map((entry) => entry.stage), ["script", "assets", "audio", "render"]);
  assert.deepEqual(plan.map((entry) => entry.status), ["unknown", "unknown", "unknown", "unknown"]);
});

test("fingerprints: buildStagePlan without artifacts or request degrades to unknown", () => {
  const dir = tempProject();
  recordStageFingerprints(dir, { script: "whatever" });
  const plan = buildStagePlan({ projectDir: dir });
  assert.deepEqual(plan.map((entry) => entry.status), ["unknown", "unknown", "unknown", "unknown"]);
});

test("fingerprints: buildStagePlan lists only the shots whose inputs changed", () => {
  const dir = tempProject();
  const shots = [shot(), shot({ id: "s2", visualPrompt: "第二镜画面" })];
  const renderManifest = manifest();
  const artifacts = { brief: brief(), storyboard: { shots }, renderManifest };

  // 先记录一份与当前输入一致的指纹。
  const assets = Object.fromEntries(
    shots.map((entry) => [entry.id, assetsShotFingerprint({ shot: entry, aspectRatio: "9:16" })])
  );
  const audio = Object.fromEntries(
    shots.map((entry) => [entry.id, audioShotFingerprint({ shot: entry, language: "zh-CN" })])
  );
  recordStageFingerprints(dir, {
    script: scriptStageFingerprint(scriptInput()),
    assets,
    audio,
    render: renderStageFingerprint({ projectDir: dir, manifest: renderManifest })
  });

  const fresh = buildStagePlan({ projectDir: dir, request: scriptInput(), artifacts });
  assert.deepEqual(fresh.map((entry) => entry.status), ["match", "match", "match", "match"]);

  // 改第二镜的画面词 → 只有它需要重做素材；旁白未变，配音阶段不受影响。
  const editedShots = [shot(), shot({ id: "s2", visualPrompt: "改过的画面词" })];
  const stale = buildStagePlan({
    projectDir: dir,
    request: scriptInput(),
    artifacts: { ...artifacts, storyboard: { shots: editedShots } }
  });
  assert.equal(stale[1]!.status, "mismatch");
  assert.deepEqual(stale[1]!.staleShots, ["s2"]);
  assert.equal(stale[2]!.status, "match");
  assert.equal(stale[3]!.status, "match");
});

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：直接写一份任意形状的指纹文件（绕过类型约束以覆盖损坏/旧版本分支）。
 */
function writeFileFingerprintFile(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value), "utf8");
}

test("fingerprints: writeStageFingerprints stamps the current version and leaves no tmp file", () => {
  const dir = tempProject();
  writeStageFingerprints(dir, { version: 42, script: "abc" });
  assert.deepEqual(readStageFingerprints(dir), { version: 1, script: "abc" });
  assert.equal(readStageFingerprints(join(dir, `${STAGE_FINGERPRINTS_FILE}.tmp`)), null);
});