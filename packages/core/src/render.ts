/**
 * @file render.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 流水线的渲染阶段：校验项目位置后驱动 Python/ffmpeg worker 出片，返回 manifest 记录的最终视频路径与完整日志；并提供渲染环境（ffmpeg/ffprobe/python3）就绪检查。
 * @see https://github.com/1241751430/AIVideo.git
 */

import { existsSync, renameSync } from "node:fs";
import { extname, resolve } from "node:path";
import { readRenderManifestFile } from "./renderManifest.js";
import { assertPathWithin, execFileAsync, ExecFileOptions, isWithinBase, nonEmptyFileExists } from "./utils.js";

/**
 * Render stage of the pipeline: drives the Python/ffmpeg worker over a
 * materialized project. Extracted from apps/cli so the workbench server gets
 * live stdout lines and abort support without spawning its own child handling.
 */

export interface RenderProjectInput {
  /** Absolute path of the configured projects root (`<cwd>/project` by default). */
  projectsRoot: string;
  /** Absolute path of the project to render; must live under `projectsRoot`. */
  projectDir: string;
  /** Absolute path of `workers/media/render.py`. */
  workerScript: string;
  useGpu?: boolean;
  /**
   * Forwarded to the child runner (heartbeat/line streaming/abort knobs).
   * `killProcessGroup` is opt-in: it starts the worker detached so an abort can
   * signal python *and* the ffmpeg it spawned. Callers that rely on the
   * terminal's Ctrl+C (the CLI) leave it off — a detached child would no
   * longer receive the terminal's SIGINT and would outlive the CLI.
   */
  exec?: Pick<
    ExecFileOptions,
    "statusMessage" | "heartbeatMs" | "onHeartbeat" | "onStdoutLine" | "signal" | "killProcessGroup"
  >;
}

export interface RenderProjectResult {
  /** Absolute path of the produced final video (from manifest `outputFile`). */
  videoPath: string;
  /** 上一版成片的项目内相对路径；本次是首渲、或旧成片不存在/为空时为 undefined。 */
  previousVideoPath?: string;
  /** Full worker stdout, for callers that want to print or archive it. */
  log: string;
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：由成片相对路径推出「上一版」备份路径：在扩展名前插一段 .prev（output/final.mp4 → output/final.prev.mp4）。
 * 只留一个槽位是有意的——重渲只是覆盖当前成片，用户真正需要的是「刚被覆盖的那一版还能拿回来」；
 * 完整的版本树会引入历史管理、清理策略和新的选择界面，代价远大于它解决的问题。
 * @param outputFile manifest 里的 outputFile（项目内相对路径）
 * @returns 备份文件的相对路径
 */
export function previousVideoRelativePath(outputFile: string): string {
  const ext = extname(outputFile);
  return ext ? `${outputFile.slice(0, -ext.length)}.prev${ext}` : `${outputFile}.prev`;
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染前把现有成片挪到 .prev 槽位，返回其相对路径；旧成片不存在、为空或路径越界时不动盘并返回 null。
 * 渲染失败时调用方负责把它还原回来（见 renderProject），否则失败一次就只剩备份、没有当前成片。
 */
function stashPreviousVideo(projectDir: string, outputFile: string): string | null {
  const current = resolve(projectDir, outputFile);
  if (!isWithinBase(projectDir, current) || !nonEmptyFileExists(current)) {
    return null;
  }
  const previousRelative = previousVideoRelativePath(outputFile);
  try {
    renameSync(current, resolve(projectDir, previousRelative));
    return previousRelative;
  } catch {
    return null;
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验 projectDir 未逃逸 projectsRoot 且 render-manifest.json 存在，然后以 python3 启动渲染 worker（可选 --gpu），完成后解析 manifest 返回最终视频绝对路径与完整日志。
 * 出片前先把旧成片挪到 .prev 槽位（单版本备份）：ffmpeg 是原地覆盖写，不先挪走，重渲就等于把上一版永久删掉。
 * 渲染失败时把备份原地放回，避免「重渲失败 → 当前成片也没了」这种比不重渲更糟的结果。
 * @throws 项目越界、manifest 缺失或 worker 非零退出时抛出错误
 */
/**
 * Validate the project location, spawn the render worker, and return the
 * final video path recorded in the manifest. Throws when the project escapes
 * `projectsRoot`, the manifest is missing, or the worker exits non-zero.
 */
export async function renderProject(input: RenderProjectInput): Promise<RenderProjectResult> {
  const { projectsRoot, projectDir, workerScript, useGpu, exec } = input;
  assertPathWithin(projectsRoot, projectDir, "Project directory");
  const manifestPath = resolve(projectDir, "render-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`render-manifest.json not found in ${projectDir}`);
  }
  const beforeManifest = readRenderManifestFile(projectDir);
  const previousVideoPath = beforeManifest?.outputFile
    ? stashPreviousVideo(projectDir, beforeManifest.outputFile)
    : null;
  const workerArgs = [workerScript, "--project-dir", projectDir, "--manifest", manifestPath];
  if (useGpu) {
    workerArgs.push("--gpu");
  }
  let log: string;
  try {
    log = await execFileAsync("python3", workerArgs, { ...exec });
  } catch (error) {
    if (previousVideoPath && beforeManifest?.outputFile) {
      // 新成片没写成（或只写了一半）：把备份放回原名，恢复成渲染前的样子。
      // rename 会直接覆盖目标，残缺产物不需要先删。
      const outputPath = resolve(projectDir, beforeManifest.outputFile);
      try {
        renameSync(resolve(projectDir, previousVideoPath), outputPath);
      } catch {
        // 还原失败就保持现状：备份仍在盘上，用户还能手动取回，比抛二次错误更有用。
      }
    }
    throw error;
  }
  const manifest = readRenderManifestFile(projectDir);
  if (!manifest) {
    throw new Error(`render-manifest.json missing or unreadable in ${projectDir} after render`);
  }
  return { videoPath: resolve(projectDir, manifest.outputFile), previousVideoPath: previousVideoPath ?? undefined, log };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：并行探测 ffmpeg/ffprobe/python3 是否可执行，任一缺失时抛出带安装指引（Docker 或 --dry-run）的错误。
 */
/** Throws with install guidance when ffmpeg/ffprobe/python3 are unusable. */
export async function ensureRenderEnvironmentReady(): Promise<void> {
  const required = ["ffmpeg", "ffprobe", "python3"];
  const checks = await Promise.all(
    required.map(async (command) => {
      try {
        await execFileAsync(command, command === "python3" ? ["--version"] : ["-version"]);
        return undefined;
      } catch {
        return command;
      }
    })
  );
  const missing = checks.filter((command): command is string => Boolean(command));
  if (missing.length > 0) {
    throw new Error(
      [
        `Video rendering requires ${required.join(", ")}.`,
        `Missing or unavailable: ${missing.join(", ")}.`,
        "Install the missing tools, run with Docker, or add --dry-run to generate only scripts and storyboards."
      ].join("\n")
    );
  }
}
