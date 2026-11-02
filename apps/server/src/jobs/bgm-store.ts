/**
 * @file bgm-store.ts
 * @author zhangbaohong
 * @date 2026-10-30
 * @description 项目背景音乐的磁盘层：把一次二进制 PUT 的请求体流式写成 `audio/bgm.<ext>`——
 * 边读边限流（超出 MAX_BGM_BYTES 立刻中断），收尾按文件头魔数确认格式、清掉旧扩展名的同名文件后原子改名落定。
 * 与参考图上传（upload-store.ts）同一套范式，但落点固定为一首曲子：同一项目永远只有一个 `audio/bgm.*`，
 * 换曲即替换，正好对上 render.py 的 find_bgm 与 core 的 findProjectBgm（两者都按扩展名顺序取第一个）。
 * 另给出「会话期暂存」与「创建任务时搬进项目」两个入口：任务一创建就入队开跑（JobRunner.create 末尾即 enqueue），
 * 那时 guardEditable 已对 queued/running 回 409，创建卡片选中的曲子不可能再走 `PUT /:id/bgm`，只能随创建请求落盘。
 * 另附 ffprobe 时长探测：探测不到（未安装 ffprobe）时返回 null 而不是报错，让「本机没装工具链」不阻断上传。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PROJECT_BGM_BASENAME, PROJECT_BGM_EXTS, assertPathWithin, execFileAsync, projectBgmPath } from "@aivideo/core";
import { MAX_BGM_BYTES } from "@aivideo/shared";
import { UploadError, uploadSessionDir } from "./upload-store.js";

/** BGM 所在子目录（与逐镜配音同处 audio/，但语义不同：这是用户资产，不是可再生产物）。 */
const BGM_DIR_NAME = "audio";

