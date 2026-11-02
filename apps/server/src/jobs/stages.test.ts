/**
 * @file stages.test.ts
 * @author zhangbaohong
 * @date 2026-10-30
 * @description defaultStages.runAudio 末尾的 BGM 解析测试：其余用例一律走 testkit 的 noopStages，
 * 这条「旁白之后顺手把 BGM 落到 audio/bgm.<ext>」的路径此前完全没有覆盖。
 * 覆盖五条分支：项目自带曲子优先（且不再向 provider 要曲）、真实曲库按 bgmStyle 取曲、
 * provider 回显路径却不产文件（noop-music 的形态）、provider 抛错、根本没配音乐来源。
 * 曲库那条刻意用真的 createProviderSelection + 真文件，端到端验证「按 bgmStyle 取曲并保留素材扩展名」。
 * 另有三条覆盖 BGM 来源声明（script.bgmProvenance）的落盘：首次拿到曲子写入、本次没拿到且原有则删除、
 * 本次没拿到且原本也没有则逐字节不写——「只增不减」会让交付面板继续宣称一首已经被换掉的曲子。
 * 短曲告警不断言：它依赖 ffprobe，没装的机器上 probeAudioDuration 恒为 null，断言会把环境写成前置条件。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderSelection } from "@aivideo/providers";
import type { AppConfig, MusicProvider, ProviderHealth, ProviderSelection } from "@aivideo/core";
import { defaultStages } from "./stages.js";
import type { StageContext } from "./stages.js";
import { makeConfig } from "../testkit.js";
import type { Job } from "../types.js";

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：手工构造一段合法 WAV（PCM 16bit 单声道 8kHz，指定时长，内容为静音），供曲库与自带曲子落盘。
 * @param seconds 时长秒数
 * @returns 完整的 WAV 字节
 */
