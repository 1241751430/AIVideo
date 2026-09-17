/**
 * @file shotFiles.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description shotFiles.ts 的单元测试：shotId 合法性校验、每镜路径助手的越界拒绝、manifest 资产路径合并去重、删除资产的范围与 manifest 无条件重写、参考图回退以及配音删除。
 * @see https://github.com/1241751430/AIVideo.git
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deleteShotAudio,
  deleteShotGeneratedAssets,
  isValidShotId,
  manifestAssetPaths,
  shotAudioPath,
  shotImagePath,
  shotVideoPath
} from "./shotFiles.js";
import { RenderManifest } from "./types.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：创建含 assets/ 与 audio/ 子目录的临时项目目录并返回其路径。
 */
function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aivideo-shots-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  mkdirSync(join(dir, "audio"), { recursive: true });
  return dir;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：用给定 shots 数组拼装一份最小可渲染清单对象（RenderManifest）。
 * @param shots 清单中的逐镜条目数组
 * @returns 可直接写入磁盘的 RenderManifest 对象
 */
function manifestWith(shots: RenderManifest["shots"]): RenderManifest {
  return {
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    durationSeconds: 10,
    bgmStyle: "x",
    outputFile: "output/final.mp4",
    captionsFile: "captions/captions.srt",
    shots
  };
}

test("isValidShotId accepts slugified ids and rejects traversal", () => {
  assert.ok(isValidShotId("scene-1"));
  assert.ok(isValidShotId("开场_1")); // CJK survives workflow's slugify
  assert.ok(!isValidShotId("../etc/passwd"));
  assert.ok(!isValidShotId("a/b"));
  assert.ok(!isValidShotId(""));
  assert.ok(!isValidShotId("-lead"));
});

test("shot path helpers stay under the project dir", () => {
  const dir = tempProject();
  assert.equal(shotVideoPath(dir, "s1"), join(dir, "assets", "s1.mp4"));
  assert.equal(shotImagePath(dir, "s1"), join(dir, "assets", "s1.png"));
  assert.equal(shotAudioPath(dir, "s1"), join(dir, "audio", "s1.wav"));
  assert.throws(() => shotVideoPath(dir, "../escape"), /Invalid shot id/);
});

test("manifestAssetPaths merges conventional and recorded in-project paths only", () => {
  const dir = tempProject();
  const outside = join(dir, "..", "user-photo.png");
  const paths = manifestAssetPaths(dir, {
    shotId: "s1",
    title: "t",
    durationSeconds: 2,
    assetKind: "image",
    assetPath: outside,
    overlayText: "t",
    caption: "c",
    visualPrompt: "v"
  });
  assert.deepEqual(paths, [shotVideoPath(dir, "s1"), shotImagePath(dir, "s1")]);

  const recorded = join(dir, "assets", "custom", "clip.mp4");
  const merged = manifestAssetPaths(dir, {
    shotId: "s1",
    title: "t",
    durationSeconds: 2,
    assetKind: "video",
    assetPath: recorded,
    overlayText: "t",
    caption: "c",
    visualPrompt: "v"
  });
  assert.deepEqual(merged, [shotVideoPath(dir, "s1"), shotImagePath(dir, "s1"), recorded]);

  const conventionalSpelled = `assets/${"s1"}.mp4`;
  const deduped = manifestAssetPaths(dir, {
    shotId: "s1",
    title: "t",
    durationSeconds: 2,
    assetKind: "video",
    assetPath: conventionalSpelled,
    overlayText: "t",
    caption: "c",
    visualPrompt: "v"
  });
  assert.equal(deduped.length, 2);
});

test("deleteShotGeneratedAssets removes files, skips external paths, and always rewrites the manifest", () => {
  const dir = tempProject();
  const external = join(dir, "..", "user-image.png");
  writeFileSync(external, "user");
  const manifest = manifestWith([
    {
      shotId: "s1",
      title: "t",
      durationSeconds: 2,
      assetKind: "video",
      assetPath: "assets/custom/clip.mp4",
      overlayText: "t",
      caption: "c",
      visualPrompt: "v"
    },
    {
      // A reference shot still pointing at the user's own file: must survive.
      shotId: "s2",
      title: "t2",
      durationSeconds: 2,
      assetKind: "image",
      assetPath: external,
      overlayText: "t2",
      caption: "c2",
      visualPrompt: "v2"
    }
  ]);
  mkdirSync(join(dir, "assets", "custom"), { recursive: true });
  const manifestPath = join(dir, "render-manifest.json");
  writeFileSync(shotVideoPath(dir, "s1"), "v");
  writeFileSync(join(dir, "assets", "custom", "clip.mp4"), "c");
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, sentinel: "stale" }));

  const { deleted } = deleteShotGeneratedAssets(dir, manifest, "s1");
  assert.ok(!existsSync(shotVideoPath(dir, "s1")));
  assert.ok(!existsSync(join(dir, "assets", "custom", "clip.mp4")));
  assert.ok(existsSync(external), "user image outside the project must survive");
  assert.ok(deleted.includes(shotVideoPath(dir, "s1")));

  assert.equal(manifest.shots[0]!.assetKind, "generated-card");
  assert.equal(manifest.shots[0]!.assetPath, undefined);
  assert.equal(manifest.shots[1]!.assetPath, external, "other entries stay untouched");
  // Rewritten unconditionally, replacing the stale sentinel copy on disk.
  const written = JSON.parse(readFileSync(manifestPath, "utf8")) as { shots: RenderManifest["shots"] };
  assert.equal(written.shots[0]!.assetKind, "generated-card");
  assert.ok(!("sentinel" in written));

  // Nothing left to delete still rewrites and reports empty.
  const again = deleteShotGeneratedAssets(dir, manifest, "s1");
  assert.deepEqual(again.deleted, []);
  assert.ok(existsSync(external));
});

test("deleteShotGeneratedAssets restores a reference shot's user image entry", () => {
  const dir = tempProject();
  const manifest = manifestWith([
    {
      shotId: "s1",
      title: "t",
      durationSeconds: 2,
      assetKind: "video",
      overlayText: "t",
      caption: "c",
      visualPrompt: "v"
    }
  ]);
  const userImage = join(dir, "..", "photo.png");
  const { deleted } = deleteShotGeneratedAssets(dir, manifest, "s1", {
    assetKind: "image",
    assetPath: userImage
  });
  assert.deepEqual(deleted, []);
  assert.equal(manifest.shots[0]!.assetKind, "image");
  assert.equal(manifest.shots[0]!.assetPath, userImage);
});

test("deleteShotAudio removes the wav when present", () => {
  const dir = tempProject();
  assert.deepEqual(deleteShotAudio(dir, "s1"), { deleted: [] });
  writeFileSync(shotAudioPath(dir, "s1"), "wav");
  assert.deepEqual(deleteShotAudio(dir, "s1"), { deleted: [shotAudioPath(dir, "s1")] });
  assert.ok(!existsSync(shotAudioPath(dir, "s1")));
});
