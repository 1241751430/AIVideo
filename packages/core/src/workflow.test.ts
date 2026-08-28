import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, resolveProfileId, validateConfig } from "./config.js";
import { autoSelectSkill } from "./skills.js";
import { GenerateRequest, ProviderSelection, VideoModelProvider } from "./types.js";
import { cleanupExpiredProjects, createProjectId, generateArtifacts, loadAssetArtifacts, materializeProject, prepareGeneratedAssets, toScriptMarkdown, toSrt, validateGenerateRequest } from "./workflow.js";

test("autoSelectSkill chooses ecommerce for shopping intent", () => {
  const skill = autoSelectSkill({
    theme: "夏季防晒喷雾优惠活动",
    content: "突出种草、下单和领券"
  });
  assert.equal(skill.id, "ecommerce");
});

test("validateGenerateRequest rejects empty input", () => {
  assert.throws(
    () =>
      validateGenerateRequest({
        skill: "marketing",
        mode: "script",
        aspectRatio: "9:16",
        durationSeconds: 30
      }),
    /At least one/
  );
});

test("validateGenerateRequest rejects oversized workloads", () => {
  assert.throws(
    () =>
      validateGenerateRequest({
        theme: "长视频",
        skill: "marketing",
        mode: "video",
        aspectRatio: "9:16",
        durationSeconds: 601
      }),
    /600 seconds or less/
  );

  assert.throws(
    () =>
      validateGenerateRequest({
        theme: "图片很多",
        images: Array.from({ length: 21 }, (_, index) => `image-${index}.png`),
        skill: "marketing",
        mode: "script",
        aspectRatio: "9:16",
        durationSeconds: 30
      }),
    /Images count must be 20 or less/
  );
});

test("generateArtifacts builds storyboard and captions", async () => {
  const request: GenerateRequest = {
    theme: "AI 智能体介绍",
    skill: "knowledge",
    mode: "script",
    aspectRatio: "16:9",
    durationSeconds: 30
  };
  const providers: ProviderSelection = {};
  const skill = autoSelectSkill({ theme: request.theme });
  const artifacts = await generateArtifacts({ request, providers, skill });
  assert.equal(artifacts.storyboard.aspectRatio, "16:9");
  assert.equal(artifacts.storyboard.shots.length, 5);
  assert.equal(artifacts.captions.length, artifacts.storyboard.shots.length);
});

test("generateArtifacts normalizes remote script durations to requested total", async () => {
  const request: GenerateRequest = {
    theme: "AI 智能体介绍",
    skill: "knowledge",
    mode: "script",
    aspectRatio: "16:9",
    durationSeconds: 30
  };
  const providers: ProviderSelection = {
    text: {
      id: "mock-text",
      capability: "text",
      isRemote: false,
      async test() {
        return { providerId: "mock-text", capability: "text", ok: true, message: "ok", liveChecked: false };
      },
      async generateText() {
        return JSON.stringify({
          title: "",
          summary: "",
          openingHook: "",
          voiceover: "",
          scenes: [
            { id: "", heading: "", narration: "A", visualPrompt: "", shotType: "", durationSeconds: 100, caption: "" },
            { id: "scene-2", heading: "B", narration: "B", visualPrompt: "B", shotType: "wide", durationSeconds: 50, caption: "B" }
          ],
          bgmStyle: "",
          cta: "",
          hashtags: []
        });
      }
    }
  };
  const skill = autoSelectSkill({ theme: request.theme });
  const artifacts = await generateArtifacts({ request, providers, skill });
  const totalDuration = artifacts.storyboard.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  assert.equal(totalDuration, 30);
  assert.equal(artifacts.storyboard.shots[0]?.title, "镜头 1");
  assert.equal(artifacts.script.title.length > 0, true);
  assert.equal(artifacts.storyboard.shots.length, 2);
});

test("cleanupExpiredProjects rejects non-positive maxAgeDays", () => {
  assert.throws(() => cleanupExpiredProjects("/tmp", 0), /positive number/);
  assert.throws(() => cleanupExpiredProjects("/tmp", -1), /positive number/);
});

test("toSrt generates valid SRT output", () => {
  const captions = [
    { startSeconds: 0, endSeconds: 5, text: "Hello" },
    { startSeconds: 5, endSeconds: 10.5, text: "World" }
  ];
  const srt = toSrt(captions);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:05,000\nHello/);
  assert.match(srt, /2\n00:00:05,000 --> 00:00:10,500\nWorld/);
});

