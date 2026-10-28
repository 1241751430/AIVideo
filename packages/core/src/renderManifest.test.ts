/**
 * @file renderManifest.test.ts
 * @author zhangbaohong
 * @date 2026-10-27
 * @description renderManifest.ts 的单元测试：新格式（input/state 分节）往返无损、老格式原样透传、state 按 shotId 绑定因此重排不需要动状态、损坏与结构不识别统一返回 null、写盘时丢弃未知字段且可选字段缺省不落键。
 * @see https://github.com/1241751430/AIVideo.git
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeRenderManifest, readRenderManifestFile, writeRenderManifestFile } from "./renderManifest.js";
import { RenderManifest } from "./types.js";

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：临时项目目录。
 */
function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "aivideo-manifest-"));
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：两镜清单，首镜带完整执行状态、次镜只有 assetKind。
 */
function sampleManifest(): RenderManifest {
  return {
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    durationSeconds: 10,
    bgmStyle: "calm",
    outputFile: "output/final.mp4",
    captionsFile: "captions/captions.srt",
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
      },
      {
        shotId: "s2",
        title: "结尾",
        durationSeconds: 5,
        assetKind: "generated-card",
        overlayText: "结尾",
        caption: "第二句旁白",
        visualPrompt: "日落"
      }
    ]
  };
}

test("renderManifest: write splits input and state, read merges them back losslessly", () => {
  const dir = tempProject();
  const manifest = sampleManifest();
  writeRenderManifestFile(dir, manifest);

  const onDisk = JSON.parse(readFileSync(join(dir, "render-manifest.json"), "utf8")) as Record<string, any>;
  assert.equal(onDisk.version, 1);
  assert.deepEqual(onDisk.input.shots[0], {
    shotId: "s1",
    title: "开场",
    durationSeconds: 5,
    overlayText: "开场",
    caption: "第一句旁白",
    visualPrompt: "帐篷在湖边"
  }, "渲染入参不含任何执行状态");
  assert.deepEqual(onDisk.state.shots.s1, {
    assetKind: "image",
    assetPath: "assets/s1.png",
    audioPath: "audio/s1.wav"
  }, "执行状态按 shotId 落节");
  assert.deepEqual(onDisk.state.shots.s2, { assetKind: "generated-card" }, "缺省的可选字段不落键");

  assert.deepEqual(readRenderManifestFile(dir), manifest, "读回与写前完全等值");
});

test("renderManifest: reordering input.shots remaps state by id, not by slot", () => {
  const dir = tempProject();
  const manifest = sampleManifest();
  writeRenderManifestFile(dir, manifest);

  // 只重排入参顺序（模拟 reorderShots 的做法），状态一字节不动。
  const [first, second] = manifest.shots;
  writeRenderManifestFile(dir, { ...manifest, shots: [second!, first!] });
  const read = readRenderManifestFile(dir)!;
  assert.deepEqual(read.shots.map((shot) => shot.shotId), ["s2", "s1"]);
  assert.equal(read.shots[1]!.assetPath, "assets/s1.png", "s1 的资产跟着 id 走");
  assert.equal(read.shots[0]!.assetPath, undefined);
});

test("renderManifest: legacy flat manifests pass through untouched", () => {
  const dir = tempProject();
  // 老项目的形状：顶层直接是 shots，还带着非枚举的 assetKind 与未知字段。
  const legacy = {
    aspectRatio: "16:9",
    width: 1280,
    height: 720,
    durationSeconds: 3,
    bgmStyle: "x",
    outputFile: "output/final.mp4",
    captionsFile: "captions/captions.srt",
    shots: [{ shotId: "shot-1", assetKind: "generated-image", assetPath: "assets/shot-1.png" }],
    unknownField: "keep me"
  };
  writeFileSync(join(dir, "render-manifest.json"), JSON.stringify(legacy));
  assert.deepEqual(readRenderManifestFile(dir), legacy, "原样透传：不补默认值、不丢未知字段");
});

test("renderManifest: missing, corrupt and unrecognized files all read as null", () => {
  const dir = tempProject();
  assert.equal(readRenderManifestFile(dir), null, "缺失");
  writeFileSync(join(dir, "render-manifest.json"), "{ not json");
  assert.equal(readRenderManifestFile(dir), null, "损坏");
  assert.equal(normalizeRenderManifest({ input: {} }), null, "input 下没有 shots 数组");
  assert.equal(normalizeRenderManifest([]), null, "数组不是清单");
  assert.equal(normalizeRenderManifest(null), null);
});

test("renderManifest: writing drops unknown top-level fields and keeps output paths in input", () => {
  const dir = tempProject();
  const manifest = { ...sampleManifest(), sentinel: "stale" } as RenderManifest;
  writeRenderManifestFile(dir, manifest);
  const onDisk = JSON.parse(readFileSync(join(dir, "render-manifest.json"), "utf8")) as Record<string, any>;
  assert.ok(!("sentinel" in onDisk), "未知顶层字段不写盘");
  assert.equal(onDisk.input.outputFile, "output/final.mp4");
  assert.equal(onDisk.input.captionsFile, "captions/captions.srt");
});

test("renderManifest: state entry missing for a shot falls back to an ungenerated title card", () => {
  const dir = tempProject();
  const manifest = sampleManifest();
  writeRenderManifestFile(dir, manifest);
  const onDisk = JSON.parse(readFileSync(join(dir, "render-manifest.json"), "utf8")) as Record<string, any>;
  delete onDisk.state.shots.s1;
  writeFileSync(join(dir, "render-manifest.json"), JSON.stringify(onDisk));
  const read = readRenderManifestFile(dir)!;
  assert.equal(read.shots[0]!.assetKind, "generated-card");
  assert.equal(read.shots[0]!.assetPath, undefined);
});