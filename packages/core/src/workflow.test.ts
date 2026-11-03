/**
 * @file workflow.test.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description workflow/config/skills 的单元测试：技能自动选择、请求校验、产物生成与归一、SRT/Markdown 输出、过期项目清理，以及 prepareGeneratedAssets 的复用、越界防护、参考图混排等远端资产安全场景。
 * @see https://github.com/1241751430/AIVideo.git
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, resolveProfileId, validateConfig } from "./config.js";
import { MAX_SHOT_REFERENCE_IMAGES } from "./fingerprints.js";
import { autoSelectSkill, getSkillById } from "./skills.js";
import { GenerateRequest, ProviderSelection, VideoModelProvider } from "./types.js";
import { cleanupExpiredProjects, cleanupRenderWorkspace, createProjectId, describeAssetPrepSkip, generateArtifacts, loadAssetArtifacts, materializeProject, prepareGeneratedAssets, toScriptMarkdown, toSrt, validateGenerateRequest } from "./workflow.js";

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

test("generateArtifacts 把技能的平台规则送进脚本提示词", async () => {
  const seen: string[] = [];
  const providers: ProviderSelection = {
    text: {
      id: "mock-text",
      capability: "text",
      isRemote: false,
      async test() {
        return { providerId: "mock-text", capability: "text", ok: true, message: "ok", liveChecked: false };
      },
      async generateText(request) {
        seen.push(request.systemPrompt);
        return JSON.stringify({
          title: "t",
          summary: "s",
          openingHook: "h",
          voiceover: "v",
          scenes: [{ id: "scene-1", heading: "h", narration: "n", visualPrompt: "v", shotType: "medium", durationSeconds: 30, caption: "c" }],
          bgmStyle: "b",
          cta: "c",
          hashtags: []
        });
      }
    }
  };
  const skill = getSkillById("knowledge")!;
  // 该技能为 bilibili 写了规则、没为 tiktok 写：命中的平台要注入，未命中的要退回不带平台段的原提示词。
  await generateArtifacts({
    request: { theme: "知识分享", skill: "knowledge", mode: "script", aspectRatio: "9:16", durationSeconds: 30, platform: "bilibili" },
    providers,
    skill
  });
  await generateArtifacts({
    request: { theme: "知识分享", skill: "knowledge", mode: "script", aspectRatio: "9:16", durationSeconds: 30, platform: "tiktok" },
    providers,
    skill
  });
  assert.match(seen[0] ?? "", /发布平台：bilibili/);
  assert.match(seen[0] ?? "", /平台规则：可以更完整；逻辑递进更强/);
  assert.doesNotMatch(seen[1] ?? "", /平台规则：/);
});

test("本地脚本让平台规则真的改变旁白", async () => {
  const base: GenerateRequest = {
    theme: "夏季防晒喷雾",
    skill: "ecommerce",
    mode: "script",
    aspectRatio: "9:16",
    durationSeconds: 30
  };
  // 直接取技能，不走关键词自动选择——这里要验的是平台差异，不是选技。
  const skill = getSkillById("ecommerce")!;
  const douyin = await generateArtifacts({ request: { ...base, platform: "douyin" }, providers: {}, skill });
  const kuaishou = await generateArtifacts({ request: { ...base, platform: "kuaishou" }, providers: {}, skill });
  const narrations = (artifacts: { script: { scenes: Array<{ narration: string }> } }): string =>
    artifacts.script.scenes.map((scene) => scene.narration).join("\n");
  // 两个平台都在这套技能里有规则，旁白必须能看出区别——否则 platform 依旧只是个标签。
  assert.notEqual(narrations(douyin), narrations(kuaishou));
  assert.match(narrations(kuaishou), /接地气|福利表达更直接/);
  assert.match(narrations(douyin), /突出转化|弱化长解释/);
});

test("cleanupExpiredProjects rejects non-positive maxAgeDays", () => {
  assert.throws(() => cleanupExpiredProjects("/tmp", 0), /positive number/);
  assert.throws(() => cleanupExpiredProjects("/tmp", -1), /positive number/);
});

test("cleanupRenderWorkspace sweeps intermediates but keeps the user's BGM", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-cleanup-"));
  mkdirSync(join(projectDir, "audio", ".segments"), { recursive: true });
  mkdirSync(join(projectDir, "captions"), { recursive: true });
  mkdirSync(join(projectDir, ".render_tmp"), { recursive: true });
  writeFileSync(join(projectDir, "audio", "s1.wav"), "wav");
  writeFileSync(join(projectDir, "audio", "bgm-v2.mp3"), "same-prefix but not the canonical name");
  writeFileSync(join(projectDir, "audio", "bgm.mp3"), "user bgm");
  writeFileSync(join(projectDir, "captions", "captions.srt"), "srt");
  writeFileSync(join(projectDir, ".render_tmp", "clip.mp4"), "tmp");

  cleanupRenderWorkspace(projectDir);

  // 可再生中间产物全部清掉。
  assert.ok(!existsSync(join(projectDir, "audio", "s1.wav")));
  assert.ok(!existsSync(join(projectDir, "audio", ".segments")));
  assert.ok(!existsSync(join(projectDir, "captions")));
  assert.ok(!existsSync(join(projectDir, ".render_tmp")));
  // 只认规范名 `bgm.<ext>`；同前缀的散落文件仍属中间物。
  assert.ok(!existsSync(join(projectDir, "audio", "bgm-v2.mp3")));
  // 用户资产必须原样保留：清理阶段无权删除用户选的背景音乐。
  assert.ok(existsSync(join(projectDir, "audio", "bgm.mp3")), "用户上传的 BGM 不能被清理掉");
  assert.equal(readFileSync(join(projectDir, "audio", "bgm.mp3"), "utf8"), "user bgm");
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

test("toScriptMarkdown 把台词与对白分开标注，用户原话一字不改", () => {
  const md = toScriptMarkdown({
    title: "T",
    summary: "s",
    openingHook: "h",
    voiceover: "v",
    scenes: [
      {
        id: "scene-1",
        heading: "开场",
        narration: "旁白",
        visualPrompt: "v",
        shotType: "medium",
        durationSeconds: 5,
        caption: "c",
        lines: [
          { speaker: "甲", text: "用户给的原话！", src: "user" },
          { text: "模型写的补充对白。", src: "generated" }
        ]
      }
    ],
    bgmStyle: "b",
    cta: "c",
    hashtags: []
  });
  // 用户台词标「台词」，模型写的标「对白」——交付面板上要能一眼看出哪句是自己写的。
  assert.match(md, /- 旁白: 旁白\n- 台词\(甲\): 用户给的原话！/);
  assert.match(md, /- 对白: 模型写的补充对白。/);
});

test("toScriptMarkdown 把镜级与 BGM 的来源声明列成版权清单", () => {
  // script.md 是对外交付物：片子发出去之后，观众与平台有权知道每个画面和曲子的出处，所以它必须落在正文里，
  // 而不是只存在于某个前端悬停提示或私有字段中。
  const md = toScriptMarkdown({
    title: "T",
    summary: "s",
    openingHook: "h",
    voiceover: "v",
    scenes: [
      {
        id: "scene-1",
        heading: "开场",
        narration: "旁白",
        visualPrompt: "v",
        shotType: "medium",
        durationSeconds: 5,
        caption: "c",
        provenance: {
          kind: "stock",
          provider: "pexels",
          license: "CC0-1.0",
          sourceUrl: "https://example.com/photo/1",
          attribution: "Photo by Jane Doe / Pexels",
          retrievedAt: "2026-10-30T00:00:00.000Z"
        }
      },
      // 没有声明的镜头不进清单：留一行全「—」只会让人以为这镜也有来源只是没写。
      {
        id: "scene-2",
        heading: "结尾",
        narration: "旁白 2",
        visualPrompt: "v2",
        shotType: "wide",
        durationSeconds: 5,
        caption: "c2"
      }
    ],
    bgmStyle: "b",
    cta: "c",
    hashtags: [],
    bgmProvenance: { kind: "library", license: "project-asset" }
  });

  assert.match(md, /## 素材与版权清单/);
  assert.match(md, /\| 位置 \| 来源 \| 提供方 \| 许可 \| 出处 \| 署名 \| 获取时间 \|/);
  assert.match(md, /\| 镜头 1（开场） \| 网络素材 \| pexels \| CC0-1\.0 \| https:\/\/example\.com\/photo\/1 \| Photo by Jane Doe \/ Pexels \| 2026-10-30T00:00:00\.000Z \|/);
  assert.match(md, /\| 全片 BGM \| 素材库 \| — \| project-asset \| — \| — \| — \|/);
  assert.doesNotMatch(md, /镜头 2（结尾）/, "没声明来源的镜头不该出现在清单里");
});

test("toScriptMarkdown 转义标题里的竖线，避免版权表被截断", () => {
  // 标题是自由文本（模型生成或用户编辑），里面完全可能有竖线；不转义会把 7 列表格切成一堆错位单元格。
  const md = toScriptMarkdown({
    title: "T",
    summary: "s",
    openingHook: "h",
    voiceover: "v",
    scenes: [
      {
        id: "scene-1",
        heading: "左边 | 右边",
        narration: "n",
        visualPrompt: "v",
        shotType: "medium",
        durationSeconds: 5,
        caption: "c",
        provenance: { kind: "ai_generated", provider: "mock-image" }
      }
    ],
    bgmStyle: "b",
    cta: "c",
    hashtags: []
  });
  assert.match(md, /\| 镜头 1（左边 \\\| 右边） \| AI 生成 \| mock-image \|/);
});

test("toScriptMarkdown 在一条来源声明都没有时不改输出（与升级前逐字节相同）", () => {
  // 兼容性红线：旧项目重新导出 script.md 不能凭空多出一节空表。
  const script = {
    title: "T",
    summary: "s",
    openingHook: "h",
    voiceover: "v",
    scenes: [
      {
        id: "scene-1",
        heading: "开场",
        narration: "n",
        visualPrompt: "v",
        shotType: "medium",
        durationSeconds: 5,
        caption: "c"
      }
    ],
    bgmStyle: "b",
    cta: "c",
    hashtags: ["t"]
  };
  const md = toScriptMarkdown(script);
  assert.doesNotMatch(md, /素材与版权清单/);
  assert.equal(
    md,
    ["# T", "", "## 摘要", "s", "", "## 开头钩子", "h", "", "## 旁白总稿", "v", "", "## 分镜",
      "## 镜头 1: 开场\n- 时长: 5s\n- 旁白: n\n- 字幕: c\n- 提示词: v",
      "", "## BGM", "b", "", "## CTA", "c", "", "## Hashtags", "#t"].join("\n")
  );
});

test("generateArtifacts 把用户台词逐句原样铺进 lines（离线路径一条不丢）", async () => {
  // 台词里的全角冒号、逗号、问号、句号与换行都得原样带出来：这些正是「用户怎么说就怎么用」的边界。
  const dialogue = "第一句：你好，世界！\n第二句别改我。\n第三句？";
  const request: GenerateRequest = {
    theme: "夏季防晒喷雾",
    dialogue,
    skill: "ecommerce",
    mode: "video",
    aspectRatio: "9:16",
    durationSeconds: 30
  };
  const skill = getSkillById("ecommerce")!;
  const artifacts = await generateArtifacts({ request, providers: {}, skill });

  const lines = artifacts.script.scenes.flatMap((scene) => scene.lines ?? []);
  assert.deepEqual(
    lines.map((line) => line.text),
    ["第一句：你好，世界！", "第二句别改我。", "第三句？"],
    "台词必须逐句原样落盘，顺序不变"
  );
  assert.ok(lines.every((line) => line.src === "user"), "用户台词一律标 src=user");
  // brief 同样要带上原文：续跑时脚本阶段只认磁盘上的 brief.json，丢了台词就再也补不回来。
  assert.equal(artifacts.brief.dialogue, dialogue);
});

test("远端模型改写或漏掉用户台词时，落盘的一定是用户原文", async () => {
  const dialogue = "第一句话。第二句话。第三句话。";
  const seenPrompts: string[] = [];
  const providers: ProviderSelection = {
    text: {
      id: "mock-text",
      capability: "text",
      isRemote: false,
      async test() {
        return { providerId: "mock-text", capability: "text", ok: true, message: "ok", liveChecked: false };
      },
      async generateText(request) {
        seenPrompts.push(request.systemPrompt);
        return JSON.stringify({
          title: "t",
          summary: "s",
          openingHook: "h",
          voiceover: "v",
          scenes: [
            {
              id: "scene-1",
              heading: "h1",
              narration: "n1",
              visualPrompt: "v1",
              shotType: "medium",
              durationSeconds: 15,
              caption: "c1",
              // 第二句被模型「润色」了：它不是用户原话，必须被识别出来并换成原文。
              // 第三句被模型标成 generated，但那句本来就是用户说的，要认回来而不是再补一遍。
              lines: [
                { text: "第一句话。", src: "user" },
                { text: "第二句话呢，改写得流利多了。", src: "user" },
                { text: "第三句话。", src: "generated" }
              ]
            },
            {
              id: "scene-2",
              heading: "h2",
              narration: "n2",
              visualPrompt: "v2",
              shotType: "wide",
              durationSeconds: 15,
              caption: "c2"
            }
          ],
          bgmStyle: "b",
          cta: "c",
          hashtags: []
        });
      }
    }
  };

  const artifacts = await generateArtifacts({
    request: { theme: "防晒", dialogue, skill: "ecommerce", mode: "video", aspectRatio: "9:16", durationSeconds: 30 },
    providers,
    skill: getSkillById("ecommerce")!
  });

  // 提示词里必须把「逐字使用」的约束交代清楚，否则模型没有理由照做。
  assert.match(seenPrompts[0] ?? "", /src="user"/);
  assert.match(seenPrompts[0] ?? "", /不许改|不得改动/);

  const texts = artifacts.script.scenes.flatMap((scene) => (scene.lines ?? []).map((line) => line.text));
  // 用集合比而不是排序比：中文句子的字典序与「第几句」无关，排序比只会测到 sort 的实现。
  assert.deepEqual(new Set(texts), new Set(["第一句话。", "第二句话。", "第三句话。"]), "润色版不得出现，漏掉的句子必须补回");
  assert.equal(texts.length, 3, "同一句台词不能既认领又补回、在成片里念两遍");
  const userLines = artifacts.script.scenes.flatMap((scene) => (scene.lines ?? []).filter((line) => line.src === "user"));
  assert.equal(userLines.length, 3, "用户说的每一句都要标成 src=user");
});

test("没有台词时产物与引入台词之前一致（不写 lines、Markdown 不多出行）", async () => {
  const request: GenerateRequest = {
    theme: "AI 智能体介绍",
    skill: "knowledge",
    mode: "script",
    aspectRatio: "16:9",
    durationSeconds: 30
  };
  const artifacts = await generateArtifacts({ request, providers: {}, skill: getSkillById("knowledge")! });

  assert.equal(artifacts.brief.dialogue, undefined);
  assert.ok(
    artifacts.script.scenes.every((scene) => !("lines" in scene)),
    "没有台词就不该出现 lines 字段——空数组落盘会让老产物的形状变样"
  );
  const md = toScriptMarkdown(artifacts.script);
  assert.doesNotMatch(md, /^- (台词|对白)/m);
  assert.match(md, /^## 镜头 1: /m);
});

test("角色外观拼进本镜 visualPrompt：只拼出场且有外观的角色，同一角色只说一次", async () => {
  const seenPrompts: string[] = [];
  const providers: ProviderSelection = {
    text: {
      id: "mock-text",
      capability: "text",
      isRemote: false,
      async test() {
        return { providerId: "mock-text", capability: "text", ok: true, message: "ok", liveChecked: false };
      },
      async generateText(request) {
        seenPrompts.push(request.systemPrompt);
        return JSON.stringify({
          title: "t",
          summary: "s",
          openingHook: "h",
          voiceover: "v",
          roles: [
            { id: "host", name: "主持人", appearance: "短发、深蓝西装、三十岁" },
            // 没声明外观：不该被拼，也不该把角色名硬塞进提示词
            { id: "guest", name: "嘉宾" },
            // 声明了外观但全片没出场：旁白镜不该被塞进一个没露脸的人
            { id: "extra", name: "路人", appearance: "从未出场" }
          ],
          scenes: [
            {
              id: "scene-1",
              heading: "h1",
              narration: "n1",
              visualPrompt: "咖啡店靠窗，暖光",
              shotType: "medium",
              durationSeconds: 15,
              caption: "c1",
              lines: [
                { speaker: "host", text: "第一句", src: "generated" },
                { speaker: "host", text: "第二句", src: "generated" },
                { speaker: "guest", text: "第三句", src: "generated" }
              ]
            },
            {
              id: "scene-2",
              heading: "h2",
              narration: "n2",
              visualPrompt: "街道夜景",
              shotType: "wide",
              durationSeconds: 15,
              caption: "c2"
            }
          ],
          bgmStyle: "b",
          cta: "c",
          hashtags: []
        });
      }
    }
  };

  const artifacts = await generateArtifacts({
    request: { theme: "咖啡店探店", skill: "knowledge", mode: "video", aspectRatio: "9:16", durationSeconds: 30 },
    providers,
    skill: getSkillById("knowledge")!
  });

  const [first, second] = artifacts.script.scenes;
  assert.equal(first!.visualPrompt, "咖啡店靠窗，暖光（人物外观：主持人：短发、深蓝西装、三十岁）");
  assert.equal(
    first!.visualPrompt.split("主持人：").length - 1,
    1,
    "同一角色一镜里说了两句，外观也只描述一次"
  );
  assert.doesNotMatch(first!.visualPrompt, /嘉宾|路人/, "没声明外观或没出场的角色不进提示词");
  assert.equal(second!.visualPrompt, "街道夜景", "旁白镜的提示词逐字节不变");

  // 落点必须让分镜、素材指纹、交付物看到同一份提示词：拼在别处（调用远端前一刻）用户就看不见也改不了。
  assert.equal(artifacts.storyboard.shots[0]!.visualPrompt, first!.visualPrompt);
  assert.match(toScriptMarkdown(artifacts.script), /人物外观：主持人：短发/);

  // 没有台词也照样注入一致性约束：逐镜独立推理下，场景/人物的一致性只能靠每镜写全。
  assert.match(seenPrompts[0] ?? "", /画面一致性是硬约束/);
  assert.doesNotMatch(seenPrompts[0] ?? "", /src="user"/, "没给台词时不得凭空引入对白要求");
});

test("模型的 stock 声明缺出处或许可：整份脚本被拒，绝不降级成「没有来源」的镜头", async (t) => {
  // 「没标出处的素材」比「没素材」危险得多：用户会以为它是自己能随便用的。
  // 所以这种情况不能悄悄把 provenance 丢掉（那样镜头照用、版权信息凭空消失），
  // 也不能继续用这份脚本——整份退回本地脚本，一条声明都不落。
  const warn = t.mock.method(console, "warn");
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
          title: "远端脚本不该被采用",
          summary: "s",
          openingHook: "h",
          voiceover: "v",
          scenes: [
            {
              id: "scene-1",
              heading: "远端镜头",
              narration: "n1",
              visualPrompt: "v1",
              shotType: "medium",
              durationSeconds: 30,
              caption: "c1",
              // 只有 provider，没有 sourceUrl 与 license：这一镜到底能不能用，说不清。
              provenance: { kind: "stock", provider: "pexels" }
            }
          ],
          bgmStyle: "b",
          cta: "c",
          hashtags: []
        });
      }
    }
  };

  const artifacts = await generateArtifacts({
    request: { theme: "AI 智能体介绍", skill: "knowledge", mode: "video", aspectRatio: "16:9", durationSeconds: 30 },
    providers,
    skill: getSkillById("knowledge")!
  });

  assert.equal(warn.mock.callCount(), 1, "不合格的声明必须留下一条可追查的告警");
  const message = String(warn.mock.calls[0]?.arguments[0] ?? "");
  // 定位文案要具体到哪一镜、缺的是哪个字段，否则出了一次就再也不知道是谁的锅。
  assert.match(message, /镜头 1 的素材声明不合法/);
  assert.match(message, /kind="stock" 必须同时给出 sourceUrl 与 license/);

  // 产物必须是本地回退脚本而不是远端那份：标题里的「｜知识口播视频方案」是本地规则拼的。
  assert.equal(artifacts.script.title, "AI 智能体介绍｜知识口播视频方案");
  assert.ok(
    artifacts.script.scenes.every((scene) => !("provenance" in scene)),
    "回退路径不产任何来源声明——凭空补一个 ai_generated 之类同样是在说假话"
  );
  assert.ok(
    artifacts.storyboard.shots.every((shot) => !("provenance" in shot)),
    "storyboard.json 不能带着未声明来源的镜头落盘"
  );
  assert.ok(
    artifacts.renderManifest.shots.every((shot) => !("provenance" in shot)),
    "render-manifest 是对外交付物，更不能出现一条说不清出处的声明"
  );
});

test("模型的 ai_generated 声明缺 provider：同样整份拒绝，不假装「知道是谁生成的」", async (t) => {
  // provider 是「谁生成的」的唯一证据。只写 kind 不写 provider，等于把一份不可追溯的素材
  // 说成「AI 生成」——交付面板上那个标签就成了空头承诺。
  const warn = t.mock.method(console, "warn");
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
          title: "远端脚本不该被采用",
          summary: "s",
          openingHook: "h",
          voiceover: "v",
          scenes: [
            {
              id: "scene-1",
              heading: "远端镜头",
              narration: "n1",
              visualPrompt: "v1",
              shotType: "medium",
              durationSeconds: 30,
              caption: "c1",
              provenance: { kind: "ai_generated" }
            }
          ],
          bgmStyle: "b",
          cta: "c",
          hashtags: []
        });
      }
    }
  };

  const artifacts = await generateArtifacts({
    request: { theme: "AI 智能体介绍", skill: "knowledge", mode: "video", aspectRatio: "16:9", durationSeconds: 30 },
    providers,
    skill: getSkillById("knowledge")!
  });

  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0] ?? ""), /镜头 1 的素材声明不合法/);
  assert.match(String(warn.mock.calls[0]?.arguments[0] ?? ""), /kind="ai_generated" 必须给出 provider/);
  assert.equal(artifacts.script.title, "AI 智能体介绍｜知识口播视频方案");
  assert.ok(artifacts.script.scenes.every((scene) => !("provenance" in scene)));
  assert.ok(artifacts.renderManifest.shots.every((shot) => !("provenance" in shot)));
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：把指定环境变量恢复为之前的值（原值为 undefined 时删除该键）。
 */
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

