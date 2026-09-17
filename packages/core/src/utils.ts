/**
 * @file utils.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 跨包共享的文件系统、路径安全（防越界）与子进程执行工具：非空文件判断、路径包含校验、并发限流、execFile Promise 封装、JSON 原子写出与本地图片校验。
 * @see https://github.com/1241751430/AIVideo.git
 */

import { execFile } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Shared filesystem, path-safety and process helpers used across
 * @aivideo/core, @aivideo/providers and @aivideo/cli so the same guard is
 * not re-implemented per package.
 */

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：判断 filePath 是否为存在、是普通文件且内容非空；stat 异常时按 false 处理。
 */
/** True when `filePath` names a regular file with non-empty content. */
export function nonEmptyFileExists(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }
  try {
    return statSync(filePath).isFile() && statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：判断 candidatePath 解析后是否等于 baseDir 或位于其内部，防御 ../ 穿越与绝对路径逃逸。
 */
/**
 * True when `candidatePath` resolves to `baseDir` itself or a path inside it.
 * Guards against traversal (`../`) and absolute escapes; a sibling directory
 * whose name merely starts with `..` (e.g. `..hidden`) stays inside.
 */
export function isWithinBase(baseDir: string, candidatePath: string): boolean {
  const rel = relative(resolve(baseDir), resolve(candidatePath));
  if (rel === "") {
    return true;
  }
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：当 candidatePath 逃逸出 baseDir 时抛出带 label 说明的错误。
 */
/** Throws when `candidatePath` escapes `baseDir`. */
export function assertPathWithin(baseDir: string, candidatePath: string, label: string): void {
  if (!isWithinBase(baseDir, candidatePath)) {
    throw new Error(`${label} must stay within ${baseDir}.`);
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：以最多 limit 个并发执行任务 thunk 队列，保持入队顺序，全部完成才返回。
 */
/** Runs task thunks with at most `limit` in flight, preserving queue order. */
export async function runConcurrent(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const current = index++;
      await tasks[current]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
}

export interface ExecFileOptions {
  maxBufferBytes?: number;
  /** Printed before the command starts and every `heartbeatMs` while it runs. */
  statusMessage?: string;
  heartbeatMs?: number;
  /**
   * Called before the command starts and on every heartbeat instead of
   * printing `statusMessage` — lets a TUI drive the same liveness signal.
   */
  onHeartbeat?: () => void;
  /**
   * Live per-line sink for the child's stdout (used by the workbench server
   * to stream render progress). Lines are delivered as complete lines without
   * the trailing newline; a final unterminated fragment is flushed at exit.
   */
  onStdoutLine?: (line: string) => void;
  /** Kills the child process when aborted; the promise rejects. */
  signal?: AbortSignal;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：execFile 的 Promise 封装：成功 resolve stdout；失败把 stderr/stdout 并入 Error 拒绝；支持 statusMessage 心跳、onStdoutLine 逐行流式与 AbortSignal 终止子进程。
 * @returns 子进程的 stdout
 */
/**
 * Promise wrapper around execFile. Resolves with stdout; rejects with the
 * command's stderr/stdout merged into the message when available.
 */
export function execFileAsync(command: string, args: string[], options: ExecFileOptions = {}): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let heartbeat: NodeJS.Timeout | undefined;
    const tick = () => {
      if (options.onHeartbeat) {
        options.onHeartbeat();
      } else if (options.statusMessage) {
        console.log(options.statusMessage);
      }
    };
    if (options.onHeartbeat || options.statusMessage) {
      tick();
      if (options.heartbeatMs && options.heartbeatMs > 0) {
        heartbeat = setInterval(tick, options.heartbeatMs);
      }
    }

    const child = execFile(command, args, { maxBuffer: options.maxBufferBytes ?? 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      if (options.onStdoutLine && lineBuffer) {
        const line = lineBuffer.trimEnd();
        if (line) {
          options.onStdoutLine(line);
        }
      }
      if (error) {
        const detail = [stderr, stdout].filter(Boolean).join("\n").trim();
        rejectPromise(new Error(detail || error.message));
        return;
      }
      resolvePromise(stdout);
    });

    let lineBuffer = "";
    if (options.onStdoutLine && child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        lineBuffer += chunk;
        let newlineIndex;
        while ((newlineIndex = lineBuffer.indexOf("\n")) >= 0) {
          const line = lineBuffer.slice(0, newlineIndex).trimEnd();
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
          if (line) {
            options.onStdoutLine!(line);
          }
        }
      });
    }

    function onAbort(): void {
      child.kill("SIGKILL");
    }
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把 value 序列化为缩进 2 空格的 JSON（末尾带换行）并以 utf8 写入 target。
 */
/** Atomically-ish write of a JSON document (trailing newline, utf8). */
export function writeJsonFile(target: string, value: unknown): void {
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export const LOCAL_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

/** Providers and the CLI both cap reference images at the same size. */
export const MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验用户/项目提供的本地图片：存在、普通文件、非空、不超过大小上限且扩展名受支持，返回其 MIME 与字节数；label 用于错误文案前缀。
 * @returns { mime, sizeBytes }
 */
/**
 * Validates a user/project-supplied local image (existence, regular file,
 * non-empty, size cap, supported extension) and returns its MIME type.
 * `label` prefixes error messages so callers keep context-specific wording
 * (e.g. "Image" for CLI args, "Reference image" for video providers).
 */
export function validateLocalImageFile(
  filePath: string,
  label = "Image"
): { mime: string; sizeBytes: number } {
  if (!existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new Error(`${label} not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  if (stat.size === 0) {
    throw new Error(`${label} is empty: ${filePath}`);
  }
  if (stat.size > MAX_LOCAL_IMAGE_BYTES) {
    throw new Error(`${label} exceeds ${MAX_LOCAL_IMAGE_BYTES} bytes: ${filePath}`);
  }
  const mime = LOCAL_IMAGE_MIME[extname(filePath).toLowerCase()];
  if (!mime) {
    throw new Error(
      `Unsupported ${label.toLowerCase()} format: ${filePath} (use png, jpg, jpeg or webp)`
    );
  }
  return { mime, sizeBytes: stat.size };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验项目 id 可安全用作 project/ 下的目录名：字母/数字（含 CJK）开头，仅含字母数字与 _ . -，长度 ≤200，不含路径分隔符或 ".."。
 * @param value 待校验字符串
 * @returns 是否合法
 */
export function isValidProjectId(value: string): boolean {
  return (
    typeof value === "string" &&
    /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,199}$/u.test(value) &&
    !value.includes("..")
  );
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：解析时长字符串（支持 "45s" 与 "30" 形式）为秒数。
 * @param value 原始时长文本
 * @returns 秒数；无法解析时返回 undefined
 */
export function parseDuration(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const parsed = normalized.endsWith("s")
    ? Number.parseInt(normalized.slice(0, -1), 10)
    : Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
