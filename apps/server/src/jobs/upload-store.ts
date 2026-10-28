/**
 * @file upload-store.ts
 * @author zhangbaohong
 * @date 2026-10-28
 * @description 参考图分片上传的磁盘层：会话落在 projectsRoot/.uploads/<uploadId>/（首字符非字母数字，scanProjects 的 id 过滤天然跳过它），
 * 每张图一次 PUT 独立落盘——请求体以二进制流写入并在读的过程中限流，不在内存里攒整张图（base64 走 JSON 的老路会让 20×10MB 膨胀成约 268MB 单请求）；
 * 创建任务时把整场会话按序搬进 project/<id>/input/ 后销毁会话，保证 request.inputImagePaths 的顺序即镜头绑定关系。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { assertPathWithin, MAX_INPUT_IMAGES } from "@aivideo/core";

/** 单张参考图的大小上限：10MB（按落盘字节数计，与 core 的生成前校验口径一致）。 */
export const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;

/** 会话目录名：以 `.` 开头，`isValidProjectId` 必然拒绝，因此项目列表/扫描不会把它当成项目。 */
export const UPLOADS_DIR_NAME = ".uploads";

/** 会话存活期：超过一天没动静就清掉，避免用户半途关页留下孤儿目录。 */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** 受支持的图片扩展名，与 sniffImageExt 的返回集合一致。 */
const IMAGE_EXTS = ["png", "jpg", "webp"] as const;

/** 会话内已落盘图片的文件名格式：`<index>.<ext>`。 */
const IMAGE_FILE_RE = /^(\d{1,2})\.(png|jpg|webp)$/;

/** uploadId 形状：标准 UUID；先校验形状再拼路径，避免任何请求参数参与目录穿越。 */
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 上传相关的可预期失败：路由据此直接回状态码，不必解析错误文案。 */
export type UploadErrorStatus = 400 | 404 | 413;

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：上传流程的可预期错误（会话不存在/序号越界/超限/魔数不符），携带建议的 HTTP 状态码。
 */
