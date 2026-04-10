import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  BUILTIN_SKILLS,
  CONFIG_FILE,
  GenerateRequest,
  createProjectId,
  generateArtifacts,
  getConfigTemplate,
  getEnvTemplate,
  loadConfig,
  loadDotEnv,
  materializeProject,
  resolveProjectDir,
  selectSkill
} from "@aivideo/core";
import { createProviderSelection, testProviders } from "@aivideo/providers";

export interface ParsedArgs {
  command: string[];
  options: Record<string, string | boolean>;
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.command.length === 0 || parsed.command[0] === "help") {
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
    writeFileSync(configPath, getConfigTemplate(), "utf8");
  }
  if (!existsSync(envExamplePath)) {
    writeFileSync(envExamplePath, getEnvTemplate(), "utf8");
  }
  if (!existsSync(envPath)) {
    writeFileSync(envPath, getEnvTemplate(), "utf8");
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
  loadDotEnv(cwd);
  const config = loadConfig(cwd);
  const request = buildGenerateRequest(config, cwd, options);
  const providers = createProviderSelection(config, getStringOption(options, "provider-profile"));
  const skill = await selectSkill(request, providers);
  const artifacts = await generateArtifacts({ request, providers, skill });
  const seed = request.theme ?? request.content ?? skill.id;
  const projectId = createProjectId(seed);
  const projectDir = resolveProjectDir(cwd, config.defaults.projectsDir, projectId);

  materializeProject(projectDir, artifacts);
  console.log(`Project created: ${projectDir}`);
  console.log(`Selected skill: ${skill.id} (${skill.name})`);

  if (request.mode === "video") {
    await synthesizeNarration(projectDir, artifacts.storyboard.shots, providers.speech);
    await runRender(cwd, { project: projectDir });
  }
}

async function runRender(cwd: string, options: Record<string, string | boolean>): Promise<void> {
  const projectArg = getStringOption(options, "project");
  if (!projectArg) {
    throw new Error("render requires --project <project-id|path>");
  }
  const config = loadConfig(cwd);
  const projectsRoot = resolve(cwd, config.defaults.projectsDir);
  const projectDir = isAbsolute(projectArg)
    ? projectArg
    : resolveProjectDir(cwd, config.defaults.projectsDir, projectArg);
  assertPathWithin(projectsRoot, projectDir, "Project directory");
  const manifestPath = resolve(projectDir, "render-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`render-manifest.json not found in ${projectDir}`);
  }

  await ensureBinary("ffmpeg");
  await ensureBinary("ffprobe");

  const workerPath = resolve(cwd, "workers", "media", "render.py");
  await execFileAsync("python3", [workerPath, "--project-dir", projectDir, "--manifest", manifestPath]);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { outputFile: string };
  console.log(`Rendered video: ${resolve(projectDir, manifest.outputFile)}`);
}

function buildGenerateRequest(
  config: ReturnType<typeof loadConfig>,
  cwd: string,
  options: Record<string, string | boolean>
): GenerateRequest {
  const images = parseImages(getStringOption(options, "images"), cwd);
  return {
    theme: getStringOption(options, "theme"),
    content: getStringOption(options, "content"),
    images,
    skill: getStringOption(options, "skill") ?? "auto",
    mode: (getStringOption(options, "mode") as GenerateRequest["mode"]) ?? "video",
    aspectRatio: getStringOption(options, "aspect") ?? config.defaults.aspectRatio,
    durationSeconds: parseDuration(getStringOption(options, "duration")) ?? config.defaults.durationSeconds,
    language: getStringOption(options, "language") ?? config.defaults.language,
    platform: getStringOption(options, "platform") ?? config.defaults.platform
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

  for (const shot of shots) {
    const audioPath = join(projectDir, "audio", `${shot.id}.aiff`);
    try {
      await speechProvider.synthesizeSpeech({
        text: shot.narration,
        outputPath: audioPath
      });
    } catch (error) {
      console.log(`Speech synthesis skipped for ${shot.id}: ${(error as Error).message}`);
    }
  }
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

export function assertPathWithin(baseDir: string, candidatePath: string, label: string): void {
  const resolvedBase = resolve(baseDir);
  const resolvedCandidate = resolve(candidatePath);
  const rel = relative(resolvedBase, resolvedCandidate);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
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

Commands:
  aivideo init
  aivideo skills list
  aivideo providers test [--profile default] [--live]
  aivideo generate --theme "..." [--content "..."] [--images a.png,b.png] [--skill auto] [--mode script|video] [--aspect 9:16] [--duration 30s] [--language zh-CN] [--platform douyin] [--provider-profile default]
  aivideo render --project <project-id|path>
`);
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(stderr || error.message));
        return;
      }
      if (stdout) {
        process.stdout.write(stdout);
      }
      resolvePromise();
    });
  });
}