/** 落盘结果：项目内相对路径、扩展名、字节数与探测到的时长（ffprobe 不可用时为 null）。 */
export interface StoredBgm {
  /** 路径：项目接口返回项目内相对路径（如 `audio/bgm.mp3`），会话接口返回会话内文件名（如 `bgm.mp3`）。 */
  path: string;
  ext: string;
  bytes: number;
  /** 时长秒数；未安装 ffprobe 时为 null（环境缺失不阻断上传）。 */
  durationSeconds: number | null;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：按文件头魔数嗅探音频扩展名，返回集合与 core 的 PROJECT_BGM_EXTS 一致（render.py 的 find_bgm 认的正是这五种）：
 * ID3 头或 MPEG 帧同步 → mp3；ADTS 帧同步（FFF1/FFF9）→ aac；OggS → ogg；RIFF…WAVE → wav；偏移 4 处 ftyp → m4a。
 * 只读文件头，因此既能用于完整 buffer，也能用于流式上传时攒下的前 16 字节。
 * **刻意不认 fLaC**：设计文档的嗅探表里列了 FLAC，但 render.py 的 find_bgm 不扫 `.flac`，
 * 放行只会得到一个「用户以为换上了、成片里却没有」的静默缺口——宁可在这里明确拒绝。
 * @param head 文件头字节
 * @returns 扩展名或 null
 */
export function sniffAudioExt(head: Buffer): string | null {
  // ADTS 必须先于 MP3 判定：两者都以 0xFF 起头，但 ADTS 的第二个字节固定为 0xF1/0xF9，
  // 先按「FF + 高三位全 1」放行会把 AAC 误判成 mp3，落盘名与内容就对不上了。
  if (head.length >= 2 && head[0] === 0xff && (head[1] === 0xf1 || head[1] === 0xf9)) {
    return "aac";
  }
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) {
    return "mp3";
  }
  if (head.length >= 3 && head.subarray(0, 3).toString("ascii") === "ID3") {
    return "mp3";
  }
  if (head.length >= 4 && head.subarray(0, 4).toString("ascii") === "OggS") {
    return "ogg";
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString("ascii") === "RIFF" &&
    head.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return "wav";
  }
  // m4a 是 MP4 容器的一种品牌：这里只看 `ftyp` 盒子的存在，不细分 brand——
  // 落盘后由 render.py 交给 ffmpeg 解码，品牌不匹配会在渲染阶段给出明确报错，而不是在这里猜。
  if (head.length >= 8 && head.subarray(4, 8).toString("ascii") === "ftyp") {
    return "m4a";
  }
  return null;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：删除项目内已有的全部 `audio/bgm.<ext>`（含非标扩展名的残留），返回被删的绝对路径；目录不存在时静默返回空数组。
 * 换曲与「清空自定义 BGM」共用这一个入口，保证不会留下两首曲子让 find_bgm 的遍历顺序决定结果。
 * @param projectDir 项目目录绝对路径
 * @returns 被删除的绝对路径列表
 */
export function removeProjectBgm(projectDir: string): string[] {
  return removeBgmIn(join(projectDir, BGM_DIR_NAME));
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把一次 PUT 的请求体流式写成项目的 `audio/bgm.<ext>`：边写边累计字节数（超 20MB 立刻中断并 413），
 * 收尾用文件头 16 字节嗅探格式、用 ffprobe 探测时长，**全部通过之后**才清掉旧的 `bgm.*` 并原子改名落定。
 * 全程不把整首曲子读进内存。
 * 写临时文件（`<uuid>.part`，`wx` 独占创建）而不是直接写目标名：这样嗅探失败、探测失败或中途断线时，
 * 项目里原有的那首 BGM 仍然完好——用户换曲失败不该把已有音乐弄丢。探测也刻意放在临时文件上，
 * 而不是落定之后：判据通过才提交，才谈得上「一次换曲要么整体成功、要么整体没发生」。
 * @param projectDir 项目目录绝对路径（调用方须已校验项目 id 合法性）
 * @param body 请求体二进制流
 * @returns 落定的相对路径、扩展名、字节数与时长（ffprobe 不可用时为 null）
 */
export async function receiveBgm(projectDir: string, body: ReadableStream<Uint8Array> | null): Promise<StoredBgm> {
  const audioDir = join(projectDir, BGM_DIR_NAME);
  // projectBgmPath 只拼路径不建目录，这里补上；recursive 让「audio/ 已存在」成为无操作。
  mkdirSync(audioDir, { recursive: true });
  const written = await receiveAudioInto(audioDir, body);
  return { path: `${BGM_DIR_NAME}/${PROJECT_BGM_BASENAME}.${written.ext}`, ...written };
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把创建卡片选中的曲子暂存进上传会话（`<会话>/bgm.<ext>`），供创建请求用 bgmUploadId 引用。
 * 落盘规则与 receiveBgm 完全相同（同一套限流/嗅探/探测/原子改名），只是落点在会话目录里。
 * 会话里的文件名 `bgm.<ext>` 与参考图的 `<index>.<ext>` 不同构，因此 listUploadSession 的图片正则不会把它
 * 误认成一张参考图——同一会话里「图 + 曲」共存是安全的，张数校验也不会被它影响。
 * @param projectsRoot 项目根目录
 * @param uploadId 会话 id
 * @param body 请求体二进制流
 * @returns 会话内的文件名、扩展名、字节数与时长
 */
export async function receiveSessionBgm(
  projectsRoot: string,
  uploadId: string,
  body: ReadableStream<Uint8Array> | null
): Promise<StoredBgm> {
  const dir = uploadSessionDir(projectsRoot, uploadId);
  if (!existsSync(dir)) {
    throw new UploadError(404, "上传会话不存在或已过期");
  }
  const written = await receiveAudioInto(dir, body);
  return { path: `${PROJECT_BGM_BASENAME}.${written.ext}`, ...written };
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把会话里暂存的 `bgm.<ext>` 搬进 `project/<id>/audio/bgm.<ext>`，返回项目内相对路径；
 * 会话里没有曲子时返回 null（用户只打算传参考图），会话已过期时抛 404（用户确实选了曲子，得让他知道没带上）。
 * **必须在 consumeUploadSession 之前调用**：后者收尾会整目录删掉会话，之后再搬只会得到「源文件不存在」。
 * 搬的是音频二进制本身（rename，不读内容），因此不重新探测时长——创建任务只需要「曲子到位」这个事实，
 * 之后 artifacts 用 findProjectBgm 重新发现它，界面要时长时由那里读盘。
 * @param projectsRoot 项目根目录
 * @param projectId 预生成的项目 id
 * @param uploadId 会话 id
 * @returns 项目内相对路径，如 `audio/bgm.mp3`；会话里没有曲子时 null
 */
export function consumeUploadBgm(projectsRoot: string, projectId: string, uploadId: string): string | null {
  const sessionDir = uploadSessionDir(projectsRoot, uploadId);
  if (!existsSync(sessionDir)) {
    // 会话过期后静默跳过，会让用户「明明选了曲子、成片却没音乐」且无迹可查；
    // 与 consumeUploadSession 同口径地报 404，让客户端能明确提示「重新选择」。
    throw new UploadError(404, "背景音乐的上传会话不存在或已过期，请重新选择");
  }
  const ext = PROJECT_BGM_EXTS.find((candidate) => existsSync(join(sessionDir, `${PROJECT_BGM_BASENAME}.${candidate}`)));
  if (!ext) {
    return null;
  }
  const projectDir = join(projectsRoot, projectId);
  assertPathWithin(projectsRoot, projectDir, "Project directory");
  const audioDir = join(projectDir, BGM_DIR_NAME);
  mkdirSync(audioDir, { recursive: true });
  // 先清掉项目里全部 bgm.* 再改名：留下两首会让 find_bgm 按扩展名顺序取第一个，混进另一首。
  removeBgmIn(audioDir);
  renameSync(join(sessionDir, `${PROJECT_BGM_BASENAME}.${ext}`), projectBgmPath(projectDir, ext));
  return `${BGM_DIR_NAME}/${PROJECT_BGM_BASENAME}.${ext}`;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把一次 PUT 的请求体流式写成给定目录下的 `bgm.<ext>`：边写边限流、收尾嗅探格式与探测时长，
 * 全部通过之后才清掉该目录里旧的 `bgm.*` 并原子改名落定。项目目录与会话目录共用这一份实现，
 * 保证两处的限流/嗅探/探测/替换语义逐字节一致。
 * @param dir 目标目录（项目内的 `audio/`，或某个上传会话目录）
 * @param body 请求体二进制流
 * @returns 扩展名、字节数与时长（调用方各自拼出对外的 path）
 */
async function receiveAudioInto(dir: string, body: ReadableStream<Uint8Array> | null): Promise<Omit<StoredBgm, "path">> {
  if (!body) {
    throw new UploadError(400, "请求体为空");
  }
  const tmp = join(dir, `${randomUUID()}.part`);
  const reader = body.getReader();
  const fd = openSync(tmp, "wx");
  let bytes = 0;
  let head = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      bytes += value.byteLength;
      if (bytes > MAX_BGM_BYTES) {
        // 先停掉上游再抛：不 cancel 的话客户端会继续把一个超大文件推完，白占带宽。
        await reader.cancel().catch(() => undefined);
        throw new UploadError(413, `背景音乐不能超过 ${MAX_BGM_BYTES / (1024 * 1024)}MB`);
      }
      if (head.length < 16) {
        head = Buffer.concat([head, Buffer.from(value.subarray(0, 16 - head.length))]);
      }
      // writeSync 允许短写：一次没写完就继续写剩余部分，否则慢盘上会静默丢掉尾巴——
      // 嗅探通过、文件却是截断的，最后表现为「渲染时音频流比预期短」。
      let offset = 0;
      while (offset < value.byteLength) {
        offset += writeSync(fd, value, offset, value.byteLength - offset);
      }
    }
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);

  if (bytes === 0) {
    rmSync(tmp, { force: true });
    throw new UploadError(400, "背景音乐为空文件");
  }
  const ext = sniffAudioExt(head);
  if (!ext) {
    rmSync(tmp, { force: true });
    throw new UploadError(400, "不是受支持的音频格式（mp3/wav/aac/m4a/ogg）");
  }
  // 探测放在「临时文件还在、旧曲还在」的这一刻：判据不过就地把 tmp 删掉，用户原来的 BGM 一根头发都不少。
  let durationSeconds: number | null;
  try {
    durationSeconds = await probeAudioDuration(tmp);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  // 先清旧再改名：反过来会有一瞬间同时存在两个 bgm.*，find_bgm 按扩展名顺序取第一个，
  // 这一瞬间跑起来的渲染就会混进旧曲。
  removeBgmIn(dir);
  renameSync(tmp, join(dir, `${PROJECT_BGM_BASENAME}.${ext}`));
  return { ext, bytes, durationSeconds };
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：删除给定目录下全部 `bgm.<ext>`，返回被删的绝对路径；目录不存在时静默返回空数组。
 * 项目目录与会话目录共用：两处都必须「同一时刻只有一首曲子」。
 * @param dir 目标目录
 * @returns 被删除的绝对路径列表
 */
function removeBgmIn(dir: string): string[] {
  const removed: string[] = [];
  for (const ext of PROJECT_BGM_EXTS) {
    const target = join(dir, `${PROJECT_BGM_BASENAME}.${ext}`);
    if (existsSync(target)) {
      rmSync(target, { force: true });
      removed.push(target);
    }
  }
  return removed;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：用 ffprobe 读取音频时长（秒）；**未安装 ffprobe 时返回 null**，让「本机没有工具链」不阻断上传，
 * 而「装了却解不开这个文件」明确抛 400——前者是环境缺失，后者是文件问题，两者必须分开报。
 * execFileAsync 不保留子进程的 code，只能靠错误文案里的 ENOENT 判定工具缺失。
 * @param filePath 音频绝对路径
 * @returns 时长秒数，探测不可用时为 null
 */
export async function probeAudioDuration(filePath: string): Promise<number | null> {
  let stdout: string;
  try {
    stdout = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      filePath
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(message)) {
      return null;
    }
    throw new UploadError(400, `音频无法解析：${message.split("\n")[0] ?? message}`);
  }
  try {
    const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
    const duration = Number.parseFloat(parsed.format?.duration ?? "");
    if (!Number.isFinite(duration) || duration <= 0) {
      // 探测跑通了却没有时长：这不是「环境缺失」，而是文件本身不是可解码的音频流。
      throw new UploadError(400, "音频无法解析：读不出时长");
    }
    return duration;
  } catch (error) {
    if (error instanceof UploadError) {
      throw error;
    }
    throw new UploadError(400, "音频无法解析：ffprobe 输出不可读");
  }
}