export class UploadError extends Error {
  constructor(
    public readonly status: UploadErrorStatus,
    message: string
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/** 会话内单张图片的落盘信息。 */
export interface UploadedImage {
  /** 用户提交顺序（0 起）。 */
  index: number;
  ext: string;
  bytes: number;
}

/** GET /uploads/:id 返回的会话快照。 */
export interface UploadSessionSnapshot {
  uploadId: string;
  images: UploadedImage[];
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验 uploadId 是否为本服务签发的 UUID 形状（非法即视同不存在，不泄露目录结构）。
 * @param uploadId 待校验的会话 id
 * @returns 形状是否合法
 */
export function isValidUploadId(uploadId: string): boolean {
  return UPLOAD_ID_RE.test(uploadId);
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：上传会话的父目录（projectsRoot/.uploads）。
 * @param projectsRoot 项目根目录
 * @returns 会话父目录绝对路径
 */
export function uploadsRoot(projectsRoot: string): string {
  return join(projectsRoot, UPLOADS_DIR_NAME);
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：单个上传会话的目录；uploadId 形状非法或解析后越出会话父目录时抛 404。
 * @param projectsRoot 项目根目录
 * @param uploadId 会话 id
 * @returns 会话目录绝对路径
 */
export function uploadSessionDir(projectsRoot: string, uploadId: string): string {
  if (!isValidUploadId(uploadId)) {
    throw new UploadError(404, "上传会话不存在或已过期");
  }
  const root = uploadsRoot(projectsRoot);
  const dir = join(root, uploadId);
  assertPathWithin(root, dir, "Upload session directory");
  return dir;
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：新建一次上传会话并返回 uploadId；会话目录即刻创建，后续每张图各自 PUT 到 `<dir>/<index>`。
 * @param projectsRoot 项目根目录
 * @returns 新会话 id
 */
export function createUploadSession(projectsRoot: string): string {
  const uploadId = randomUUID();
  mkdirSync(uploadSessionDir(projectsRoot, uploadId), { recursive: true });
  return uploadId;
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：按 mtime 清理超过 TTL 的会话目录并返回被删路径；建会话时顺带调用，避免半途关页的孤儿目录无限堆积。
 * 与项目清理不同，这里只扫 .uploads 一级子目录，且删除失败（并发删除）不打断整体清扫。
 * @param projectsRoot 项目根目录
 * @param ttlMs 会话存活期（毫秒）
 * @returns 被删除的会话目录绝对路径
 */
export function sweepExpiredUploads(projectsRoot: string, ttlMs: number = UPLOAD_SESSION_TTL_MS): string[] {
  const root = uploadsRoot(projectsRoot);
  if (!existsSync(root)) {
    return [];
  }
  const now = Date.now();
  const removed: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(root, entry.name);
    try {
      if (now - statSync(dir).mtimeMs > ttlMs) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    } catch {
      // 并发删除或权限问题：下一轮清扫再试，不影响本次创建会话
    }
  }
  return removed;
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：读取会话已收到的图片（按用户提交序号升序）；会话不存在返回 null。
 * @param projectsRoot 项目根目录
 * @param uploadId 会话 id
 * @returns 会话快照或 null
 */
export function listUploadSession(projectsRoot: string, uploadId: string): UploadSessionSnapshot | null {
  let dir: string;
  try {
    dir = uploadSessionDir(projectsRoot, uploadId);
  } catch {
    return null;
  }
  if (!existsSync(dir)) {
    return null;
  }
  const images: UploadedImage[] = [];
  for (const name of readdirSync(dir)) {
    const match = name.match(IMAGE_FILE_RE);
    if (!match) {
      continue;
    }
    const index = Number.parseInt(match[1] ?? "", 10);
    const ext = match[2] ?? "";
    try {
      images.push({ index, ext, bytes: statSync(join(dir, name)).size });
    } catch {
      // 并发删除：跳过这一张
    }
  }
  images.sort((a, b) => a.index - b.index);
  return { uploadId, images };
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：把一次 PUT 的请求体流式写入 `<会话>/<index>.part`，边写边累计字节数（超 10MB 立刻中断并 413），
 * 收尾时用文件头 16 字节嗅探格式、按真实格式改名落定；重传同一序号会先清掉其它扩展名的旧文件。
 * 全程不在内存里缓存整张图，请求体有多大内存占用都由单次 read 的块大小决定。
 * @param projectsRoot 项目根目录
 * @param uploadId 会话 id
 * @param index 用户提交顺序（0 起，须小于 MAX_INPUT_IMAGES）
 * @param body 请求体二进制流
 * @returns 落定后的扩展名与字节数
 */
export async function receiveImage(
  projectsRoot: string,
  uploadId: string,
  index: number,
  body: ReadableStream<Uint8Array> | null
): Promise<UploadedImage> {
  const dir = uploadSessionDir(projectsRoot, uploadId);
  if (!existsSync(dir)) {
    throw new UploadError(404, "上传会话不存在或已过期");
  }
  if (!Number.isInteger(index) || index < 0 || index >= MAX_INPUT_IMAGES) {
    throw new UploadError(400, `参考图序号必须在 0..${MAX_INPUT_IMAGES - 1} 之间`);
  }
  if (!body) {
    throw new UploadError(400, "请求体为空");
  }

  const tmp = join(dir, `${index}.part`);
  const reader = body.getReader();
  const fd = openSync(tmp, "w");
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
      if (bytes > MAX_INPUT_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new UploadError(413, `第 ${index + 1} 张超过 ${MAX_INPUT_IMAGE_BYTES / (1024 * 1024)}MB 上限`);
      }
      if (head.length < 16) {
        head = Buffer.concat([head, Buffer.from(value.subarray(0, 16 - head.length))]);
      }
      writeSync(fd, value);
    }
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);

  if (bytes === 0) {
    rmSync(tmp, { force: true });
    throw new UploadError(400, `第 ${index + 1} 张为空文件`);
  }
  const ext = sniffImageExt(head);
  if (!ext) {
    rmSync(tmp, { force: true });
    throw new UploadError(400, `第 ${index + 1} 张不是受支持的图片（png/jpeg/webp）`);
  }
  for (const known of IMAGE_EXTS) {
    rmSync(join(dir, `${index}.${known}`), { force: true });
  }
  renameSync(tmp, join(dir, `${index}.${ext}`));
  return { index, ext, bytes };
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：放弃会话并删除已上传的图片；id 非法时静默返回（幂等，便于客户端失败重试）。
 * @param projectsRoot 项目根目录
 * @param uploadId 会话 id
 */
export function removeUploadSession(projectsRoot: string, uploadId: string): void {
  if (!isValidUploadId(uploadId)) {
    return;
  }
  rmSync(uploadSessionDir(projectsRoot, uploadId), { recursive: true, force: true });
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：把会话里的图片按序号搬进 project/<id>/input/<n>.<ext> 并销毁会话（先校验序号从 0 连续，缺张直接拒绝，避免镜头绑定错位）；
 * 返回的绝对路径顺序即提交顺序，调用方原样写入 request.inputImagePaths。
 * @param projectsRoot 项目根目录
 * @param projectId 预生成的项目 id
 * @param uploadId 会话 id
 * @returns 落盘后的绝对路径列表
 */
export function consumeUploadSession(projectsRoot: string, projectId: string, uploadId: string): string[] {
  const session = listUploadSession(projectsRoot, uploadId);
  if (!session) {
    throw new UploadError(404, "上传会话不存在或已过期");
  }
  if (session.images.length === 0) {
    throw new UploadError(400, "上传会话里没有参考图");
  }
  for (const [expected, image] of session.images.entries()) {
    if (image.index !== expected) {
      throw new UploadError(400, `参考图第 ${expected + 1} 张缺失，请重新上传后再创建`);
    }
  }

  const projectDir = join(projectsRoot, projectId);
  assertPathWithin(projectsRoot, projectDir, "Project directory");
  const inputDir = join(projectDir, "input");
  mkdirSync(inputDir, { recursive: true });
  const sessionDir = uploadSessionDir(projectsRoot, uploadId);
  const written: string[] = [];
  for (const image of session.images) {
    const target = join(inputDir, `${image.index + 1}.${image.ext}`);
    renameSync(join(sessionDir, `${image.index}.${image.ext}`), target);
    written.push(target);
  }
  rmSync(sessionDir, { recursive: true, force: true });
  return written;
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：按魔数嗅探图片扩展名：PNG(89 50 4E 47)/JPEG(FF D8)/WEBP(RIFF…WEBP)；未知返回 null。
 * 只读文件头，所以既能用于完整 buffer，也能用于流式上传时攒下的前 16 字节。
 * @param head 文件头字节
 * @returns 扩展名或 null
 */
export function sniffImageExt(head: Buffer): string | null {
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return "png";
  }
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) {
    return "jpg";
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString("ascii") === "RIFF" &&
    head.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}