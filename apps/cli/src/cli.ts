import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import {
  BUILTIN_SKILLS,
  CONFIG_FILE,
  GenerateRequest,
  SUPPORTED_ASPECT_RATIOS,
  cleanupRenderWorkspace,
  cleanupExpiredProjects,
  createProjectId,
  generateArtifacts,
  getConfigTemplate,
  getEnvTemplate,
  loadConfig,
  loadDotEnv,
  materializeProject,
  resolveProjectDir,
  selectSkill,
  trimProjectArtifacts,
  validateConfig
} from "@aivideo/core";
import { createProviderSelection, testProviders } from "@aivideo/providers";

export interface ParsedArgs {
  command: string[];
  options: Record<string, string | boolean>;
}

interface WizardStep {
  key: string;
  label: string;
  prompt: string;
  required: boolean;
  defaultValue?: string;
  validate?: (value: string) => string | undefined;
}

class WizardCancelledError extends Error {}

const BRIEF_KEY_MAP: Record<string, string> = {
  theme: "theme",
  topic: "theme",
  title: "theme",
  "主题": "theme",
  "标题": "theme",
  content: "content",
  brief: "content",
  description: "content",
  "内容": "content",
  "主要内容": "content",
  "补充内容": "content",
  mode: "mode",
  "模式": "mode",
  "输出模式": "mode",
  skill: "skill",
  "模板": "skill",
  "风格模板": "skill",
  aspect: "aspect",
  ratio: "aspect",
  aspectratio: "aspect",
  "比例": "aspect",
  "视频比例": "aspect",
  duration: "duration",
  length: "duration",
  "时长": "duration",
  "视频时长": "duration",
  language: "language",
  lang: "language",
  "语言": "language",
  platform: "platform",
  "平台": "platform",
  profile: "provider-profile",
  provider: "provider-profile",
  providerprofile: "provider-profile",
  "模型配置": "provider-profile",
  "配置档": "provider-profile",
  image: "images",
  images: "images",
  "图片": "images",
  "参考图片": "images"
};

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

export async function runInit(cwd: string): Promise<void> {
  const configPath = resolve(cwd, CONFIG_FILE);
  const envExamplePath = resolve(cwd, ".env.example");
  const envPath = resolve(cwd, ".env");
  const projectsDir = resolve(cwd, "projects");

  if (!existsSync(configPath)) {
    writeFileSync(configPath, getConfigTemplate(cwd), "utf8");
  }
  if (!existsSync(envExamplePath)) {
    writeFileSync(envExamplePath, getEnvTemplate(cwd), "utf8");
  }
  if (!existsSync(envPath)) {
    writeFileSync(envPath, getEnvTemplate(cwd), "utf8");
  }
  mkdirSync(projectsDir, { recursive: true });

  console.log(`Initialized AI Video Agent in ${cwd}`);
  console.log(`- ${basename(configPath)}`);
  console.log(`- ${basename(envExamplePath)}`);
  console.log(`- ${basename(envPath)}`);
  console.log("- projects/");
}

function runSkillsList(): void {
  for (const skill of BUILTIN_SKILLS) {
    console.log(`${skill.id}\t${skill.name}\t${skill.description}`);
  }
}

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

async function runGenerate(cwd: string, options: Record<string, string | boolean>): Promise<void> {
  await autoInit(cwd);
  loadDotEnv(cwd);
  const config = loadConfig(cwd);
  for (const warning of validateConfig(config)) {
    console.warn(`[config] ${warning}`);
  }
  const request = buildGenerateRequest(config, cwd, options);
  const providers = createProviderSelection(config, getStringOption(options, "provider-profile"));
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
    console.log("Preparing video assets...");
    await synthesizeNarration(projectDir, artifacts.storyboard.shots, providers.speech);
    console.log("Starting video render. This may take a while...");
    await runRender(cwd, { project: projectDir }, config);
    if (request.cleanupAfterRender) {
      cleanupRenderWorkspace(projectDir);
    }
  }
}

