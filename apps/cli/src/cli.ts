/**
 * @file cli.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description AI Video CLI 命令入口：解析参数并分发 init/create/generate/providers/render/cleanup 等子命令
 * @see https://github.com/1241751430/AIVideo.git
 */
import * as p from "@clack/prompts";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  AppConfig,
  AssetArtifacts,
  BUILTIN_SKILLS,
  CONFIG_FILE,
  GenerateRequest,
  assertPathWithin,
  cleanupExpiredProjects,
  cleanupRenderWorkspace,
  createProjectId,
  generateArtifacts,
  getConfigTemplate,
  getEnvTemplate,
  loadAssetArtifacts,
  loadConfig,
  loadDotEnv,
  materializeProject,
  prepareGeneratedAssets,
  resolveProjectDir,
  selectSkill,
  synthesizeNarration,
  trimProjectArtifacts,
  validateConfig
} from "@aivideo/core";
import { createProviderSelection, testProviders } from "@aivideo/providers";
import {
  getBooleanOption,
  getStringOption,
  inferInputLanguage,
  normalizeInputOptions,
  parseArgs,
  parseDuration,
  parseImages,
  parseKeepDays
} from "./options.js";
import { ensureRenderEnvironmentReady, getVideoReadySummary, runRender } from "./render.js";
import { runCreateWizard } from "./wizard.js";

// Keep the historical CLI entry surface: index.test.ts (and any external
// caller) imports these helpers from "./cli.js" even though they now live in
// dedicated modules.
export { assertPathWithin, getVideoReadySummary, inferInputLanguage, parseArgs, parseDuration };
export { parseStructuredBrief } from "./options.js";
export type { ParsedArgs } from "./options.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：判断当前会话是否具备驱动 @clack 交互界面的 TTY 条件
 */
