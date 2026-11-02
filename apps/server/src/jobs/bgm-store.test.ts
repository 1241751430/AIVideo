/**
 * @file bgm-store.test.ts
 * @author zhangbaohong
 * @date 2026-10-30
 * @description 背景音乐磁盘层与两个上传入口的测试：魔数嗅探（五种格式 + ADTS 不被误判成 mp3 + fLaC 明确拒绝）、
 * 会话暂存后随创建请求搬进 `audio/bgm.<ext>`、会话里图与曲共存互不干扰、没有曲子时不落任何 bgm 文件、
 * 会话过期报错而不是静默丢曲、非音频魔数与超 20MB（Content-Length 与流式两条路）都拒绝且不留残渣，
 * 以及 `PUT /api/uploads/:id/bgm` 不被 `:index` 吞掉、项目换曲是覆盖式、清曲幂等。
 * 嗅探是纯函数，用各种最小文件头即可；凡是走 receiveAudioInto 的路径统一用一段手工构造的合法 WAV——
 * 那一步要用 ffprobe 探测时长，假文件头在装了 ffprobe 的机器上会被判「音频无法解析」。
 * 因此时长只断言「正数或 null」：装了 ffprobe 是 0.5，没装是 null，两种环境都得过。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_BGM_BYTES } from "@aivideo/shared";
import { receiveSessionBgm, sniffAudioExt } from "./bgm-store.js";
import { UploadError } from "./upload-store.js";
import { createDoneJob, makeTestApp, waitUntil } from "../testkit.js";
import type { TestAppContext } from "../testkit.js";

/** 各种格式的最小文件头：只喂给纯函数 sniffAudioExt，不会走到 ffprobe 那一步。 */
const MP3_ID3_HEAD = Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(13)]);
const MP3_FRAME_HEAD = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]);
const AAC_ADTS_HEAD = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]);
const WAV_HEAD = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVE", "ascii"), Buffer.alloc(8)]);
const OGG_HEAD = Buffer.concat([Buffer.from("OggS", "ascii"), Buffer.alloc(12)]);
const M4A_HEAD = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A ", "ascii"), Buffer.alloc(8)]);
/** 一张最小的 PNG 头：用来验证「同一个会话里图与曲共存」。 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：手工构造一段合法 WAV（PCM 16bit 单声道 8kHz，指定时长，内容为静音）。
 * 之所以不用假文件头：上传路径会调用 ffprobe 探测时长，装了 ffprobe 的机器上假文件头会被判「无法解析」，
 * 而这些用例要验证的是落盘语义，不该随环境里有没有 ffmpeg 而红。
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

/** 走上传路径用的曲子：半秒静音，文件不大，ffprobe 在不在都能过。 */
const WAV_BYTES = makeWav();

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：断言时长字段的合法取值：装了 ffprobe 给正数，没装给 null，不接受 NaN 或编出来的 0。
 * @param value 服务端返回的 durationSeconds
 */