async function autoInit(cwd: string): Promise<void> {
  const configPath = resolve(cwd, CONFIG_FILE);
  if (!existsSync(configPath)) {
    console.log("首次运行，自动初始化项目配置...");
    await runInit(cwd);
  }
}

async function runCreate(cwd: string): Promise<void> {
  await autoInit(cwd);
  const config = loadConfig(cwd);
  const rl = createInterface({ input, output });
  try {
    console.log("AI Video 快速创建");
    console.log("输入 /more 进入高级模式（逐项配置），/cancel 取消，/help 查看帮助\n");

    while (true) {
      const briefInput = (
        await rl.question("描述你想做的视频（支持结构化 brief 或自由描述）: ")
      ).trim();

      if (briefInput === "/cancel") {
        throw new WizardCancelledError();
      }
      if (briefInput === "/help") {
        console.log("Structured brief example:");
        console.log("主题：夏季防晒喷雾；主要内容：清爽不油腻；视频比例：9:16；视频时长：30s");
        console.log("你也可以直接描述，如：做一个 30 秒的夏季防晒产品视频。");
        console.log("如果需要参考图片，后面会继续询问是否上传。\n");
        continue;
      }
      if (briefInput === "/more") {
        await runCreateAdvanced(config, rl, cwd);
        return;
      }
      if (!briefInput) {
        await runCreateAdvanced(config, rl, cwd);
        return;
      }

      const options = parseStructuredBrief(briefInput);
      options.mode = "video";
      const defaultDuration = `${config.defaults.durationSeconds}s`;
      if (!options.duration) {
        const durationInput = (
          await rl.question(`视频时长 [${defaultDuration}]: `)
        ).trim();
        if (durationInput === "/cancel") {
          throw new WizardCancelledError();
        }
        if (durationInput) {
          if (!parseDuration(durationInput)) {
            console.log("时长格式不正确，使用默认值。");
          } else {
            options.duration = durationInput;
          }
        }
      }
      const uploadedImages = await collectImagesInteractively(rl, cwd);
      if (uploadedImages.length > 0) {
        options.images = uploadedImages.join(",");
      }
      console.log("开始制作视频...");
      await runGenerate(cwd, options);
      return;
    }
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      console.log("Interactive create cancelled.");
      return;
    }
    throw error;
  } finally {
    rl.close();
  }
}