test("cleanupExpiredProjects 的 skip 回调能否决删除", () => {
  const root = mkdtempSync(join(tmpdir(), "aivideo-projects-skip-"));
  const busy = join(root, "busy-project");
  const idle = join(root, "idle-project");
  mkdirSync(busy);
  mkdirSync(idle);
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  utimesSync(busy, tenDaysAgo, tenDaysAgo);
  utimesSync(idle, tenDaysAgo, tenDaysAgo);

  // 服务端只会把「任务引擎不持有」的项目交给清理；这里只需验证否决权本身生效。
  const seen: string[] = [];
  const removed = cleanupExpiredProjects(root, 7, {
    skip: (_dir, projectId) => {
      seen.push(projectId);
      return projectId === "busy-project";
    }
  });
  assert.deepEqual(seen.sort(), ["busy-project", "idle-project"]);
  assert.deepEqual(removed.map((item) => item.split("/").pop()).sort(), ["idle-project"]);
  assert.equal(existsSync(busy), true);
  assert.equal(existsSync(idle), false);
});

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：构造一个 video 模式请求并生成全部产物，供资产阶段各测试复用。
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：构造 mock 远端视频 Provider，generateVideo 落盘假视频并回传输出路径（"given" 原样返回，函数则改写返回）。
 */
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

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：按给定的用户图片列表生成 video 模式产物（参考镜混排场景）。
 */