test("toScriptMarkdown includes title and scenes", () => {
  const script = {
    title: "Test Title",
    summary: "A summary",
    openingHook: "Hook",
    voiceover: "Full voiceover",
    scenes: [
      {
        id: "scene-1",
        heading: "Opening",
        narration: "Narration text",
        visualPrompt: "Visual",
        shotType: "medium",
        durationSeconds: 5,
        caption: "Caption"
      }
    ],
    bgmStyle: "upbeat",
    cta: "Subscribe",
    hashtags: ["test"]
  };
  const md = toScriptMarkdown(script);
  assert.match(md, /# Test Title/);
  assert.match(md, /## 镜头 1: Opening/);
  assert.match(md, /#test/);
});

test("createProjectId generates unique slugified id", () => {
  const id1 = createProjectId("夏季防晒");
  const id2 = createProjectId("夏季防晒");
  assert.ok(id1.includes("夏季防晒"));
  assert.notEqual(id1, id2);
});

test("validateConfig detects missing profile references", () => {
  const warnings = validateConfig({
    defaults: { profile: "missing", aspectRatio: "9:16", durationSeconds: 30, language: "zh-CN", platform: "douyin", projectsDir: "project" },
    providers: {},
    profiles: { broken: { text: "nonexistent" } }
  });
  assert.ok(warnings.some((w) => w.includes("missing")));
  assert.ok(warnings.some((w) => w.includes("nonexistent")));
});

test("validateConfig detects incomplete openai-compatible provider", () => {
  const warnings = validateConfig({
    defaults: { profile: "default", aspectRatio: "9:16", durationSeconds: 30, language: "zh-CN", platform: "douyin", projectsDir: "project" },
    providers: { bad: { type: "openai-compatible", capability: "text", enabled: true } },
    profiles: { default: { text: "bad" } }
  });
  assert.ok(warnings.some((w) => w.includes("baseURL")));
  assert.ok(warnings.some((w) => w.includes("model")));
  assert.ok(warnings.some((w) => w.includes("apiKeyEnv")));
});

test("resolveProfileId honors explicit profile before key auto detection", () => {
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const config = {
      defaults: { profile: "default", aspectRatio: "9:16", durationSeconds: 30, language: "zh-CN", platform: "douyin", projectsDir: "project" },
      providers: {
        "local-rule-text": { type: "local-rule-text", capability: "text" as const, enabled: true },
        "openai-text": { type: "openai-compatible", capability: "text" as const, enabled: true, apiKeyEnv: "OPENAI_API_KEY" }
      },
      profiles: {
        default: { text: "local-rule-text" },
        openai: { text: "openai-text" },
        custom: { text: "local-rule-text" }
      }
    };
    assert.equal(resolveProfileId(config, "custom"), "custom");
    assert.equal(resolveProfileId(config), "openai");
  } finally {
    restoreEnv("OPENAI_API_KEY", originalOpenAIKey);
  }
});

test("loadConfig applies model environment overrides", () => {
  const originalArkModel = process.env.ARK_MODEL;
  process.env.ARK_MODEL = "doubao-seed-2-0-pro-260215";
  try {
    const root = mkdtempSync(join(tmpdir(), "aivideo-config-"));
    const config = loadConfig(root);
    assert.equal(config.providers["volcengine-text"]?.model, "doubao-seed-2-0-pro-260215");
  } finally {
    restoreEnv("ARK_MODEL", originalArkModel);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test("cleanupExpiredProjects removes only expired directories", () => {
  const root = mkdtempSync(join(tmpdir(), "aivideo-projects-"));
  const expired = join(root, "expired-project");
  const fresh = join(root, "fresh-project");
  mkdirSync(expired);
  mkdirSync(fresh);

  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  utimesSync(expired, tenDaysAgo, tenDaysAgo);

  const removed = cleanupExpiredProjects(root, 7);
  assert.equal(removed.length, 1);
  assert.match(removed[0] ?? "", /expired-project/);
});

async function buildVideoArtifacts() {
  const request: GenerateRequest = {
    theme: "AI 智能体介绍",
    skill: "knowledge",
    mode: "video",
    aspectRatio: "16:9",
    durationSeconds: 20
  };
  const skill = autoSelectSkill({ theme: request.theme });
  return generateArtifacts({ request, providers: {}, skill });
}

function videoProvider(returnedPath: "given" | ((input: string) => string)): VideoModelProvider {
  return {
    id: "mock-video",
    capability: "video",
    isRemote: true,
    async test() {
      return { providerId: "mock-video", capability: "video", ok: true, message: "ok", liveChecked: false };
    },
    async generateVideo(request) {
      const finalPath = returnedPath === "given" ? request.outputPath : returnedPath(request.outputPath);
      mkdirSync(join(finalPath, ".."), { recursive: true });
      writeFileSync(finalPath, "fake video bytes");
      return { outputPath: finalPath };
    }
  };
}

test("prepareGeneratedAssets accepts video paths inside the project", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-prep-"));
  const artifacts = await buildVideoArtifacts();
  const providers: ProviderSelection = { video: videoProvider("given") };
  const result = await prepareGeneratedAssets({ projectDir, artifacts, providers });
  assert.equal(result.attempted, artifacts.storyboard.shots.length);
  assert.equal(result.videoSucceeded, artifacts.storyboard.shots.length);
  const first = artifacts.renderManifest.shots[0]!;
  assert.equal(first.assetKind, "video");
  assert.match(String(first.assetPath), /^assets\/.+\.mp4$/);
});

test("prepareGeneratedAssets rejects video paths outside the project dir", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-prep-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "aivideo-outside-"));
  const artifacts = await buildVideoArtifacts();
  // Provider reports a path outside the project: the shot must degrade to its
  // title-card fallback instead of referencing an external file.
  const providers: ProviderSelection = {
    video: videoProvider((given) => join(outsideDir, given.split("/").pop() ?? "shot.mp4"))
  };
  const result = await prepareGeneratedAssets({ projectDir, artifacts, providers });
  assert.equal(result.videoSucceeded, 0);
  assert.equal(result.failed, artifacts.storyboard.shots.length);
  for (const shot of artifacts.renderManifest.shots) {
    assert.equal(shot.assetKind, "generated-card");
    const assetPath = String(shot.assetPath ?? "");
    assert.equal(assetPath.startsWith(outsideDir), false);
  }
});

test("prepareGeneratedAssets reuses assets already on disk without calling the provider", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-resume-"));
  const artifacts = await buildVideoArtifacts();
  const shots = artifacts.storyboard.shots;
  assert.ok(shots.length >= 2);
  // Simulate a previous run that produced the first shot's video and nothing else.
  mkdirSync(join(projectDir, "assets"), { recursive: true });
  writeFileSync(join(projectDir, "assets", `${shots[0]!.id}.mp4`), "bytes from previous run");
  // Empty files must not count as reusable (a crashed run can truncate).
  writeFileSync(join(projectDir, "assets", `${shots[1]!.id}.mp4`), "");

  const providers: ProviderSelection = {
    video: {
      id: "billing-video",
      capability: "video",
      isRemote: true,
      async test() {
        return { providerId: "billing-video", capability: "video", ok: true, message: "ok", liveChecked: false };
      },
      async generateVideo(request) {
        // The reused shot must never reach the provider; every other shot may.
        assert.equal(request.outputPath.endsWith(`${shots[0]!.id}.mp4`), false);
        writeFileSync(request.outputPath, "fresh bytes");
        return { outputPath: request.outputPath };
      }
    }
  };
  const result = await prepareGeneratedAssets({ projectDir, artifacts, providers });
  assert.equal(result.attempted, shots.length);
  assert.equal(result.reused, 1);
  assert.equal(result.succeeded, shots.length);
  // videoSucceeded counts fresh (billed) generations only; the reused shot is
  // tracked separately in result.reused.
  assert.equal(result.videoSucceeded, shots.length - result.reused);
  assert.equal(result.failed, 0);
  assert.equal(artifacts.renderManifest.shots[0]!.assetKind, "video");
  assert.match(String(artifacts.renderManifest.shots[0]!.assetPath), /^assets\/.+\.mp4$/);
});

