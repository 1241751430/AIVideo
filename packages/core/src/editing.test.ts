/**
 * @file editing.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description editing.ts 的单元测试：script.json 落盘、旁白/画面词/字幕编辑触发的失效矩阵、storyboard/manifest/captions/script 多处同步、非法输入拒绝与 outputFile 保持不变；另覆盖 reorderShots 的精确重排落盘与拒绝分支。
 * @see https://github.com/1241751430/AIVideo.git
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadScriptPackage, reorderShots, updateScriptMeta, updateShot } from "./editing.js";
import { readRenderManifestFile, writeRenderManifestFile } from "./renderManifest.js";
import { shotAudioPath, shotImagePath, shotVideoPath } from "./shotFiles.js";
import { Storyboard } from "./types.js";
import { buildCaptions, generateArtifacts, materializeProject, toSrt } from "./workflow.js";
import { getSkillById } from "./skills.js";

test("editing: materializeProject persists a machine-readable script.json", async () => {
  const { dir, artifacts } = await materializedProject();
  const script = loadScriptPackage(dir);
  assert.ok(script);
  assert.equal(script.scenes.length, artifacts.storyboard.shots.length);
});

test("editing: narration change deletes only that shot's audio and syncs all artifacts", async () => {
  const { dir, artifacts } = await materializedProject();
  const shot = artifacts.storyboard.shots[0]!;
  for (const entry of artifacts.storyboard.shots) {
    writeFileSync(shotAudioPath(dir, entry.id), "wav");
  }
  const otherId = artifacts.storyboard.shots[1]!.id;

  const result = updateShot(dir, shot.id, { narration: "新旁白内容" });
  assert.equal(result.audioInvalidated, true);
  assert.equal(result.assetInvalidated, false);
  assert.deepEqual(result.deleted, [shotAudioPath(dir, shot.id)]);
  assert.ok(!existsSync(shotAudioPath(dir, shot.id)));
  assert.ok(existsSync(shotAudioPath(dir, otherId)), "other shots keep their audio");

  const storyboard = JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")) as Storyboard;
  assert.equal(storyboard.shots[0]!.narration, "新旁白内容");
  const script = loadScriptPackage(dir);
  assert.equal(script!.scenes[0]!.narration, "新旁白内容");
  assert.match(readFileSync(join(dir, "script.md"), "utf8"), /新旁白内容/);
});

test("editing: visualPrompt change deletes assets and resets the manifest entry", async () => {
  const { dir, artifacts } = await materializedProject();
  const shot = artifacts.storyboard.shots[0]!;
  writeFileSync(shotVideoPath(dir, shot.id), "v");
  writeFileSync(shotImagePath(dir, shot.id), "i");
  const manifest = readRenderManifestFile(dir)!;
  manifest.shots[0]!.assetKind = "video";
  manifest.shots[0]!.assetPath = `assets/${shot.id}.mp4`;
  writeRenderManifestFile(dir, manifest);

  const result = updateShot(dir, shot.id, { visualPrompt: "换一个画面提示词" });
  assert.equal(result.assetInvalidated, true);
  assert.ok(result.deleted.includes(shotVideoPath(dir, shot.id)));
  assert.ok(result.deleted.includes(shotImagePath(dir, shot.id)));
  assert.ok(!existsSync(shotVideoPath(dir, shot.id)));

  const rewritten = readRenderManifestFile(dir)!;
  assert.equal(rewritten.shots[0]!.assetKind, "generated-card");
  assert.equal(rewritten.shots[0]!.assetPath, undefined);
  assert.equal(rewritten.shots[0]!.visualPrompt, "换一个画面提示词");
});

test("editing: reference shot regeneration falls back to the user image, not the title card", async () => {
  const { dir, artifacts } = await materializedProjectWithImage();
  const shot = artifacts.storyboard.shots[0]!;
  assert.equal(shot.assetSource, "reference_image");
  writeFileSync(shotVideoPath(dir, shot.id), "v");

  const result = updateShot(dir, shot.id, { visualPrompt: "动起来" });
  assert.equal(result.assetInvalidated, true);
  const manifest = readRenderManifestFile(dir)!;
  assert.equal(manifest.shots[0]!.assetKind, "image");
  assert.equal(manifest.shots[0]!.assetPath, artifacts.brief.inputImages[0]);
});

test("editing: reference shot keeps its bound user image across a reorder", async () => {
  const { dir, artifacts } = await materializedProjectWithImage();
  const reference = artifacts.storyboard.shots[0]!;
  assert.equal(reference.assetSource, "reference_image");
  assert.equal(reference.inputImageIndex, 0);
  const ids = artifacts.storyboard.shots.map((shot) => shot.id);
  assert.ok(ids.length >= 2, "fixture needs at least two shots to reorder");

  // Move the reference shot off position 0: the binding is by id, not by slot.
  reorderShots(dir, [...ids.slice(1), ids[0]!]);
  const reordered = JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")) as Storyboard;
  const last = reordered.shots[reordered.shots.length - 1]!;
  assert.equal(last.id, reference.id);
  assert.equal(last.inputImageIndex, 0, "inputImageIndex travels with the shot, not the position");

  // Regenerating it must still fall back to the user's own photo — a
  // positional lookup would read inputImages[ids.length - 1], which is unset.
  writeFileSync(shotVideoPath(dir, reference.id), "v");
  const result = updateShot(dir, reference.id, { visualPrompt: "重排后再动起来" });
  assert.equal(result.assetInvalidated, true);
  const manifest = readRenderManifestFile(dir)!;
  const entry = manifest.shots.find((shot) => shot.shotId === reference.id)!;
  assert.equal(entry.assetKind, "image");
  assert.equal(entry.assetPath, artifacts.brief.inputImages[0]);
});

test("editing: caption-only change invalidates nothing but rewrites captions.srt", async () => {
  const { dir, artifacts } = await materializedProject();
  const shot = artifacts.storyboard.shots[0]!;
  writeFileSync(shotAudioPath(dir, shot.id), "wav");
  const srt = join(dir, "captions", "captions.srt");

  const result = updateShot(dir, shot.id, { caption: "新字幕" });
  assert.equal(result.assetInvalidated, false);
  assert.equal(result.audioInvalidated, false);
  assert.deepEqual(result.deleted, []);
  assert.ok(existsSync(shotAudioPath(dir, shot.id)));
  assert.match(readFileSync(srt, "utf8"), /新字幕/);
  const manifest = readRenderManifestFile(dir)!;
  assert.equal(manifest.shots[0]!.caption, "新字幕");
});

test("editing: rejects unknown shots, bad ids, and illegal durations", async () => {
  const { dir, artifacts } = await materializedProject();
  const shot = artifacts.storyboard.shots[0]!;
  assert.throws(() => updateShot(dir, "scene-404", { caption: "x" }), /Unknown shot/);
  assert.throws(() => updateShot(dir, "../../etc", { caption: "x" }), /Invalid shot id/);
  assert.throws(() => updateShot(dir, shot.id, { durationSeconds: 0 }), /at least 1 second/);
  assert.throws(() => updateShot(dir, shot.id, { visualPrompt: "  " }), /non-empty string/);
});

test("editing: script meta updates rewrite script.md and keep the output filename", async () => {
  const { dir, artifacts } = await materializedProject();
  const before = readRenderManifestFile(dir)!.outputFile;

  updateScriptMeta(dir, { title: "新标题方案", bgmStyle: "轻快电子" });
  assert.match(readFileSync(join(dir, "script.md"), "utf8"), /^# 新标题方案/m);
  const after = readRenderManifestFile(dir)!;
  assert.equal(after.outputFile, before, "outputFile must stay stable for old links");
  assert.equal(after.bgmStyle, "轻快电子");
});

test("editing: reorderShots rewrites storyboard/manifest/script order and rebuilds captions.srt", async () => {
  const { dir, artifacts } = await materializedProject();
  const ids = artifacts.storyboard.shots.map((shot) => shot.id);
  assert.ok(ids.length >= 2, "fixture needs at least two shots to reorder");

  // 给首镜挂一个资产路径，验证重排时 manifest 条目连同自身 assetPath 迁移
  const manifest = readRenderManifestFile(dir)!;
  manifest.shots[0]!.assetKind = "video";
  manifest.shots[0]!.assetPath = `assets/${ids[0]}.mp4`;
  writeRenderManifestFile(dir, manifest);

  const reversed = [...ids].reverse();
  const result = reorderShots(dir, reversed);
  assert.deepEqual(result.order, reversed);

  const storyboard = JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")) as Storyboard;
  assert.deepEqual(
    storyboard.shots.map((shot) => shot.id),
    reversed
  );
  const rewritten = readRenderManifestFile(dir)!;
  assert.deepEqual(
    rewritten.shots.map((entry) => entry.shotId),
    reversed
  );
  const lastEntry = rewritten.shots[rewritten.shots.length - 1]!;
  assert.equal(lastEntry.assetPath, `assets/${ids[0]}.mp4`, "asset travels with its own manifest entry");

  const script = loadScriptPackage(dir);
  assert.deepEqual(
    script!.scenes.map((scene) => scene.id),
    reversed,
    "script scenes follow the new order"
  );
  const srt = readFileSync(join(dir, "captions", "captions.srt"), "utf8");
  assert.equal(srt, toSrt(buildCaptions(storyboard)), "captions rebuilt from the reordered storyboard");
});

test("editing: reorderShots rejects empty/duplicate/foreign/missing-id arrays", async () => {
  const { dir, artifacts } = await materializedProject();
  const ids = artifacts.storyboard.shots.map((shot) => shot.id);
  assert.throws(() => reorderShots(dir, []), /non-empty/);
  assert.throws(() => reorderShots(dir, [ids[0]!, ids[0]!]), /permutation/);
  assert.throws(() => reorderShots(dir, [...ids, "shot-999"]), /permutation/);
  assert.throws(() => reorderShots(dir, ids.slice(1)), /permutation/);
  assert.throws(() => reorderShots(dir, [...ids].reverse().map((id, i) => (i === 0 ? "../../etc" : id))), /Invalid shot id/);
});

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：离线生成 marketing 脚本与分镜并落盘为临时项目，返回项目目录与工件。
 * @returns 包含 dir（项目目录）与 artifacts（生成工件）的对象
 */
async function materializedProject() {
  const dir = mkdtempSync(join(tmpdir(), "aivideo-editing-"));
  const artifacts = await generateArtifacts({
    request: {
      theme: "测试主题",
      content: "测试内容",
      images: [],
      skill: "marketing",
      mode: "video",
      aspectRatio: "9:16",
      durationSeconds: 20
    },
    providers: {},
    skill: getSkillById("marketing")!
  });
  materializeProject(dir, artifacts);
  return { dir, artifacts };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：在 materializedProject 基础上附带一张项目外用户参考图，生成带 reference_image 镜头的临时项目。
 * @returns 包含 dir（项目目录）与 artifacts（生成工件）的对象
 */
async function materializedProjectWithImage() {
  const dir = mkdtempSync(join(tmpdir(), "aivideo-editing-"));
  const userImage = join(dir, "..", "user-photo.png");
  writeFileSync(userImage, "fake-png");
  const artifacts = await generateArtifacts({
    request: {
      theme: "测试主题",
      images: [userImage],
      skill: "marketing",
      mode: "video",
      aspectRatio: "9:16",
      durationSeconds: 20
    },
    providers: {},
    skill: getSkillById("marketing")!
  });
  materializeProject(dir, artifacts);
  return { dir, artifacts };
}