async function runCreateAdvanced(
  config: ReturnType<typeof loadConfig>,
  rl: ReturnType<typeof createInterface>,
  cwd: string
): Promise<void> {
  console.log("高级模式：逐项配置");
  console.log("Commands: /back 上一步, /skip 跳过, /cancel 取消\n");

  const answers: Record<string, string> = {};
  const steps: WizardStep[] = [
    {
      key: "theme",
      label: "主题",
      prompt: "请输入视频主题",
      required: true
    },
    {
      key: "content",
      label: "主要内容",
      prompt: "请描述你想重点表达的内容，留空可跳过",
      required: false
    },
    {
      key: "skill",
      label: "Skill",
      prompt: `你想走哪种内容风格？留空自动选择。可选：${BUILTIN_SKILLS.map((skill) => skill.id).join("/")}`,
      required: false,
      defaultValue: "auto",
      validate: (value) =>
        value === "auto" || BUILTIN_SKILLS.some((skill) => skill.id === value) ? undefined : "skill 不合法"
    },
    {
      key: "aspect",
      label: "视频比例",
      prompt: `你希望视频比例是什么？可选：${SUPPORTED_ASPECT_RATIOS.join("、")}`,
      required: true,
      defaultValue: config.defaults.aspectRatio
    },
    {
      key: "duration",
      label: "视频时长",
      prompt: "你希望视频时长是多少？例如 15s、30s、60s",
      required: true,
      defaultValue: `${config.defaults.durationSeconds}s`,
      validate: (value) => (parseDuration(value) ? undefined : "时长格式不正确")
    },
    {
      key: "language",
      label: "语言",
      prompt: "内容语言是什么？留空自动识别",
      required: false
    },
    {
      key: "platform",
      label: "平台",
      prompt: "目标平台是什么？留空使用默认值",
      required: false,
      defaultValue: config.defaults.platform
    }
  ];

  let index = 0;
  while (index < steps.length) {
    const step = steps[index]!;
    const current = answers[step.key] ?? step.defaultValue ?? "";
    const suffix = current ? ` [当前: ${current}]` : "";
    const raw = (await rl.question(`(${index + 1}/${steps.length}) ${step.prompt}${suffix}: `)).trim();

    if (raw === "/cancel") {
      throw new WizardCancelledError();
    }
    if (raw === "/help") {
      console.log("Commands: /back 上一步, /skip 跳过当前项, /cancel 取消");
      continue;
    }
    if (raw === "/back") {
      if (index > 0) {
        index -= 1;
      }
      continue;
    }
    if (raw === "/skip") {
      if (step.required && !step.defaultValue) {
        console.log(`${step.label} 不能为空。`);
        continue;
      }
      if (step.defaultValue) {
        answers[step.key] = step.defaultValue;
      } else {
        delete answers[step.key];
      }
      index += 1;
      continue;
    }

    const value = raw || step.defaultValue || "";
    if (!value && step.required) {
      console.log(`${step.label} 不能为空。`);
      continue;
    }
    const error = step.validate?.(value);
    if (error) {
      console.log(error);
      continue;
    }
    if (value) {
      answers[step.key] = value;
    }
    index += 1;
  }

  const options: Record<string, string | boolean> = {};
  for (const key of ["theme", "content", "skill", "aspect", "duration", "language", "platform"]) {
    const value = answers[key];
    if (value !== undefined) {
      options[key] = value;
    }
  }
  options.mode = "video";

  const uploadedImages = await collectImagesInteractively(rl, cwd);
  if (uploadedImages.length > 0) {
    options.images = uploadedImages.join(",");
  }

  console.log("开始制作视频...");
  await runGenerate(cwd, options);
}

async function runRender(cwd: string, options: Record<string, string | boolean>, preloadedConfig?: ReturnType<typeof loadConfig>): Promise<string> {
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

  await Promise.all([ensureBinary("ffmpeg"), ensureBinary("ffprobe"), ensureBinary("python3")]);

  const useGpu = getBooleanOption(options, "gpu") || config.defaults.gpu === true;
  const workerPath = resolve(cwd, "workers", "media", "render.py");
  const workerArgs = [workerPath, "--project-dir", projectDir, "--manifest", manifestPath];
  if (useGpu) {
    workerArgs.push("--gpu");
  }
  console.log(`Rendering project: ${basename(projectDir)}${useGpu ? " (GPU accelerated)" : ""}`);
  await execFileAsync("python3", workerArgs, {
    statusMessage: "ffmpeg is rendering video, please wait...",
    heartbeatMs: 5000
  });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { outputFile: string };
  const finalVideoPath = resolve(projectDir, manifest.outputFile);
  printVideoReadySummary(projectDir, finalVideoPath);
  return finalVideoPath;
}

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

async function synthesizeNarration(
  projectDir: string,
  shots: Array<{ id: string; narration: string }>,
  speechProvider?: { synthesizeSpeech: (request: { text: string; outputPath: string }) => Promise<unknown> }
): Promise<void> {
  if (!speechProvider) {
    console.log("No speech provider configured. Rendering will use silent audio.");
    return;
  }

  console.log(`Synthesizing narration for ${shots.length} shot(s)...`);
  const tasks = shots.map((shot, index) => async () => {
    const audioPath = join(projectDir, "audio", `${shot.id}.aiff`);
    console.log(`- Narration ${index + 1}/${shots.length}: ${shot.id}`);
    try {
      await speechProvider.synthesizeSpeech({
        text: shot.narration,
        outputPath: audioPath
      });
    } catch (error) {
      console.log(`Speech synthesis skipped for ${shot.id}: ${(error as Error).message}`);
    }
  });
  await runConcurrent(tasks, 3);
}