test("prepareGeneratedAssets does not trust manifest-recorded paths outside the project", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-resume-edge-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "aivideo-outside-"));
  const artifacts = await buildVideoArtifacts();
  const first = artifacts.renderManifest.shots[0]!;
  // A tampered/stale manifest records an absolute path outside the project:
  // the reuse check must reject it and regenerate (inside the project).
  writeFileSync(join(outsideDir, `${artifacts.storyboard.shots[0]!.id}.mp4`), "outside bytes");
  first.assetKind = "video";
  first.assetPath = join(outsideDir, `${artifacts.storyboard.shots[0]!.id}.mp4`);
  const providers: ProviderSelection = { video: videoProvider("given") };
  const result = await prepareGeneratedAssets({ projectDir, artifacts, providers });
  assert.equal(result.reused, 0);
  for (const shot of artifacts.renderManifest.shots) {
    assert.equal(shot.assetKind, "video");
    assert.equal(String(shot.assetPath ?? "").startsWith(outsideDir), false);
  }
});

async function buildReferenceArtifacts(imagePaths: string[]) {
  const request: GenerateRequest = {
    theme: "AI 智能体介绍",
    images: imagePaths,
    skill: "knowledge",
    mode: "video",
    aspectRatio: "16:9",
    durationSeconds: 20
  };
  const skill = autoSelectSkill({ theme: request.theme });
  return generateArtifacts({ request, providers: {}, skill });
}