/** True when we can safely drive an @clack TUI over this session. */
function interactiveSession(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：CLI 主入口，解析命令行并分发到对应子命令处理函数
 * @param argv 命令行参数（默认取 process.argv 去头）
 * @param cwd 工作目录（默认 process.cwd()）
 */
export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.command.length === 0 || parsed.command[0] === "help" || parsed.options.help === true) {
    printHelp();
    return;
  }

  const [command, subcommand] = parsed.command;
  switch (`${command}:${subcommand ?? ""}`) {
    case "init:":
      await runInit(cwd);
      return;
    case "skills:list":
      runSkillsList();
      return;
    case "providers:test":
      await runProvidersTest(cwd, parsed.options);
      return;
    case "generate:":
      await runGenerate(cwd, parsed.options);
      return;
    case "create:":
      await runCreate(cwd);
      return;
    case "cleanup:":
      runCleanup(cwd, parsed.options);
      return;
    case "render:":
      await runRender(cwd, parsed.options);
      return;
    default:
      throw new Error(`Unknown command: ${parsed.command.join(" ")}`);
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：初始化工作目录——写入配置模板、.env(.example) 并创建 project 目录
 * @param cwd 工作目录
 */
export async function runInit(cwd: string): Promise<void> {
  const configPath = resolve(cwd, CONFIG_FILE);
  const envExamplePath = resolve(cwd, ".env.example");
  const envPath = resolve(cwd, ".env");
  const projectsDir = resolve(cwd, "project");
  const runningInContainer = process.env.AIVIDEO_CONTAINER === "1";

  if (!existsSync(configPath)) {
    writeFileSync(configPath, getConfigTemplate(cwd), "utf8");
  }
  if (!runningInContainer && !existsSync(envExamplePath)) {
    writeFileSync(envExamplePath, getEnvTemplate(cwd), "utf8");
  }
  if (!runningInContainer && !existsSync(envPath)) {
    writeFileSync(envPath, getEnvTemplate(cwd), "utf8");
  }
  mkdirSync(projectsDir, { recursive: true });

  console.log(`Initialized AI Video Agent in ${cwd}`);
  console.log(`- ${basename(configPath)}`);
  console.log(`- ${basename(envExamplePath)}`);
  console.log(`- ${basename(envPath)}`);
  console.log("- project/");
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：逐行列出内置内容 Skill 的 id、名称与描述
 */
function runSkillsList(): void {
  for (const skill of BUILTIN_SKILLS) {
    console.log(`${skill.id}\t${skill.name}\t${skill.description}`);
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：按保留天数清理过期项目目录并打印删除结果
 * @param cwd 工作目录
 * @param options 命令行选项（读取 keep-days）
 */
function runCleanup(cwd: string, options: Record<string, string | boolean>): void {
  const config = loadConfig(cwd);
  const keepDays = parseKeepDays(getStringOption(options, "keep-days")) ?? 7;
  const projectsRoot = resolve(cwd, config.defaults.projectsDir);
  const removed = cleanupExpiredProjects(projectsRoot, keepDays);
  console.log(`Removed ${removed.length} expired project(s).`);
  for (const item of removed) {
    console.log(`- ${item}`);
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：加载配置与环境变量，对 profile 内各提供者执行健康检查并逐行输出
 * @param cwd 工作目录
 * @param options 命令行选项（读取 profile / live）
 */
async function runProvidersTest(cwd: string, options: Record<string, string | boolean>): Promise<void> {
  loadDotEnv(cwd);
  const config = loadConfig(cwd);
  const profile = getStringOption(options, "profile");
  const live = getBooleanOption(options, "live");
  const results = await testProviders(config, profile, live);
  for (const result of results) {
    const status = result.ok ? "OK" : "WARN";
    console.log(
      `[${status}] ${result.capability}/${result.providerId} - ${result.message}${result.liveChecked ? " (live)" : ""}`
    );
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：generate 命令主体——支持续跑已有项目或全新生成，再依次完成素材、配音与渲染
 * @param cwd 工作目录
 * @param options 命令行选项（brief/theme/content/project/dry-run 等）
 */
async function runGenerate(cwd: string, options: Record<string, string | boolean>): Promise<void> {
  await autoInit(cwd);
  loadDotEnv(cwd);
  const config = loadConfig(cwd);
  for (const warning of validateConfig(config)) {
    console.warn(`[config] ${warning}`);
  }
  const providers = createProviderSelection(config, getStringOption(options, "provider-profile"));

  // Resume mode: --project points at an existing materialized project. The
  // storyboard/manifest on disk are reused verbatim (shot ids must stay stable
  // for the asset reuse below to hit), and only missing assets, narration, and
  // the render are (re)produced.
  let resumeProject = getStringOption(options, "project");
  if (!resumeProject && interactiveSession()) {
    // No input at all in a terminal: offer to resume an existing project
    // instead of failing with "theme or content required".
    const probe = buildGenerateRequest(config, cwd, options);
    if (!probe.theme && !probe.content) {
      const chosen = await chooseResumeProject(cwd, config);
      if (!chosen) {
        console.log('未选择项目。开始新项目请用 ./aivideo create 或 generate --brief "..."。');
        return;
      }
      resumeProject = chosen;
    }
  }
  if (resumeProject) {
    if (getBooleanOption(options, "dry-run")) {
      throw new Error("--project cannot be combined with --dry-run: the artifacts already exist on disk.");
    }
    const projectDir = resolveResumeProjectDir(cwd, config, resumeProject);
    const artifacts = loadAssetArtifacts(projectDir);
    if (!artifacts) {
      throw new Error(
        `Cannot resume ${projectDir}: storyboard.json and render-manifest.json must exist and be valid.`
      );
    }
    const request = buildGenerateRequest(config, cwd, options);
    if (request.mode !== "video") {
      throw new Error(`Resuming --project requires --mode video (got "${request.mode}").`);
    }
    // Resume never rewrites the artifact JSONs; just make sure the worker
    // directories exist so providers/narration can write into them.
    for (const child of ["assets", "audio", "captions", "output"]) {
      mkdirSync(join(projectDir, child), { recursive: true });
    }
    console.log(`Resuming project: ${projectDir}`);
    await ensureRenderEnvironmentReady();
    await runVideoPhase(projectDir, artifacts, providers, options, cwd, config, request);
    return;
  }

  const request = buildGenerateRequest(config, cwd, options);
  if (request.mode === "video" && !getBooleanOption(options, "dry-run")) {
    await ensureRenderEnvironmentReady();
  }
  console.log("Generating script and storyboard...");
  const skill = await selectSkill(request, providers);
  const artifacts = await generateArtifacts({ request, providers, skill });
  const seed = request.theme ?? request.content ?? skill.id;
  const projectId = createProjectId(seed);
  const projectDir = resolveProjectDir(cwd, config.defaults.projectsDir, projectId);

  materializeProject(projectDir, artifacts);
  if (request.persistArtifacts === false) {
    trimProjectArtifacts(projectDir);
  }
  console.log(`Project created: ${projectDir}`);
  console.log(`Selected skill: ${skill.id} (${skill.name})`);

  if (getBooleanOption(options, "dry-run")) {
    console.log("Dry run complete. Script and storyboard generated. Render skipped.");
    return;
  }

  if (request.mode === "video") {
    await runVideoPhase(projectDir, artifacts, providers, options, cwd, config, request);
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：用 TUI 列出最近修改的项目供用户选择续跑，取消时返回 undefined
 * @param cwd 工作目录
 * @param config 全局应用配置（用于定位 projects 根目录）
 */
/** TUI picker offering the most recently modified projects for resume. */
async function chooseResumeProject(cwd: string, config: AppConfig): Promise<string | undefined> {
  const projectsRoot = resolve(cwd, config.defaults.projectsDir);
  if (!existsSync(projectsRoot)) {
    return undefined;
  }
  const candidates = readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return { name: entry.name, mtime: statSync(join(projectsRoot, entry.name)).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { name: string; mtime: number } => Boolean(entry))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 8);
  if (candidates.length === 0) {
    console.log("还没有可续跑的项目。");
    return undefined;
  }
  const value = await p.select({
    message: "未检测到输入内容，选择一个已有项目续跑（只补缺失素材并渲染）",
    options: candidates.map((candidate) => ({
      value: candidate.name,
      label: `${candidate.name}（${new Date(candidate.mtime).toLocaleString()}）`
    }))
  });
  if (p.isCancel(value)) {
    return undefined;
  }
  return String(value);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：视频阶段总流程——准备场景素材、合成配音、渲染成片，并按需清理工作区
 * @param projectDir 项目目录
 * @param artifacts 已生成的脚本与分镜工件
 * @param providers 当前 profile 装配的提供者集合
 * @param options 命令行选项
 * @param cwd 工作目录
 * @param config 全局应用配置
 * @param request 归一化后的生成请求
 */
async function runVideoPhase(
  projectDir: string,
  artifacts: AssetArtifacts,
  providers: ReturnType<typeof createProviderSelection>,
  options: Record<string, string | boolean>,
  cwd: string,
  config: ReturnType<typeof loadConfig>,
  request: GenerateRequest
): Promise<void> {
  console.log("Preparing video assets...");
  const useSpinner = interactiveSession();
  const assetSpinner = useSpinner ? p.spinner() : undefined;
  assetSpinner?.start("正在生成场景素材...");
  let assetPrep;
  try {
    assetPrep = await prepareGeneratedAssets({
      projectDir,
      artifacts,
      providers,
      reportProgress: (message) => {
        if (assetSpinner) {
          assetSpinner.message(`正在生成场景素材：${message}`);
        } else {
          console.log(message);
        }
      }
    });
    assetSpinner?.stop("场景素材准备完成");
  } catch (error) {
    assetSpinner?.stop("场景素材生成失败");
    throw error;
  }
  if (assetPrep.attempted > 0) {
    const parts: string[] = [];
    if (assetPrep.reused > 0) {
      parts.push(`${assetPrep.reused} reused`);
    }
    if (assetPrep.videoSucceeded > 0) {
      parts.push(`${assetPrep.videoSucceeded} new video(s)`);
    }
    if (assetPrep.imageSucceeded > 0) {
      parts.push(`${assetPrep.imageSucceeded} new image(s)`);
    }
    const summary = parts.length > 0 ? `Prepared ${assetPrep.attempted} scene(s): ${parts.join(", ")}` : `Generated 0/${assetPrep.attempted} scene(s)`;
    console.log(summary + (assetPrep.failed > 0 ? `; ${assetPrep.failed} fell back to title cards.` : "."));
  }
  await synthesizeNarration({
    projectDir,
    shots: artifacts.storyboard.shots,
    speechProvider: providers.speech,
    reportProgress: (message) => console.log(message)
  });
  console.log("Starting video render. This may take a while...");
  const renderSpinner = useSpinner ? p.spinner() : undefined;
  renderSpinner?.start("ffmpeg 渲染中...");
  try {
    await runRender(
      cwd,
      { project: projectDir },
      config,
      renderSpinner ? (message) => renderSpinner.message(message) : undefined
    );
    renderSpinner?.stop("视频渲染完成");
  } catch (error) {
    renderSpinner?.stop("视频渲染失败");
    throw error;
  }
  if (request.cleanupAfterRender) {
    cleanupRenderWorkspace(projectDir);
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：解析 --project 续跑目标为项目目录，并校验其位于 projects 根目录内
 * @param cwd 工作目录
 * @param config 全局应用配置
 * @param projectArg --project 传入的项目 id 或路径
 * @returns 已存在的项目目录路径
 */
/**
 * Resolve a --project resume target the same way `render` does: absolute paths
 * pass through, bare ids resolve under the configured projects dir, and either
 * way the result must stay inside that dir.
 */
function resolveResumeProjectDir(cwd: string, config: AppConfig, projectArg: string): string {
  const projectsRoot = resolve(cwd, config.defaults.projectsDir);
  const projectDir = isAbsolute(projectArg)
    ? projectArg
    : resolveProjectDir(cwd, config.defaults.projectsDir, projectArg);
  assertPathWithin(projectsRoot, projectDir, "Project directory");
  if (!existsSync(projectDir)) {
    throw new Error(`Project directory not found: ${projectDir}`);
  }
  return projectDir;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：首次运行缺少配置文件时自动执行 init
 * @param cwd 工作目录
 */
async function autoInit(cwd: string): Promise<void> {
  const configPath = resolve(cwd, CONFIG_FILE);
  if (!existsSync(configPath)) {
    console.log("首次运行，自动初始化项目配置...");
    await runInit(cwd);
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：create 命令主体——自动初始化后进入交互向导，确认后转入 generate 流程
 * @param cwd 工作目录
 */
async function runCreate(cwd: string): Promise<void> {
  await autoInit(cwd);
  loadDotEnv(cwd);
  const config = loadConfig(cwd);
  const options = await runCreateWizard(cwd, config);
  if (!options) {
    // The wizard already announced the cancellation.
    return;
  }
  await runGenerate(cwd, options);
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把命令行选项与默认配置归一化为 GenerateRequest
 * @param config 全局应用配置（提供默认值）
 * @param cwd 工作目录（解析相对图片路径）
 * @param options 原始命令行选项
 */
function buildGenerateRequest(
  config: ReturnType<typeof loadConfig>,
  cwd: string,
  options: Record<string, string | boolean>
): GenerateRequest {
  const normalizedOptions = normalizeInputOptions(options, cwd);
  const images = parseImages(getStringOption(normalizedOptions, "images"), cwd);
  const inferredLanguage =
    getStringOption(normalizedOptions, "language") ??
    inferInputLanguage([
      getStringOption(normalizedOptions, "theme"),
      getStringOption(normalizedOptions, "content")
    ]) ??
    config.defaults.language;
  return {
    theme: getStringOption(normalizedOptions, "theme"),
    content: getStringOption(normalizedOptions, "content"),
    images,
    skill: getStringOption(normalizedOptions, "skill") ?? "auto",
    mode: (getStringOption(normalizedOptions, "mode") as GenerateRequest["mode"]) ?? "video",
    aspectRatio: getStringOption(normalizedOptions, "aspect") ?? config.defaults.aspectRatio,
    durationSeconds: parseDuration(getStringOption(normalizedOptions, "duration")) ?? config.defaults.durationSeconds,
    language: inferredLanguage,
    platform: getStringOption(normalizedOptions, "platform") ?? config.defaults.platform,
    persistArtifacts: !getBooleanOption(normalizedOptions, "no-persist-artifacts"),
    cleanupAfterRender: getBooleanOption(normalizedOptions, "cleanup-after-render")
  };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：打印 CLI 使用说明、命令列表与交互式模式提示
 */
function printHelp(): void {
  console.log(`AI Video Agent CLI

Quick start:
  ./aivideo create                          Interactive quick create (recommended)
  ./aivideo generate --brief "主题：夏季防晒喷雾；视频时长：30s"

Commands:
  aivideo init                              Initialize project config (auto-runs on first create/generate)
  aivideo create                            Interactive video creation (留空进入逐项高级模式)
  aivideo skills list                       Show built-in content skills
  aivideo providers test [--profile name] [--live]
  aivideo generate --brief "..."            Non-interactive generation
  aivideo generate --brief-file ./brief.txt
  aivideo generate --project <id|path>      Resume an interrupted run: reuse assets already on disk, generate only what is missing, then render
  aivideo cleanup [--keep-days 7]           Remove expired projects
  aivideo render --project <id|path>        Re-render an existing project
Advanced generate flags:
  --theme --content --images --skill --mode --aspect --duration
  --language --platform --provider-profile --no-persist-artifacts --cleanup-after-render
  --dry-run                                 Generate script and storyboard without rendering
  --gpu                                     Enable GPU-accelerated video encoding (auto-detects encoder)

Interactive mode ("aivideo create", @clack TUI):
  方向键选择，Enter 确认，Ctrl+C 取消
  文本输入 /back 返回上一步，/cancel 取消向导
  提交前会显示计费确认页（列出所选模型与远程计费项）
`);
}