async function runConcurrent(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const current = index++;
      await tasks[current]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token.startsWith("--")) {
      const [rawKey = "", inlineValue] = token.slice(2).split("=", 2);
      if (inlineValue !== undefined) {
        options[rawKey] = inlineValue;
        continue;
      }
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        options[rawKey] = true;
        continue;
      }
      options[rawKey] = next;
      index += 1;
      continue;
    }
    command.push(token);
  }

  return { command, options };
}

function getStringOption(options: Record<string, string | boolean>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function getBooleanOption(options: Record<string, string | boolean>, key: string): boolean {
  return options[key] === true || options[key] === "true";
}

async function collectImagesInteractively(
  rl: ReturnType<typeof createInterface>,
  cwd: string
): Promise<string[]> {
  const images: string[] = [];
  const wantsImages = await askYesNo(rl, "是否需要上传参考图片？(y/n，默认 n): ", false);
  if (!wantsImages) {
    return images;
  }

  while (true) {
    const pathInput = (await rl.question("请输入图片路径: ")).trim();
    if (pathInput === "/cancel") {
      throw new WizardCancelledError();
    }
    if (pathInput === "/help") {
      console.log("请输入本地图片路径，支持 png、jpg、jpeg、webp。");
      continue;
    }
    if (!pathInput) {
      console.log("图片路径不能为空。");
      continue;
    }
    try {
      const [imagePath] = parseImages(pathInput, cwd) ?? [];
      if (imagePath) {
        images.push(imagePath);
        console.log(`已添加图片：${imagePath}`);
      }
    } catch (error) {
      console.log((error as Error).message);
      continue;
    }

    const continueUpload = await askYesNo(rl, "是否继续上传图片？(y/n，默认 n): ", false);
    if (!continueUpload) {
      return images;
    }
  }
}

async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  defaultValue: boolean
): Promise<boolean> {
  while (true) {
    const raw = (await rl.question(prompt)).trim().toLowerCase();
    if (!raw) {
      return defaultValue;
    }
    if (raw === "/cancel") {
      throw new WizardCancelledError();
    }
    if (raw === "/help") {
      console.log("请输入 y/yes 或 n/no。");
      continue;
    }
    if (raw === "y" || raw === "yes" || raw === "是") {
      return true;
    }
    if (raw === "n" || raw === "no" || raw === "否") {
      return false;
    }
    console.log("请输入 y 或 n。");
  }
}

function normalizeInputOptions(
  options: Record<string, string | boolean>,
  cwd: string
): Record<string, string | boolean> {
  const merged: Record<string, string | boolean> = {};
  const briefFile = getStringOption(options, "brief-file");
  if (briefFile) {
    const briefPath = isAbsolute(briefFile) ? briefFile : resolve(cwd, briefFile);
    if (!existsSync(briefPath)) {
      throw new Error(`Brief file not found: ${briefPath}`);
    }
    Object.assign(merged, parseStructuredBrief(readFileSync(briefPath, "utf8")));
  }

  const brief = getStringOption(options, "brief");
  if (brief) {
    Object.assign(merged, parseStructuredBrief(brief));
  }

  return {
    ...merged,
    ...options
  };
}

export function parseStructuredBrief(input: string): Record<string, string> {
  const normalized = input.replace(/\r/g, "\n");
  const segments = normalized
    .split(/[;\n；]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const parsed: Record<string, string> = {};

  for (const segment of segments) {
    const match = segment.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
    if (!match) {
      continue;
    }
    const rawKey = normalizeBriefKey(match[1] ?? "");
    const rawValue = (match[2] ?? "").trim();
    const key = BRIEF_KEY_MAP[rawKey];
    if (!key || !rawValue) {
      continue;
    }
    parsed[key] = normalizeBriefValue(key, rawValue);
  }

  if (Object.keys(parsed).length === 0 && input.trim()) {
    parsed.theme = input.trim();
  }

  return parsed;
}

export function inferInputLanguage(parts: Array<string | undefined>): string | undefined {
  const text = parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ")
    .trim();
  if (!text) {
    return undefined;
  }

  if (/[一-龥]/u.test(text)) {
    return "zh-CN";
  }
  if (/[ぁ-ゖァ-ヺ]/u.test(text)) {
    return "ja-JP";
  }
  if (/[가-힣]/u.test(text)) {
    return "ko-KR";
  }
  if (/[Ѐ-ӿ]/u.test(text)) {
    return "ru-RU";
  }
  if (/[؀-ۿ]/u.test(text)) {
    return "ar";
  }
  if (/[A-Za-z]/.test(text)) {
    return "en-US";
  }

  return undefined;
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

function printVideoReadySummary(projectDir: string, videoPath: string): void {
  for (const line of getVideoReadySummary(projectDir, videoPath)) {
    console.log(line);
  }
}

function normalizeBriefKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[-_]/g, "");
}