/** A user-supplied image directory: reference files live OUTSIDE the project. */
function writeUserImages(count: number): string[] {
  const dir = mkdtempSync(join(tmpdir(), "aivideo-userimgs-"));
  return Array.from({ length: count }, (_, index) => {
    const path = join(dir, `photo-${index}.png`);
    writeFileSync(path, `fake image bytes ${index}`);
    return path;
  });
}

test("shots mix per-shot: first N animate the user images, the rest are generated", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-ref-"));
  const inputImages = writeUserImages(2);
  const artifacts = await buildReferenceArtifacts(inputImages);
  const shots = artifacts.storyboard.shots;
  assert.ok(shots.length >= 3);
  // Each user image is spent on exactly one shot; once they run out, the
  // remaining shots fall back to generated assets.
  shots.forEach((shot, index) => {
    assert.equal(shot.assetSource, index < inputImages.length ? "reference_image" : "generated_image");
  });

  const capturedRefs = new Map<string, string[] | undefined>();
  const providers: ProviderSelection = {
    video: {
      id: "capture-video",
      capability: "video",
      isRemote: true,
      async test() {
        return { providerId: "capture-video", capability: "video", ok: true, message: "ok", liveChecked: false };
      },
      async generateVideo(request) {
        const shot = shots.find((candidate) => request.outputPath.endsWith(`${candidate.id}.mp4`));
        capturedRefs.set(shot?.id ?? "unknown", request.referenceImagePaths);
        mkdirSync(join(request.outputPath, ".."), { recursive: true });
        writeFileSync(request.outputPath, "fake video bytes");
        return { outputPath: request.outputPath };
      }
    }
  };
  const result = await prepareGeneratedAssets({ projectDir, artifacts, providers });
  assert.equal(result.videoSucceeded, shots.length);
  assert.equal(result.reused, 0);
  assert.equal(result.failed, 0);
  // Reference shot i animates inputImages[i]; generated shots get no first frame.
  shots.forEach((shot, index) => {
    assert.deepEqual(
      capturedRefs.get(shot.id),
      index < inputImages.length ? [inputImages[index]] : undefined
    );
  });
  for (const shot of artifacts.renderManifest.shots) {
    assert.equal(shot.assetKind, "video");
    assert.match(String(shot.assetPath), /^assets\/.+\.mp4$/);
  }
});

test("a reference shot that fails to animate keeps its free user image (never billed for an image)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-refkeep-"));
  const inputImages = writeUserImages(1);
  const artifacts = await buildReferenceArtifacts(inputImages);
  const shots = artifacts.storyboard.shots;
  const referenceShots = shots.filter((shot) => shot.assetSource === "reference_image");
  const generatedCount = shots.length - referenceShots.length;
  assert.ok(generatedCount > 0);

  const imageCalls: string[] = [];
  const providers: ProviderSelection = {
    video: {
      id: "failing-video",
      capability: "video",
      isRemote: true,
      async test() {
        return { providerId: "failing-video", capability: "video", ok: true, message: "ok", liveChecked: false };
      },
      async generateVideo() {
        throw new Error("provider unavailable");
      }
    },
    image: {
      id: "fallback-image",
      capability: "image",
      isRemote: true,
      async test() {
        return { providerId: "fallback-image", capability: "image", ok: true, message: "ok", liveChecked: false };
      },
      async generateImage(request) {
        imageCalls.push(request.outputPath);
        mkdirSync(join(request.outputPath, ".."), { recursive: true });
        writeFileSync(request.outputPath, "fake image bytes");
        return { outputPath: request.outputPath };
      }
    }
  };
  const result = await prepareGeneratedAssets({ projectDir, artifacts, providers });
  // The kept user image counts as reused (free), not as a fresh paid generation.
  assert.equal(result.failed, 0);
  assert.equal(result.reused, referenceShots.length);
  assert.equal(result.succeeded, shots.length);
  assert.equal(result.videoSucceeded, 0);
  // Only the generated shots pay for images — the reference shot never does.
  assert.equal(result.imageSucceeded, generatedCount);
  for (const reference of referenceShots) {
    assert.equal(
      imageCalls.some((path) => path.endsWith(`${reference.id}.png`)),
      false
    );
  }
  // The reference shot's manifest entry still points at the user's own image.
  for (const reference of referenceShots) {
    const manifestShot = artifacts.renderManifest.shots.find((entry) => entry.shotId === reference.id)!;
    assert.equal(manifestShot.assetKind, "image");
    assert.equal(manifestShot.assetPath, inputImages[shots.indexOf(reference)]);
  }
});