function makeWav(seconds = 0.5): Buffer {
  const sampleRate = 8000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataSize = Math.round(sampleRate * seconds) * channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：造一份最小可用的 script.json 内容（`loadScriptPackage` 只要求 scenes 是数组，其余字段照实给）。
 * 刻意不给 bgmProvenance：初始状态就是「脚本还没登记曲子来源」，由 audio 阶段去写。
 * @param bgmStyle BGM 风格（与 render-manifest 保持一致，真实项目里两者同源）
 * @returns 脚本包对象
 */
function makeScript(bgmStyle: string): Record<string, unknown> {
  return {
    title: "测试片",
    summary: "一段用于测试的摘要",
    openingHook: "开场钩子",
    voiceover: "旁白总稿",
    scenes: [
      {
        id: "shot-1",
        heading: "开场",
        narration: "第一句旁白",
        visualPrompt: "空镜",
        shotType: "wide",
        durationSeconds: 10,
        caption: "第一句旁白"
      }
    ],
    bgmStyle,
    cta: "关注我",
    hashtags: []
  };
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：搭一个能被 loadAssetArtifacts 认下的最小项目目录：brief/storyboard/render-manifest 三件套齐全。
 * render-manifest 用老格式（顶层直接是 shots 数组）——归一化会原样透传，写起来最短。
 * script.json 也一并落盘（真实项目里它一定有，BGM 来源声明就写在它里面）；
 * 传 `null` 可以模拟「升级前生成、没有 script.json 的旧项目」。
 * @param filmSeconds 成片时长（秒），进 render-manifest
 * @param bgmStyle BGM 风格，进 render-manifest
 * @param script 脚本包内容；`null` 表示不写 script.json
 * @returns 项目目录绝对路径
 */
function makeProjectDir(
  filmSeconds = 10,
  bgmStyle = "warm ambient piano",
  script: Record<string, unknown> | null = makeScript(bgmStyle)
): string {
  const projectDir = mkdtempSync(join(tmpdir(), "aivideo-stage-"));
  writeFileSync(join(projectDir, "brief.json"), JSON.stringify({ inputImages: [], language: "zh-CN" }));
  if (script) {
    writeFileSync(join(projectDir, "script.json"), JSON.stringify(script));
  }
  writeFileSync(
    join(projectDir, "storyboard.json"),
    JSON.stringify({
      aspectRatio: "9:16",
      durationSeconds: filmSeconds,
      shots: [
        {
          id: "shot-1",
          title: "开场",
          narration: "第一句旁白",
          caption: "第一句旁白",
          visualPrompt: "空镜",
          shotType: "wide",
          durationSeconds: filmSeconds,
          transition: "fade",
          assetSource: "title_card"
        }
      ]
    })
  );
  writeFileSync(
    join(projectDir, "render-manifest.json"),
    JSON.stringify({
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      durationSeconds: filmSeconds,
      bgmStyle,
      outputFile: "final.mp4",
      captionsFile: "captions/captions.srt",
      shots: [
        {
          shotId: "shot-1",
          title: "开场",
          durationSeconds: filmSeconds,
          assetKind: "generated-card",
          overlayText: "",
          caption: "第一句旁白",
          visualPrompt: "空镜"
        }
      ]
    })
  );
  return projectDir;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：构造最小任务实体（runAudio 只读 id 与 request.providerProfile，其余字段仅需占位）。
 * @returns 任务实体
 */
function makeJob(): Job {
  return {
    id: "stage-test",
    projectId: "stage-test",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    execMode: "auto",
    phase: "running",
    request: {
      theme: "测试",
      generationMode: "video",
      skill: "auto",
      aspectRatio: "9:16",
      durationSeconds: 10,
      language: "zh-CN",
      platform: "douyin"
    }
  };
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：跑一遍真实的 runAudio，把阶段日志收下来供断言；不装语音提供者，旁白部分自然跳过。
 * @param projectDir 项目目录
 * @param providers 提供者集合（只关心其中的 music）
 * @returns 阶段日志行
 */
async function runAudioStage(projectDir: string, providers: ProviderSelection): Promise<string[]> {
  const logs: string[] = [];
  const ctx: StageContext = {
    deps: {
      cwd: projectDir,
      projectsRoot: projectDir,
      config: makeConfig(),
      providersFor: () => providers
    },
    job: makeJob(),
    projectDir,
    log: (message) => logs.push(message),
    signal: new AbortController().signal
  };
  await defaultStages.runAudio(ctx);
  return logs;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：造一个假的音乐提供者：记录被调用次数，行为由 synthesize 决定（产文件 / 只回显路径 / 直接抛错）。
 * @param synthesize 合成行为
 * @returns 带调用计数的假提供者
 */
function fakeMusic(synthesize: (request: { outputPath: string; style?: string }) => Promise<{ outputPath: string } | null>) {
  const calls: Array<{ outputPath: string; style?: string }> = [];
  const provider: MusicProvider = {
    id: "fake-music",
    capability: "music",
    isRemote: false,
    async test(): Promise<ProviderHealth> {
      return { providerId: "fake-music", capability: "music", ok: true, message: "fake", liveChecked: false };
    },
    async synthesizeMusic(request) {
      calls.push({ outputPath: request.outputPath, style: request.style });
      return synthesize(request);
    }
  };
  return { provider, calls };
}

test("项目自带 BGM：直接用它，不再向 music provider 要曲", async () => {
  const projectDir = makeProjectDir();
  try {
    mkdirSync(join(projectDir, "audio"), { recursive: true });
    const own = makeWav(1);
    writeFileSync(join(projectDir, "audio", "bgm.wav"), own);

    // 一被调用就炸：用户已经给了曲子，再去要一份是白花钱，也说明不了「用户的选择优先」。
    const { provider, calls } = fakeMusic(async () => {
      throw new Error("不该被调用");
    });
    const logs = await runAudioStage(projectDir, { music: provider });

    assert.deepEqual(calls, [], "用户自带 BGM 时不得调用音乐提供者");
    assert.ok(
      logs.some((line) => line.includes("使用项目自带背景音乐") && line.includes("audio/bgm.wav")),
      `日志要说明用的是项目自带曲子，实际：${logs.join(" | ")}`
    );
    assert.ok(!logs.some((line) => line.includes("无 BGM")), "有曲子时不能同时说没有");
    // 自带曲子必须原样留着：任何「顺手复制」都可能把用户的原文件改名或覆盖。
    assert.deepEqual(readFileSync(join(projectDir, "audio", "bgm.wav")), own);
    // 来源声明也要落盘：用户上传的曲子记 user_uploaded，许可缺省 user-provided——
    // 写成 ai_generated 会让这片子在对外交付时宣称「配乐由 AI 生成」，与事实相反。
    const script = JSON.parse(readFileSync(join(projectDir, "script.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(script.bgmProvenance, { kind: "user_uploaded", license: "user-provided" });
    assert.match(readFileSync(join(projectDir, "script.md"), "utf8"), /\| 全片 BGM \| 用户上传 \|/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("按 bgmStyle 从曲库取曲：真实 provider 落盘并保留素材扩展名", async () => {
  const projectDir = makeProjectDir(10, "warm ambient piano");
  const libraryDir = mkdtempSync(join(tmpdir(), "aivideo-library-"));
  try {
    // 只放一首能命中的和一首明显不相干的：挑错了就会被断言抓到。
    writeFileSync(join(libraryDir, "warm-ambient.wav"), makeWav(1));
    writeFileSync(join(libraryDir, "epic-trailer.mp3"), makeWav(1));

    const config = makeConfig() as AppConfig;
    config.providers = {
      "local-library-music": {
        type: "local-library-music",
        capability: "music",
        enabled: true,
        baseURL: libraryDir
      }
    };
    config.profiles = { default: { music: "local-library-music" } };
    const providers = createProviderSelection(config);
    assert.ok(providers.music, "配置里的本地曲库必须能被装配出来");

    const logs = await runAudioStage(projectDir, providers);

    // 素材是 wav，落盘就得是 bgm.wav：写成 bgm.mp3 会让文件编码与扩展名对不上。
    assert.ok(existsSync(join(projectDir, "audio", "bgm.wav")), "应从曲库复制到 audio/bgm.wav");
    assert.ok(!existsSync(join(projectDir, "audio", "bgm.mp3")), "不得按请求的占位扩展名落一个空壳");
    // 日志报的是落盘路径（audio/bgm.wav）而不是曲库里的原文件名：provider 只回 outputPath。
    // 「用的是哪一首」由 script.bgmProvenance 回答——曲库来的记 library，不是 ai_generated：
    // 把一份有明确许可的曲库素材说成「模型现生成」同样是在版权信息上说谎。
    assert.ok(
      logs.some(
        (line) =>
          line.includes("已配置背景音乐") &&
          line.includes("audio/bgm.wav") &&
          line.includes("local-library-music")
      ),
      `日志要写明实际落盘路径与来源，实际：${logs.join(" | ")}`
    );
    const script = JSON.parse(readFileSync(join(projectDir, "script.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(script.bgmProvenance, { kind: "library", provider: "local-library-music" });
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(libraryDir, { recursive: true, force: true });
  }
});

test("provider 只回显路径却不产文件（noop-music）：明示无 BGM，且不留空壳文件", async () => {
  const projectDir = makeProjectDir();
  try {
    const { provider, calls } = fakeMusic(async (request) => ({ outputPath: request.outputPath }));
    const logs = await runAudioStage(projectDir, { music: provider });

    assert.equal(calls.length, 1, "没有自带曲子时应当去问一次 provider");
    assert.ok(
      logs.some((line) => line.includes("本片无 BGM") && line.includes("未产出可用曲目")),
      `回显路径但没落盘必须被识破，实际：${logs.join(" | ")}`
    );
    assert.ok(!existsSync(join(projectDir, "audio", "bgm.mp3")), "没产出文件就不能留下任何 bgm 文件");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("provider 抛错：BGM 是加分项，失败只记日志不炸整片", async () => {
  const projectDir = makeProjectDir();
  try {
    const { provider } = fakeMusic(async () => {
      throw new Error("曲库服务 503");
    });
    const logs = await runAudioStage(projectDir, { music: provider });

    assert.ok(
      logs.some((line) => line.includes("BGM 获取失败") && line.includes("曲库服务 503")),
      `失败原因要说清楚，否则用户只听到没声音却查不到为什么，实际：${logs.join(" | ")}`
    );
    assert.ok(logs.some((line) => line.includes("本片无 BGM")), "失败后仍要明确告知本片没有 BGM");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("没配音乐来源，或脚本没给 bgmStyle：明示无 BGM，不尝试取曲", async () => {
  const noProviderDir = makeProjectDir();
  const noStyleDir = makeProjectDir(10, "");
  try {
    const logsWithoutProvider = await runAudioStage(noProviderDir, {});
    assert.ok(
      logsWithoutProvider.some((line) => line.includes("本片无 BGM（未配置音乐来源）")),
      `未配音乐来源时要直说，实际：${logsWithoutProvider.join(" | ")}`
    );

    // 有 provider 但脚本没声明风格：没有风格就无从匹配，去要一首只会拿到随机结果。
    const { provider, calls } = fakeMusic(async (request) => ({ outputPath: request.outputPath }));
    const logsWithoutStyle = await runAudioStage(noStyleDir, { music: provider });
    assert.deepEqual(calls, [], "没有 bgmStyle 时不得向 provider 要曲");
    assert.ok(
      logsWithoutStyle.some((line) => line.includes("本片无 BGM（未配置音乐来源）")),
      `缺风格同样按无 BGM 处理，实际：${logsWithoutStyle.join(" | ")}`
    );
  } finally {
    rmSync(noProviderDir, { recursive: true, force: true });
    rmSync(noStyleDir, { recursive: true, force: true });
  }
});

test("本次没拿到 BGM 而脚本里原有来源声明：旧声明要删掉，不能继续宣称已配乐", async () => {
  // 两种「没拿到」都试一遍：没配音乐来源、以及 provider 抛错。
  // 只增不减的写法会让交付面板与 script.md 继续写着上一首曲子，而实际成片是静音的——
  // 版权标注说错比缺失更伤信任，所以这里断言的是「删掉」而不是「留着」。
  const staleScript = (): Record<string, unknown> => ({
    ...makeScript("warm ambient piano"),
    bgmProvenance: { kind: "ai_generated", provider: "old-music" }
  });
  const noProviderDir = makeProjectDir(10, "warm ambient piano", staleScript());
  const failingDir = makeProjectDir(10, "warm ambient piano", staleScript());
  try {
    await runAudioStage(noProviderDir, {});
    const { provider } = fakeMusic(async () => {
      throw new Error("曲库服务 503");
    });
    await runAudioStage(failingDir, { music: provider });

    for (const dir of [noProviderDir, failingDir]) {
      const script = JSON.parse(readFileSync(join(dir, "script.json"), "utf8")) as Record<string, unknown>;
      assert.equal("bgmProvenance" in script, false, "没配到曲子就不能留着上一首的来源声明");
      assert.doesNotMatch(readFileSync(join(dir, "script.md"), "utf8"), /素材与版权清单/);
    }
  } finally {
    rmSync(noProviderDir, { recursive: true, force: true });
    rmSync(failingDir, { recursive: true, force: true });
  }
});

test("本次没拿到 BGM 且脚本里原本也没有声明：script.json 逐字节不变，旧项目不会凭空多出 script.md", async () => {
  const projectDir = makeProjectDir(10, "warm ambient piano");
  // 没有 script.json 的旧项目：升级前生成、从没写过脚本文件，阶段不能替它造一份出来。
  const legacyDir = makeProjectDir(10, "warm ambient piano", null);
  try {
    const before = readFileSync(join(projectDir, "script.json"));
    await runAudioStage(projectDir, {});
    // 逐字节比对而不是比对象：任何「顺手重写一次」都会改变键序/缩进，那是无意义的落盘噪音。
    assert.deepEqual(readFileSync(join(projectDir, "script.json")), before);
    assert.equal(existsSync(join(projectDir, "script.md")), false, "没有 declaration 变更就不该产出 script.md");

    await runAudioStage(legacyDir, {});
    assert.equal(existsSync(join(legacyDir, "script.json")), false, "旧项目不该被凭空补一份 script.json");
    assert.equal(existsSync(join(legacyDir, "script.md")), false, "旧项目不该被凭空补一份 script.md");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(legacyDir, { recursive: true, force: true });
  }
});