/**
 * @file render.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description CLI 渲染子命令封装：定位项目目录、调用渲染 worker 并输出成片摘要
 * @see https://github.com/1241751430/AIVideo.git
 */
import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AppConfig,
  assertPathWithin,
  ensureRenderEnvironmentReady,
  loadConfig,
  renderProject,
  resolveProjectDir
} from "@aivideo/core";
import { getBooleanOption, getStringOption } from "./options.js";

export { ensureRenderEnvironmentReady };

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：校验 --project 后确保渲染环境就绪并渲染成片，打印摘要
 * @param cwd 工作目录
 * @param options 命令行选项（读取 project / gpu）
 * @param preloadedConfig 已加载的配置，缺省时按 cwd 重新加载
 * @param onProgress 渲染心跳进度回调
 * @returns 成片视频文件的绝对路径
 */
/**
 * Render the project's final video via the Python/ffmpeg worker.
 * Returns the absolute path of the produced video file.
 */
export async function runRender(
  cwd: string,
  options: Record<string, string | boolean>,
  preloadedConfig?: AppConfig,
  onProgress?: (message: string) => void
): Promise<string> {
  const projectArg = getStringOption(options, "project");
  if (!projectArg) {
    throw new Error("render requires --project <project-id|path>");
  }
  const config = preloadedConfig ?? loadConfig(cwd);
  const projectsRoot = resolve(cwd, config.defaults.projectsDir);
  const projectDir = isAbsolute(projectArg)
    ? projectArg
    : resolveProjectDir(cwd, config.defaults.projectsDir, projectArg);
  assertPathWithin(projectsRoot, projectDir, "Project directory");
  if (!existsSync(resolve(projectDir, "render-manifest.json"))) {
    throw new Error(`render-manifest.json not found in ${projectDir}`);
  }

  await ensureRenderEnvironmentReady();

  const useGpu = getBooleanOption(options, "gpu") || config.defaults.gpu === true;
  console.log(`Rendering project: ${basename(projectDir)}${useGpu ? " (GPU accelerated)" : ""}`);
  const { videoPath, log } = await renderProject({
    projectsRoot,
    projectDir,
    workerScript: resolve(cwd, "workers", "media", "render.py"),
    useGpu,
    exec: {
      heartbeatMs: 5000,
      ...(onProgress
        ? { onHeartbeat: () => onProgress("ffmpeg 正在渲染视频，请耐心等待...") }
        : { statusMessage: "ffmpeg is rendering video, please wait..." })
    }
  });
  if (log) {
    process.stdout.write(log);
  }
  printVideoReadySummary(projectDir, videoPath);
  return videoPath;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：生成渲染完成摘要行（项目目录、视频路径、file 链接与后续步骤）
 * @param projectDir 项目目录
 * @param videoPath 成片视频路径
 * @returns 摘要文本行数组
 */
export function getVideoReadySummary(projectDir: string, videoPath: string): string[] {
  return [
    "Video generation complete.",
    `Project directory: ${projectDir}`,
    `Final video: ${videoPath}`,
    `Open file: ${pathToFileURL(videoPath).href}`,
    "",
    "Next steps:",
    "  Re-render:  ./aivideo render --project " + basename(projectDir),
    "  Cleanup:    ./aivideo cleanup --keep-days 7"
  ];
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：逐行打印渲染完成摘要
 */
export function printVideoReadySummary(projectDir: string, videoPath: string): void {
  for (const line of getVideoReadySummary(projectDir, videoPath)) {
    console.log(line);
  }
}