test("a missing user image file is not sent as a reference (plain text-to-video instead)", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-refmissing-"));
  const inputImages = writeUserImages(1);
  const artifacts = await buildReferenceArtifacts(inputImages);
  // Simulate the user deleting their photos between runs.
  writeFileSync(inputImages[0]!, "");
  const shots = artifacts.storyboard.shots;

  const captured: (string[] | undefined)[] = [];
  const providers: ProviderSelection = {
    video: {
      id: "spy-video",
      capability: "video",
      isRemote: true,
      async test() {
        return { providerId: "spy-video", capability: "video", ok: true, message: "ok", liveChecked: false };
      },
      async generateVideo(request) {
        captured.push(request.referenceImagePaths);
        mkdirSync(join(request.outputPath, ".."), { recursive: true });
        writeFileSync(request.outputPath, "fake video bytes");
        return { outputPath: request.outputPath };
      }
    }
  };
  const result = await prepareGeneratedAssets({ projectDir, artifacts, providers });
  assert.equal(result.videoSucceeded, shots.length);
  for (const refs of captured) {
    assert.equal(refs, undefined);
  }
});

test("a reference shot reuses an existing in-project mp4 instead of paying twice", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-refresume-"));
  const inputImages = writeUserImages(1);
  const artifacts = await buildReferenceArtifacts(inputImages);
  const shots = artifacts.storyboard.shots;
  assert.ok(shots.length >= 2);
  mkdirSync(join(projectDir, "assets"), { recursive: true });
  writeFileSync(join(projectDir, "assets", `${shots[0]!.id}.mp4`), "bytes from previous run");

  const providers: ProviderSelection = {
    video: {
      id: "billing-ref-video",
      capability: "video",
      isRemote: true,
      async test() {
        return { providerId: "billing-ref-video", capability: "video", ok: true, message: "ok", liveChecked: false };
      },
      async generateVideo(request) {
        assert.equal(request.outputPath.endsWith(`${shots[0]!.id}.mp4`), false);
        writeFileSync(request.outputPath, "fresh bytes");
        return { outputPath: request.outputPath };
      }
    }
  };
  const result = await prepareGeneratedAssets({ projectDir, artifacts, providers });
  assert.equal(result.reused, 1);
  assert.equal(result.videoSucceeded, shots.length - 1);
  assert.equal(result.succeeded, shots.length);
  assert.equal(artifacts.renderManifest.shots[0]!.assetKind, "video");
  assert.equal(artifacts.renderManifest.shots[0]!.assetPath, `assets/${shots[0]!.id}.mp4`);
});

test("loadAssetArtifacts round-trips a materialized project", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-load-"));
  const request: GenerateRequest = {
    theme: "AI 智能体介绍",
    skill: "knowledge",
    mode: "video",
    aspectRatio: "16:9",
    durationSeconds: 20
  };
  const skill = autoSelectSkill({ theme: request.theme });
  const artifacts = await generateArtifacts({ request, providers: {}, skill });
  materializeProject(projectDir, artifacts);

  const loaded = loadAssetArtifacts(projectDir);
  assert.ok(loaded);
  assert.deepEqual(loaded.storyboard, artifacts.storyboard);
  // JSON round-trip drops the explicit-undefined assetPath keys the in-memory
  // manifest carries for un-generated shots, so compare against the same
  // serialization that lands on disk.
  assert.deepEqual(loaded.renderManifest, JSON.parse(JSON.stringify(artifacts.renderManifest)));
  assert.equal(loaded.brief.aspectRatio, "16:9");

  // A directory without the files is not resumable.
  assert.equal(loadAssetArtifacts(mkdtempSync(join(tmpdir(), "aivideo-empty-"))), null);
});