async function buildReferenceArtifacts(
  imagePaths: string[],
  providers: ProviderSelection = {},
  durationSeconds = 20
) {
  const request: GenerateRequest = {
    theme: "AI 智能体介绍",
    images: imagePaths,
    skill: "knowledge",
    mode: "video",
    aspectRatio: "16:9",
    durationSeconds
  };
  const skill = autoSelectSkill({ theme: request.theme });
  // Providers default to none on purpose: the honesty rule is that a shot which
  // no provider can illustrate is recorded as a title card. Tests that need the
  // "will actually be generated" assetSource have to say a remote provider
  // exists — generateArtifacts only reads `isRemote`, it never calls the model.
  return generateArtifacts({ request, providers, skill });
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：测试辅助：在临时目录写入 count 张假用户图片，返回其绝对路径列表。
 */
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
  // remaining shots fall back to generated assets. At build time no visual
  // provider is configured, so those shots are honestly recorded as title
  // cards — a title card is a placeholder ("no picture yet"), not a verdict,
  // and the asset stage below is what actually fills them in.
  shots.forEach((shot, index) => {
    assert.equal(shot.assetSource, index < inputImages.length ? "reference_image" : "title_card");
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

test("reordering the storyboard keeps each reference shot on its own user image", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-refreorder-"));
  const inputImages = writeUserImages(2);
  const artifacts = await buildReferenceArtifacts(inputImages);
  const original = [...artifacts.storyboard.shots];
  assert.ok(original.length >= 3);
  // Reversing moves the reference shots to positions that no longer match the
  // images they were built against; the binding must travel with the shot id.
  const reordered = [...original].reverse();
  artifacts.storyboard.shots = reordered;
  const moved = reordered.filter(
    (shot) => shot.assetSource === "reference_image" && shot.inputImageIndex !== reordered.indexOf(shot)
  );
  assert.ok(moved.length > 0, "fixture must actually move a reference shot off its bound position");

  const capturedRefs = new Map<string, string[] | undefined>();
  const providers: ProviderSelection = {
    video: {
      id: "capture-reordered-video",
      capability: "video",
      isRemote: true,
      async test() {
        return { providerId: "capture-reordered-video", capability: "video", ok: true, message: "ok", liveChecked: false };
      },
      async generateVideo(request) {
        const shot = reordered.find((candidate) => request.outputPath.endsWith(`${candidate.id}.mp4`));
        capturedRefs.set(shot?.id ?? "unknown", request.referenceImagePaths);
        mkdirSync(join(request.outputPath, ".."), { recursive: true });
        writeFileSync(request.outputPath, "fake video bytes");
        return { outputPath: request.outputPath };
      }
    }
  };
  const result = await prepareGeneratedAssets({ projectDir, artifacts, providers });
  assert.equal(result.failed, 0);
  for (const shot of reordered) {
    const bound = shot.assetSource === "reference_image" ? shot.inputImageIndex : undefined;
    assert.deepEqual(
      capturedRefs.get(shot.id),
      bound === undefined ? undefined : [inputImages[bound]!],
      `shot ${shot.id} must animate the image bound to it by id`
    );
  }
  // The moved reference shots are proof the lookup is by id, not by position:
  // a positional read would have handed them a different file (or none).
  for (const shot of moved) {
    assert.notEqual(capturedRefs.get(shot.id), undefined);
  }
});

test("a legacy storyboard without inputImageIndex falls back to the shot's position", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-reflegacy-"));
  const inputImages = writeUserImages(2);
  const artifacts = await buildReferenceArtifacts(inputImages);
  // Projects written before the id binding existed never recorded the field;
  // back then reference shots occupied the first N positions, so position is
  // the correct fallback.
  for (const shot of artifacts.storyboard.shots) {
    delete shot.inputImageIndex;
  }

  const capturedRefs = new Map<string, string[] | undefined>();
  const providers: ProviderSelection = {
    video: {
      id: "capture-legacy-video",
      capability: "video",
      isRemote: true,
      async test() {
        return { providerId: "capture-legacy-video", capability: "video", ok: true, message: "ok", liveChecked: false };
      },
      async generateVideo(request) {
        const shot = artifacts.storyboard.shots.find((candidate) => request.outputPath.endsWith(`${candidate.id}.mp4`));
        capturedRefs.set(shot?.id ?? "unknown", request.referenceImagePaths);
        mkdirSync(join(request.outputPath, ".."), { recursive: true });
        writeFileSync(request.outputPath, "fake video bytes");
        return { outputPath: request.outputPath };
      }
    }
  };
  await prepareGeneratedAssets({ projectDir, artifacts, providers });
  artifacts.storyboard.shots.forEach((shot, index) => {
    assert.deepEqual(
      capturedRefs.get(shot.id),
      index < inputImages.length ? [inputImages[index]!] : undefined
    );
  });
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

test("来源声明经落盘与读回后逐字段不变（分镜、清单、脚本三处都在）", async () => {
  // 版权信息最怕「写的时候对、读回来丢了」：素材阶段与重渲都是从磁盘重新读产物的，
  // 只要有一处私吞了 provenance，交付面板上那个角标就会在第一次续跑后消失。
  const stock = {
    kind: "stock",
    provider: "pexels",
    license: "CC0-1.0",
    sourceUrl: "https://example.com/photo/1",
    attribution: "Photo by Jane Doe / Pexels",
    retrievedAt: "2026-10-30T00:00:00.000Z"
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
          title: "带溯源的片子",
          summary: "s",
          openingHook: "h",
          voiceover: "v",
          scenes: [
            {
              id: "scene-1",
              heading: "开场",
              narration: "n1",
              visualPrompt: "v1",
              shotType: "medium",
              durationSeconds: 15,
              caption: "c1",
              provenance: stock
            },
            // 第二镜没有声明：读回来也不能凭空多出一个键，否则「有没有来源」这件事就不可信了。
            {
              id: "scene-2",
              heading: "结尾",
              narration: "n2",
              visualPrompt: "v2",
              shotType: "wide",
              durationSeconds: 15,
              caption: "c2"
            }
          ],
          bgmStyle: "warm",
          cta: "c",
          hashtags: [],
          bgmProvenance: { kind: "library", license: "project-asset" }
        });
      }
    }
  };
  const artifact = await generateArtifacts({
    request: { theme: "溯源自检", skill: "knowledge", mode: "video", aspectRatio: "16:9", durationSeconds: 30 },
    providers,
    skill: getSkillById("knowledge")!
  });
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-provenance-"));
  materializeProject(projectDir, artifact);

  // script.json 是权威来源：全片 BGM 的声明只存在这里，没有别的去处。
  const script = JSON.parse(readFileSync(join(projectDir, "script.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(script.bgmProvenance, { kind: "library", license: "project-asset" });
  const scriptScenes = script.scenes as Array<Record<string, unknown>>;
  assert.deepEqual(scriptScenes[0]?.provenance, stock);
  assert.equal("provenance" in (scriptScenes[1] ?? {}), false);

  const loaded = loadAssetArtifacts(projectDir);
  assert.ok(loaded);
  assert.deepEqual(loaded.storyboard.shots[0]?.provenance, stock, "分镜是镜头墙与续跑的口径，声明不能丢");
  assert.equal("provenance" in (loaded.storyboard.shots[1] ?? {}), false);
  // 清单走的是 input/state 分节格式，读回要跨过 flattenRenderManifest 这一层：
  // 这正是「重排镜头后声明是否还在」的关键路径。
  assert.deepEqual(loaded.renderManifest.shots[0]?.provenance, stock, "清单里的声明要在 flatten 后仍然完整");
  assert.equal("provenance" in (loaded.renderManifest.shots[1] ?? {}), false);
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

test("generated shots are drawn from the user's photos, capped at the per-shot limit", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-refgen-"));
  // Five photos against a six-shot script: the sixth shot has no photo of its
  // own, which is exactly the shot that used to be a blind text-to-image roll.
  const inputImages = writeUserImages(5);
  const artifacts = await buildReferenceArtifacts(inputImages, {}, 60);
  const shots = artifacts.storyboard.shots;
  const generatedShots = shots.filter((shot) => shot.assetSource !== "reference_image");
  assert.equal(generatedShots.length, 1, "夹具必须恰好留下一个待生成镜头");

  const captured = new Map<string, string[] | undefined>();
  const providers: ProviderSelection = {
    image: {
      id: "capture-image",
      capability: "image",
      isRemote: true,
      async test() {
        return { providerId: "capture-image", capability: "image", ok: true, message: "ok", liveChecked: false };
      },
      async generateImage(request) {
        const shot = shots.find((candidate) => request.outputPath.endsWith(`${candidate.id}.png`));
        captured.set(shot?.id ?? "unknown", request.referenceImages);
        mkdirSync(join(request.outputPath, ".."), { recursive: true });
        writeFileSync(request.outputPath, "fake image bytes");
        return { outputPath: request.outputPath };
      }
    }
  };
  const result = await prepareGeneratedAssets({ projectDir, artifacts, providers });
  assert.equal(result.imageSucceeded, generatedShots.length);
  // 五张照片全部作为参考图下发，但被单镜上限截断：这是 base64 请求体的体积闸。
  assert.deepEqual(
    captured.get(generatedShots[0]!.id),
    inputImages.slice(0, MAX_SHOT_REFERENCE_IMAGES)
  );
  // 参考镜的首帧就是用户那张图，不该再花一次图片调用去「画」它。
  assert.equal(captured.size, generatedShots.length);
});

test("a deleted user photo drops out of the reference set before the call is made", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-refgenmissing-"));
  const inputImages = writeUserImages(5);
  const artifacts = await buildReferenceArtifacts(inputImages, {}, 60);
  const shots = artifacts.storyboard.shots;
  const generatedShot = shots.find((shot) => shot.assetSource !== "reference_image");
  assert.ok(generatedShot);
  // 用户在两轮之间删掉了自己的照片：空文件会被提供者当成损坏图整单拒绝，
  // 所以它必须在请求组装前就被剔除，剩下的照片照常下发。
  writeFileSync(inputImages[1]!, "");

  let capturedRefs: string[] | undefined;
  const providers: ProviderSelection = {
    image: {
      id: "capture-image",
      capability: "image",
      isRemote: true,
      async test() {
        return { providerId: "capture-image", capability: "image", ok: true, message: "ok", liveChecked: false };
      },
      async generateImage(request) {
        capturedRefs = request.referenceImages;
        mkdirSync(join(request.outputPath, ".."), { recursive: true });
        writeFileSync(request.outputPath, "fake image bytes");
        return { outputPath: request.outputPath };
      }
    }
  };
  await prepareGeneratedAssets({ projectDir, artifacts, providers });
  // 被删掉的那张不在列表里；上限是在剔除之后才截断，所以剩下的四张会全部下发。
  assert.deepEqual(capturedRefs, [
    inputImages[0]!,
    inputImages[2]!,
    inputImages[3]!,
    inputImages[4]!
  ]);
});

test("a reference_image video provider gets the whole photo set for generated shots", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-refmode-"));
  const inputImages = writeUserImages(2);
  const artifacts = await buildReferenceArtifacts(inputImages);
  const shots = artifacts.storyboard.shots;
  const generatedShots = shots.filter((shot) => shot.assetSource === "title_card");
  assert.ok(generatedShots.length > 0);

  const captured = new Map<string, string[] | undefined>();
  const providers: ProviderSelection = {
    video: {
      id: "reference-video",
      capability: "video",
      isRemote: true,
      // 2.5 系列才有的能力：这里的图是「参考」，不是首尾帧——否则第二张会变成镜尾硬切。
      referenceImageMode: "reference_image",
      async test() {
        return { providerId: "reference-video", capability: "video", ok: true, message: "ok", liveChecked: false };
      },
      async generateVideo(request) {
        const shot = shots.find((candidate) => request.outputPath.endsWith(`${candidate.id}.mp4`));
        captured.set(shot?.id ?? "unknown", request.referenceImagePaths);
        mkdirSync(join(request.outputPath, ".."), { recursive: true });
        writeFileSync(request.outputPath, "fake video bytes");
        return { outputPath: request.outputPath };
      }
    }
  };
  const result = await prepareGeneratedAssets({ projectDir, artifacts, providers });
  assert.equal(result.videoSucceeded, shots.length);
  for (const shot of shots) {
    // 参考镜只动画自己绑定那一张；生成镜拿到整组照片——同一部片子里角色与场景因此长得像。
    assert.deepEqual(
      captured.get(shot.id),
      shot.assetSource === "reference_image" ? [inputImages[shot.inputImageIndex ?? 0]!] : inputImages
    );
  }
});

test("a first_frame video provider never turns the second photo into a closing frame", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-firstframe-"));
  const inputImages = writeUserImages(2);
  const artifacts = await buildReferenceArtifacts(inputImages);
  const shots = artifacts.storyboard.shots;
  const generatedShots = shots.filter((shot) => shot.assetSource === "title_card");
  assert.ok(generatedShots.length > 0);

  const captured = new Map<string, string[] | undefined>();
  const providers: ProviderSelection = {
    video: {
      id: "first-frame-video",
      capability: "video",
      isRemote: true,
      // 不声明 referenceImageMode 即缺省 first_frame：这正是 1.0 pro 的能力边界。
      async test() {
        return { providerId: "first-frame-video", capability: "video", ok: true, message: "ok", liveChecked: false };
      },
      async generateVideo(request) {
        const shot = shots.find((candidate) => request.outputPath.endsWith(`${candidate.id}.mp4`));
        captured.set(shot?.id ?? "unknown", request.referenceImagePaths);
        mkdirSync(join(request.outputPath, ".."), { recursive: true });
        writeFileSync(request.outputPath, "fake video bytes");
        return { outputPath: request.outputPath };
      }
    } satisfies VideoModelProvider
  };
  await prepareGeneratedAssets({ projectDir, artifacts, providers });
  for (const shot of generatedShots) {
    // 给一张就会被当成首帧、给两张第二张就成尾帧：宁可不给，也不要镜尾硬切到别人的照片。
    assert.equal(captured.get(shot.id), undefined);
  }
});

test("describeAssetPrepSkip explains every zero-output cause and never stays silent", () => {
  assert.match(describeAssetPrepSkip("no-remote-provider"), /未配置图片\/视频模型/);
  assert.match(describeAssetPrepSkip("all-shots-bound-to-reference"), /参考图/);
  assert.match(describeAssetPrepSkip("no-shots"), /分镜为空/);
  // 三种原因各给一句不同的话：如果哪两条撞了，用户仍旧分不清到底卡在哪。
  const messages = new Set([
    describeAssetPrepSkip("no-remote-provider"),
    describeAssetPrepSkip("all-shots-bound-to-reference"),
    describeAssetPrepSkip("no-shots")
  ]);
  assert.equal(messages.size, 3);
  // 将来新加了早退分支却忘了标注 skippedReason 时，兜底那句也必须说人话而不是空串。
  assert.ok(describeAssetPrepSkip(undefined).trim().length > 0);
  assert.notEqual(describeAssetPrepSkip(undefined), describeAssetPrepSkip("no-remote-provider"));
});
