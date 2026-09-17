/**
 * @file render.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 流水线的渲染阶段：校验项目位置后驱动 Python/ffmpeg worker 出片，返回 manifest 记录的最终视频路径与完整日志；并提供渲染环境（ffmpeg/ffprobe/python3）就绪检查。
 * @see https://github.com/1241751430/AIVideo.git
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RenderManifest } from "./types.js";
import { assertPathWithin, execFileAsync, ExecFileOptions } from "./utils.js";

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
  /** Forwarded to the child runner (heartbeat/line streaming/abort knobs). */
  exec?: Pick<ExecFileOptions, "statusMessage" | "heartbeatMs" | "onHeartbeat" | "onStdoutLine" | "signal">;
}

export interface RenderProjectResult {
  /** Absolute path of the produced final video (from manifest `outputFile`). */
  videoPath: string;
  /** Full worker stdout, for callers that want to print or archive it. */
  log: string;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验 projectDir 未逃逸 projectsRoot 且 render-manifest.json 存在，然后以 python3 启动渲染 worker（可选 --gpu），完成后解析 manifest 返回最终视频绝对路径与完整日志。
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
  const workerArgs = [workerScript, "--project-dir", projectDir, "--manifest", manifestPath];
  if (useGpu) {
    workerArgs.push("--gpu");
  }
  const log = await execFileAsync("python3", workerArgs, { ...exec });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RenderManifest;
  return { videoPath: resolve(projectDir, manifest.outputFile), log };
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
