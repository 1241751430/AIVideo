import assert from "node:assert/strict";
import test from "node:test";
import { autoSelectSkill } from "./skills.js";
import { GenerateRequest, ProviderSelection } from "./types.js";
import { generateArtifacts, validateGenerateRequest } from "./workflow.js";

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
