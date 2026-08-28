import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, resolveProfileId, validateConfig } from "./config.js";
import { autoSelectSkill } from "./skills.js";
import { GenerateRequest, ProviderSelection, VideoModelProvider } from "./types.js";
import { cleanupExpiredProjects, createProjectId, generateArtifacts, prepareGeneratedAssets, toScriptMarkdown, toSrt, validateGenerateRequest } from "./workflow.js";

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