function assertDurationIsHonest(value: number | null): void {
  assert.ok(
    value === null || (typeof value === "number" && Number.isFinite(value) && value > 0),
    `durationSeconds 只能是正数或 null，实际是 ${String(value)}`
  );
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：开一个上传会话并返回 uploadId。
 * @param ctx 测试应用上下文
 * @returns 会话 id
 */
async function openSession(ctx: TestAppContext): Promise<string> {
  const res = await ctx.app.request("/api/uploads", { method: "POST" });
  assert.equal(res.status, 201);
  return ((await res.json()) as { uploadId: string }).uploadId;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把一段音频 PUT 进会话，返回原始响应供调用方断状态码。
 * @param ctx 测试应用上下文
 * @param uploadId 会话 id
 * @param bytes 音频字节
 * @returns 响应
 */
async function putBgm(ctx: TestAppContext, uploadId: string, bytes: Uint8Array): Promise<Response> {
  return ctx.app.request(`/api/uploads/${uploadId}/bgm`, { method: "PUT", body: bytes });
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：发出创建任务请求，返回状态码与解析后的响应体。
 * @param ctx 测试应用上下文
 * @param body 创建请求体
 * @returns 状态码与响应体
 */
async function postProject(
  ctx: TestAppContext,
  body: Record<string, unknown>
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const res = await ctx.app.request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, payload: (await res.json()) as Record<string, unknown> };
}

test("sniffAudioExt：五种格式各自认得出，ADTS 不被误判成 mp3，fLaC 明确拒绝", () => {
  assert.equal(sniffAudioExt(MP3_ID3_HEAD), "mp3");
  assert.equal(sniffAudioExt(MP3_FRAME_HEAD), "mp3", "没有 ID3 标签的老式 MP3 也要认得出");
  assert.equal(sniffAudioExt(WAV_HEAD), "wav");
  assert.equal(sniffAudioExt(AAC_ADTS_HEAD), "aac", "ADTS 必须先于 MPEG 帧同步判定");
  assert.equal(sniffAudioExt(OGG_HEAD), "ogg");
  assert.equal(sniffAudioExt(M4A_HEAD), "m4a");
  // render.py 的 find_bgm 不扫 .flac：这里放行只会得到「用户以为换上了、成片里却没有」的静默缺口。
  assert.equal(sniffAudioExt(Buffer.from("fLaC\x00\x00\x00\x00", "latin1")), null);
  assert.equal(sniffAudioExt(Buffer.from("not-an-audio")), null);
  assert.equal(sniffAudioExt(Buffer.alloc(0)), null, "空文件头不能被当成某个格式");
});

test("会话暂存 → 创建时把曲子搬进 audio/bgm.wav 并销毁会话", async () => {
  const ctx = makeTestApp();
  try {
    const uploadId = await openSession(ctx);
    const res = await putBgm(ctx, uploadId, WAV_BYTES);
    assert.equal(res.status, 200);
    const { bgm } = (await res.json()) as {
      bgm: { path: string; ext: string; bytes: number; durationSeconds: number | null };
    };
    assert.equal(bgm.path, "bgm.wav", "会话接口返回会话内文件名，而不是项目内相对路径");
    assert.equal(bgm.ext, "wav");
    assert.equal(bgm.bytes, WAV_BYTES.byteLength);
    assertDurationIsHonest(bgm.durationSeconds);

    const created = await postProject(ctx, { briefText: "主题：带曲子", bgmUploadId: uploadId });
    assert.equal(created.status, 201);
    const jobId = (created.payload.job as { id: string }).id;
    await waitUntil(() => ctx.runner.get(jobId)?.phase === "done", "done");

    assert.equal(existsSync(join(ctx.projectsRoot, jobId, "audio", "bgm.wav")), true, "曲子落进项目 audio/");
    assert.equal(existsSync(join(ctx.projectsRoot, ".uploads", uploadId)), false, "会话已被消费并销毁");
  } finally {
    ctx.cleanup();
  }
});

test("同一会话里图与曲共存：图数不受影响，创建后各归其位", async () => {
  const ctx = makeTestApp();
  try {
    const uploadId = await openSession(ctx);
    assert.equal((await ctx.app.request(`/api/uploads/${uploadId}/0`, { method: "PUT", body: PNG_BYTES })).status, 200);
    assert.equal((await putBgm(ctx, uploadId, WAV_BYTES)).status, 200);

    const session = (await (await ctx.app.request(`/api/uploads/${uploadId}`)).json()) as {
      images: Array<{ index: number; ext: string }>;
    };
    // `bgm.wav` 与 `0.png` 不同构，图片正则不会把它算成第二张图，张数校验也不会被它带偏。
    assert.deepEqual(session.images.map((image) => [image.index, image.ext]), [[0, "png"]]);

    const created = await postProject(ctx, { briefText: "主题：图加曲", uploadId, bgmUploadId: uploadId });
    assert.equal(created.status, 201);
    const job = ctx.runner.get((created.payload.job as { id: string }).id);
    assert.ok(job);
    assert.equal(job.request.inputImagePaths?.length, 1, "参考图照常搬进 input/");
    assert.equal(existsSync(join(ctx.projectsRoot, job.id, "audio", "bgm.wav")), true, "曲子照常落进 audio/");
    assert.equal(existsSync(join(ctx.projectsRoot, job.id, "input", "1.png")), true, "图在 input/");
  } finally {
    ctx.cleanup();
  }
});

test("会话里没有曲子时创建照常成功，且项目里不会凭空多出 bgm 文件", async () => {
  const ctx = makeTestApp();
  try {
    const uploadId = await openSession(ctx);
    assert.equal((await ctx.app.request(`/api/uploads/${uploadId}/0`, { method: "PUT", body: PNG_BYTES })).status, 200);
    const created = await postProject(ctx, { briefText: "主题：只有图", bgmUploadId: uploadId });
    assert.equal(created.status, 201, "带了 bgmUploadId 但会话里没曲子，不是错误");
    const jobId = (created.payload.job as { id: string }).id;
    await waitUntil(() => ctx.runner.get(jobId)?.phase === "done", "done");
    const audioDir = join(ctx.projectsRoot, jobId, "audio");
    assert.deepEqual(
      existsSync(audioDir) ? readdirSync(audioDir).filter((name) => name.startsWith("bgm.")) : [],
      [],
      "没有曲子就不该有 audio/bgm.*"
    );
  } finally {
    ctx.cleanup();
  }
});

test("会话已过期：创建时把曲子异常报成 400 文案，而不是静默丢掉用户选的曲", async () => {
  const ctx = makeTestApp();
  try {
    const ghost = "00000000-0000-4000-8000-000000000000";
    const created = await postProject(ctx, { briefText: "主题：过期会话", bgmUploadId: ghost });
    assert.equal(created.status, 400, "创建路由把会话异常统一折算成 400");
    assert.match(String(created.payload.error), /背景音乐/, "文案要指名是曲子出了问题，用户才知道重选");
    assert.equal(ctx.runner.list().length, 0, "失败时不留半个任务");
    assert.deepEqual(readdirSync(ctx.projectsRoot).filter((name) => !name.startsWith(".")), [], "也不留项目目录");
  } finally {
    ctx.cleanup();
  }
});

test("非音频魔数：400 且会话目录不留临时文件", async () => {
  const ctx = makeTestApp();
  try {
    const uploadId = await openSession(ctx);
    const res = await putBgm(ctx, uploadId, Buffer.from("this is not audio at all"));
    assert.equal(res.status, 400);
    assert.deepEqual(readdirSync(join(ctx.projectsRoot, ".uploads", uploadId)), [], "坏文件连 .part 都不该剩");
  } finally {
    ctx.cleanup();
  }
});

test("超过 20MB：Content-Length 预挡 413，且一个字节都不落盘", async () => {
  const ctx = makeTestApp();
  try {
    const uploadId = await openSession(ctx);
    const oversized = Buffer.alloc(MAX_BGM_BYTES + 1);
    WAV_BYTES.copy(oversized, 0);
    const res = await putBgm(ctx, uploadId, oversized);
    assert.equal(res.status, 413);
    assert.deepEqual(readdirSync(join(ctx.projectsRoot, ".uploads", uploadId)), []);
  } finally {
    ctx.cleanup();
  }
});

test("流式超限：没有 Content-Length 时由边读边累计拦下并 413", async () => {
  const ctx = makeTestApp();
  try {
    const uploadId = await openSession(ctx);
    // 分块喂进来，模拟 chunked 传输：内容长度对服务端不可知，只能靠累计字节数在流上拦。
    const chunk = Buffer.concat([WAV_BYTES, Buffer.alloc(1024 * 1024)]);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_BGM_BYTES) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(new Uint8Array(chunk));
      }
    });
    await assert.rejects(
      receiveSessionBgm(ctx.projectsRoot, uploadId, stream),
      (error: unknown) => error instanceof UploadError && error.status === 413
    );
    assert.deepEqual(readdirSync(join(ctx.projectsRoot, ".uploads", uploadId)), [], "超限的 .part 被清掉");
  } finally {
    ctx.cleanup();
  }
});

