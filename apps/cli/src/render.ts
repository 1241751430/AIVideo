import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AppConfig,
  assertPathWithin,
  execFileAsync,
  loadConfig,
  resolveProjectDir
} from "@aivideo/core";
import { getBooleanOption, getStringOption } from "./options.js";

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
  const manifestPath = resolve(projectDir, "render-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`render-manifest.json not found in ${projectDir}`);
  }

  await ensureRenderEnvironmentReady();

  const useGpu = getBooleanOption(options, "gpu") || config.defaults.gpu === true;
  const workerPath = resolve(cwd, "workers", "media", "render.py");
  const workerArgs = [workerPath, "--project-dir", projectDir, "--manifest", manifestPath];
  if (useGpu) {
    workerArgs.push("--gpu");
  }
  console.log(`Rendering project: ${basename(projectDir)}${useGpu ? " (GPU accelerated)" : ""}`);
  const stdout = await execFileAsync("python3", workerArgs, {
    heartbeatMs: 5000,
    ...(onProgress
      ? { onHeartbeat: () => onProgress("ffmpeg 正在渲染视频，请耐心等待...") }
      : { statusMessage: "ffmpeg is rendering video, please wait..." })
  });
  if (stdout) {
    process.stdout.write(stdout);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { outputFile: string };
  const finalVideoPath = resolve(projectDir, manifest.outputFile);
  printVideoReadySummary(projectDir, finalVideoPath);
  return finalVideoPath;
}

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

export function printVideoReadySummary(projectDir: string, videoPath: string): void {
  for (const line of getVideoReadySummary(projectDir, videoPath)) {
    console.log(line);
  }
}

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