function normalizeBriefValue(key: string, value: string): string {
  if (key === "mode") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "脚本" || normalized === "文案") {
      return "script";
    }
    if (normalized === "视频") {
      return "video";
    }
    return normalized;
  }

  if (key === "skill") {
    return value.trim().toLowerCase();
  }

  return value.trim();
}

const ALLOWED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

function parseImages(value: string | undefined, cwd: string): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const entries = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (isAbsolute(item) ? item : resolve(cwd, item)));
  for (const entry of entries) {
    if (!existsSync(entry)) {
      throw new Error(`Image not found: ${entry}`);
    }
    const ext = entry.slice(entry.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported image format: ${entry}`);
    }
    const size = statSync(entry).size;
    if (size > MAX_IMAGE_SIZE_BYTES) {
      throw new Error(`Image exceeds 10MB limit: ${entry}`);
    }
  }
  return entries;
}

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

function parseKeepDays(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function assertPathWithin(baseDir: string, candidatePath: string, label: string): void {
  const resolvedBase = resolve(baseDir);
  const resolvedCandidate = resolve(candidatePath);
  const rel = relative(resolvedBase, resolvedCandidate);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`${label} must stay within ${baseDir}.`);
  }
}

async function ensureBinary(command: string): Promise<void> {
  try {
    await execFileAsync(command, ["-version"]);
  } catch {
    throw new Error(`${command} is required for rendering but was not found in PATH.`);
  }
}

function printHelp(): void {
  console.log(`AI Video Agent CLI

Quick start:
  ./aivideo create                          Interactive quick create (recommended)
  ./aivideo generate --brief "主题：夏季防晒喷雾；视频时长：30s"

Commands:
  aivideo init                              Initialize project config (auto-runs on first create/generate)
  aivideo create                            Interactive video creation (quick mode by default, /more for advanced)
  aivideo skills list                       Show built-in content skills
  aivideo providers test [--profile name] [--live]
  aivideo generate --brief "..."            Non-interactive generation
  aivideo generate --brief-file ./brief.txt
  aivideo cleanup [--keep-days 7]           Remove expired projects
  aivideo render --project <id|path>        Re-render an existing project
Advanced generate flags:
  --theme --content --images --skill --mode --aspect --duration
  --language --platform --provider-profile --no-persist-artifacts --cleanup-after-render
  --dry-run                                 Generate script and storyboard without rendering
  --gpu                                     Enable GPU-accelerated video encoding (auto-detects encoder)

Interactive commands inside "aivideo create":
  /more     Switch to advanced step-by-step mode
  /back     Go back to previous step
  /skip     Skip current optional step
  /cancel   Cancel the wizard
  /help     Show help
`);
}

function execFileAsync(
  command: string,
  args: string[],
  options?: {
    statusMessage?: string;
    heartbeatMs?: number;
  }
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let heartbeat: NodeJS.Timeout | undefined;
    if (options?.statusMessage) {
      console.log(options.statusMessage);
      if (options.heartbeatMs && options.heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          console.log(options.statusMessage);
        }, options.heartbeatMs);
      }
    }

    execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      if (error) {
        const detail = [stderr, stdout].filter(Boolean).join("\n").trim();
        rejectPromise(new Error(detail || error.message));
        return;
      }
      if (stdout) {
        process.stdout.write(stdout);
      }
      resolvePromise();
    });
  });
}