test("PUT /api/uploads/:id/bgm 不被 :index 吞掉，返回的是 bgm 而不是 image", async () => {
  const ctx = makeTestApp();
  try {
    const uploadId = await openSession(ctx);
    const res = await putBgm(ctx, uploadId, WAV_BYTES);
    assert.equal(res.status, 200, "被 :index 吞掉时会变成「序号必须在 0..19 之间」的 400");
    const payload = (await res.json()) as Record<string, unknown>;
    assert.ok(payload.bgm, "响应体必须是 {bgm}");
    assert.equal(payload.image, undefined);
  } finally {
    ctx.cleanup();
  }
});

test("项目换曲是覆盖式：旧的 bgm.mp3 残留会被清掉，只留刚传上的那首；清曲幂等", async () => {
  const ctx = makeTestApp();
  try {
    const jobId = await createDoneJob(ctx, "换曲");
    const audioDir = join(ctx.projectsRoot, jobId, "audio");
    // noopStages 不落任何产物，audio/ 要自己建：等价于「真实流水线跑完之后 audio/ 里已经有了上一首曲子」。
    mkdirSync(audioDir, { recursive: true });
    // 手工塞一首别的扩展名：等价于「用户上一首选的是 mp3，这次换成了 wav」。
    // 两首同时留着会让 render.py 的 find_bgm 按扩展名顺序取到 mp3——用户换上的却是 wav。
    writeFileSync(join(audioDir, "bgm.mp3"), MP3_ID3_HEAD);

    const put = await ctx.app.request(`/api/projects/${jobId}/bgm`, { method: "PUT", body: WAV_BYTES });
    assert.equal(put.status, 200);
    const { bgm } = (await put.json()) as { bgm: { path: string; ext: string } };
    assert.equal(bgm.path, "audio/bgm.wav", "项目接口返回项目内相对路径");
    assert.deepEqual(readdirSync(audioDir).filter((name) => name.startsWith("bgm.")), ["bgm.wav"]);

    const artifacts = (await (await ctx.app.request(`/api/projects/${jobId}/artifacts`)).json()) as { bgm: string | null };
    assert.equal(artifacts.bgm, "audio/bgm.wav", "工件快照与 core 的 findProjectBgm 给出同一首");

    const first = await ctx.app.request(`/api/projects/${jobId}/bgm`, { method: "DELETE" });
    assert.equal(first.status, 200);
    assert.deepEqual(((await first.json()) as { removed: string[] }).removed, ["audio/bgm.wav"]);
    const second = await ctx.app.request(`/api/projects/${jobId}/bgm`, { method: "DELETE" });
    assert.equal(second.status, 200, "本来没有曲子也回 200");
    assert.deepEqual(((await second.json()) as { removed: string[] }).removed, []);
  } finally {
    ctx.cleanup();
  }
});