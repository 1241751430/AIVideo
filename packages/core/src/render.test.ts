/**
 * @file render.test.ts
 * @author zhangbaohong
 * @date 2026-10-28
 * @description render.ts 的单元测试：覆盖不依赖 ffmpeg 的部分——上一版成片备份路径的推导（常规扩展名、多点文件名、无扩展名），以及渲染 worker 起不来时「旧成片被挪走后必须还原」这条回滚路径。
 * @see https://github.com/1241751430/AIVideo.git
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { previousVideoRelativePath, renderProject } from "./render.js";

test("previousVideoRelativePath 在扩展名前插入 .prev", () => {
  assert.equal(previousVideoRelativePath("output/final.mp4"), "output/final.prev.mp4");
  // 多点文件名只认最后一段扩展名，否则会把 final.part 也当成扩展名的一部分。
  assert.equal(previousVideoRelativePath("output/v1.2.final.mp4"), "output/v1.2.final.prev.mp4");
  // 没有扩展名时后缀直接追加（manifest 由 worker 写，正常不会出现，但不能因此抛错）。
  assert.equal(previousVideoRelativePath("output/final"), "output/final.prev");
  // 上级目录里的点不能被误认作扩展名。
  assert.equal(previousVideoRelativePath("a.b/final.mp4"), "a.b/final.prev.mp4");
});

test("renderProject worker 失败时把旧成片还原到原路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "aivideo-render-"));
  const projectDir = join(root, "p1");
  mkdirSync(join(projectDir, "output"), { recursive: true });
  writeFileSync(join(projectDir, "output", "final.mp4"), "old-video", "utf8");
  writeFileSync(
    join(projectDir, "render-manifest.json"),
    JSON.stringify({ shots: [], outputFile: "output/final.mp4" }),
    "utf8"
  );

  // 指向不存在的脚本：worker 必然起不来，正好验证「重渲失败不会把现有成片弄丢」。
  await assert.rejects(
    renderProject({
      projectsRoot: root,
      projectDir,
      workerScript: join(root, "no-such-worker.py")
    })
  );
  assert.ok(existsSync(join(projectDir, "output", "final.mp4")), "旧成片已还原");
  assert.equal(existsSync(join(projectDir, "output", "final.prev.mp4")), false, "备份槽位不留残骸");
});