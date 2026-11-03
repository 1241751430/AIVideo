/**
 * @file stages.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 流水线四阶段对 @aivideo/core 的薄封装：脚本生成落盘、付费素材、旁白合成、ffmpeg 渲染；统一注入进度日志与取消信号，复用判据一律为「输入指纹未变且产物仍在磁盘」。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AppConfig,
  GenerateRequest,
  ProviderSelection,
  RenderManifest,
  compareStageFingerprint,
  describeAssetPrepSkip,
  ensureRenderEnvironmentReady,
  findProjectBgm,
  generateArtifacts,
  getSkillById,
  loadAssetArtifacts,
  loadScriptPackage,
  materializeProject,
  nonEmptyFileExists,
  prepareGeneratedAssets,
  projectBgmPath,
  readRenderManifestFile,
  readStageFingerprints,
  recordStageFingerprints,
  renderProject,
  renderStageFingerprint,
  scriptStageFingerprint,
  selectSkill,
  synthesizeNarration,
  toScriptMarkdown,
  writeJsonFile
} from "@aivideo/core";
import type { AssetArtifacts, AssetProvenance } from "@aivideo/core";
import type { Job } from "../types.js";
import { probeAudioDuration } from "./bgm-store.js";

/** 构造阶段上下文所需的服务端依赖。 */
export interface StageDeps {
  /** 仓库根目录（workers/media/render.py 的定位基准）。 */
  cwd: string;
  projectsRoot: string;
  config: AppConfig;
  /** 按 provider profile 取得提供者集合（缺 profile 时返回服务启动装配的那份）。 */
  providersFor: (profile?: string) => ProviderSelection;
}

/** 单个阶段的执行上下文。 */
export interface StageContext {
  deps: StageDeps;
  job: Job;
  projectDir: string;
  log: (message: string) => void;
  signal: AbortSignal;
}

/** 四阶段执行器接口：runner 依赖此契约，测试注入假实现。 */
export interface StageRunner {
  runScript(ctx: StageContext): Promise<void>;
  runAssets(ctx: StageContext): Promise<void>;
  runAudio(ctx: StageContext): Promise<void>;
  runRender(ctx: StageContext): Promise<void>;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把任务请求映射为 core 的 GenerateRequest（创建时上传的参考图经 inputImagePaths 透传；产物一律持久化）。
 * @param job 任务实体
 */
export function toGenerateRequest(job: Job): GenerateRequest {
  const request = job.request;
  return {
    theme: request.theme,
    content: request.content,
    images: request.inputImagePaths ?? [],
    skill: request.skill || "auto",
    mode: request.generationMode,
    aspectRatio: request.aspectRatio,
    durationSeconds: request.durationSeconds,
    language: request.language,
    platform: request.platform,
    ...(request.dialogue ? { dialogue: request.dialogue } : {}),
    persistArtifacts: true
  };
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：真实流水线四阶段：script 阶段按输入指纹判断是否复用已落盘分镜（无指纹的老项目仍按产物是否存在）；
 * assets/audio 由 core 逐镜按指纹复用；render 在「指纹 match 且成片仍存在」时跳过，用 AbortSignal 杀子进程并把 ffmpeg 的 Clip 进度行转成日志。
 */
export const defaultStages: StageRunner = {
  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：脚本阶段：选择 Skill、生成脚本与分镜并 materialize 落盘；输入指纹未变且产物仍在时跳过（重启续跑不重复调用远端模型），
   * 除非 job.force 显式要求重跑——「要不要重做」由调用方声明，产物存在只是必要条件。
   */
  async runScript(ctx) {
    ctx.signal.throwIfAborted();
    const providers = ctx.deps.providersFor(ctx.job.request.providerProfile);
    const request = toGenerateRequest(ctx.job);
    const current = scriptStageFingerprint(request);
    const recorded = readStageFingerprints(ctx.projectDir)?.script;
    if (
      ctx.job.force !== "script" &&
      compareStageFingerprint(recorded, current) !== "mismatch" &&
      loadAssetArtifacts(ctx.projectDir)
    ) {
      ctx.log("发现已有脚本与分镜，跳过生成（续跑复用）");
      return;
    }
    const skill = request.skill === "auto" ? await selectSkill(request, providers) : getSkillById(request.skill);
    if (!skill) {
      throw new Error(`Unknown skill: ${request.skill}`);
    }
    ctx.log(`选用模板：${skill.id}（${skill.name}）`);
    const artifacts = await generateArtifacts({ request, providers, skill });
    materializeProject(ctx.projectDir, artifacts);
    recordStageFingerprints(ctx.projectDir, { script: current });
    ctx.log(`脚本与分镜已生成：${artifacts.script.scenes.length} 个镜头`);
  },

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：素材阶段：按落盘分镜调用远端图/视频提供者；core 逐镜比对输入指纹（提示词/来源/宽高比/绑定参考图），未变且文件仍在则复用，force 时全部重做。
   */
  async runAssets(ctx) {
    ctx.signal.throwIfAborted();
    const artifacts = loadAssetArtifacts(ctx.projectDir);
    if (!artifacts) {
      throw new Error("storyboard.json/render-manifest.json missing — run the script stage first");
    }
    const providers = ctx.deps.providersFor(ctx.job.request.providerProfile);
    const prep = await prepareGeneratedAssets({
      projectDir: ctx.projectDir,
      artifacts,
      providers,
      force: ctx.job.force === "assets",
      reportProgress: ctx.log
    });
    if (prep.attempted > 0) {
      ctx.log(`素材阶段完成：尝试 ${prep.attempted}，复用 ${prep.reused}，新视频 ${prep.videoSucceeded}，新图片 ${prep.imageSucceeded}，失败回退 ${prep.failed}`);
    } else {
      // 空转必须说清楚原因：用户以为自己在等 AI 画图，实际在等一组标题卡。
      // 文案与 CLI 终端共用 core 的同一份，避免同一次空转给出两种解释。
      ctx.log(describeAssetPrepSkip(prep.skippedReason));
    }
  },

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：旁白阶段：逐镜合成配音；旁白文本/时长/语种未变且 wav 仍在则复用，force 时全部重做。
   */
  async runAudio(ctx) {
    ctx.signal.throwIfAborted();
    const artifacts = loadAssetArtifacts(ctx.projectDir);
    if (!artifacts) {
      throw new Error("storyboard.json missing — run the script stage first");
    }
    const providers = ctx.deps.providersFor(ctx.job.request.providerProfile);
    const narration = await synthesizeNarration({
      projectDir: ctx.projectDir,
      shots: artifacts.storyboard.shots,
      // 角色表决定每句台词用哪副嗓子；缺 script.json 时只是不解析角色音色，不影响旁白合成。
      roles: loadScriptPackage(ctx.projectDir)?.roles,
      speechProvider: providers.speech,
      force: ctx.job.force === "audio",
      language: artifacts.brief.language,
      reportProgress: ctx.log
    });
    ctx.log(`旁白阶段完成：合成 ${narration.synthesized}，复用 ${narration.reused}，失败 ${narration.failed}`);
    await resolveBackgroundMusic(ctx, artifacts);
  },

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：渲染阶段：先看指纹——素材/字幕/时长全未变且成片仍在时直接复用（不探测 ffmpeg、不重跑子进程）；
   * 否则确认 ffmpeg 环境后调用渲染 worker，取消时立即杀子进程，只把 "Clip i/N" 进度行转发到事件流以控制日志量。
   */
  async runRender(ctx) {
    ctx.signal.throwIfAborted();
    const manifest = readRenderManifest(ctx.projectDir);
    if (
      manifest &&
      ctx.job.force !== "render" &&
      nonEmptyFileExists(resolve(ctx.projectDir, manifest.outputFile)) &&
      compareStageFingerprint(
        readStageFingerprints(ctx.projectDir)?.render,
        renderStageFingerprint({ projectDir: ctx.projectDir, manifest })
      ) === "match"
    ) {
      ctx.log("成片与当前素材一致，跳过渲染（续跑复用）");
      return;
    }
    await ensureRenderEnvironmentReady();
    const { log, previousVideoPath } = await renderProject({
      projectsRoot: ctx.deps.projectsRoot,
      projectDir: ctx.projectDir,
      workerScript: join(ctx.deps.cwd, "workers", "media", "render.py"),
      useGpu: ctx.deps.config.defaults.gpu === true,
      exec: {
        signal: ctx.signal,
        // 服务端的子进程是 detached 的独立进程组：终端 Ctrl+C 只到服务端，由 abort 统一组杀
        // （python 与它派生的 ffmpeg 一起收掉）。CLI 不走这条路——那里要靠终端把 SIGINT 直接发给前台进程组。
        killProcessGroup: true,
        onStdoutLine: (line) => {
          // 只转存有信息量的行：ffmpeg 的错误输出走 stderr，这里的 stdout 正常只有进度与阶段提示。
          // WARNING 必须透传：降级（标题卡、静音、字幕烧录失败）全是靠它告诉用户的，
          // 吞掉就等于让「片子出了但不对劲」变成无迹可查。Mixing BGM 让「BGM 到底进去没有」可见。
          if (
            line.startsWith("Clip ") ||
            line.startsWith("Mixing BGM:") ||
            line.startsWith("WARNING:")
          ) {
            ctx.log(line);
          }
        }
      }
    });
    if (manifest) {
      recordStageFingerprints(ctx.projectDir, {
        render: renderStageFingerprint({ projectDir: ctx.projectDir, manifest })
      });
    }
    const summary = `渲染完成（ffmpeg ${Math.max(0, log.split("\n").filter(Boolean).length)} 行输出）`;
    ctx.log(
      previousVideoPath
        ? `${summary}；上一版成片已保留为 ${previousVideoPath}，可在交付面板下载`
        : summary
    );
  }
};

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：解析本片 BGM 的来源并落盘到 audio/bgm.<ext>（render.py 只认这个位置，不认 bgmStyle）。
 * 优先级：用户上传 > 音乐提供者按 bgmStyle 取。用户上传永远优先，force 也不覆盖它——那是用户的显式选择。
 * 「拿不到 BGM」不是错误：日志明示「本片无 BGM」，渲染照常进行（render.py 见不到 bgm 文件就是静音成片）。
 * 无论走哪条路都把「本片实际的曲子来源」落到 script.bgmProvenance（见 persistBgmProvenance）：它是交付物的一部分。
 * @param ctx 阶段上下文
 * @param artifacts 已落盘的素材产物（取 renderManifest 里的 bgmStyle 与成片时长）
 */
async function resolveBackgroundMusic(ctx: StageContext, artifacts: AssetArtifacts): Promise<void> {
  ctx.signal.throwIfAborted();

  // 用户上传的曲子优先级最高：它已在项目里，直接用它，不再向任何提供者要曲。
  const existing = findProjectBgm(ctx.projectDir);
  if (existing) {
    ctx.log(`使用项目自带背景音乐：${existing}`);
    await persistBgmProvenance(ctx, { kind: "user_uploaded", license: "user-provided" });
    reportBgmLength(ctx, existing, artifacts.renderManifest.durationSeconds);
    return;
  }

  const providers = ctx.deps.providersFor(ctx.job.request.providerProfile);
  const music = providers.music;
  const style = artifacts.renderManifest.bgmStyle;
  if (!music || !style) {
    ctx.log("本片无 BGM（未配置音乐来源）");
    await persistBgmProvenance(ctx, null);
    return;
  }

  // 目标扩展名先按 mp3 给：多数音乐提供者会遵守；本地曲库会保留素材自身的扩展名并返回实际路径。
  const requestedPath = projectBgmPath(ctx.projectDir, "mp3");
  let result: { outputPath: string } | null = null;
  try {
    result = await music.synthesizeMusic({
      prompt: style,
      outputPath: requestedPath,
      durationSeconds: artifacts.renderManifest.durationSeconds,
      style
    });
  } catch (error) {
    // 配乐失败不该让整片失败：BGM 是加分项，旁白与画面才是主体。
    ctx.log(`BGM 获取失败（${music.id}）：${error instanceof Error ? error.message : String(error)}；本片无 BGM`);
    await persistBgmProvenance(ctx, null);
    return;
  }

  // noop-music 会回显路径却不产文件：不复核就会把「没配乐」记成「已配乐」，用户听着没声音还查不到原因。
  if (!result || !nonEmptyFileExists(result.outputPath)) {
    ctx.log(`本片无 BGM（音乐提供者 ${music.id} 未产出可用曲目，风格「${style}」）`);
    await persistBgmProvenance(ctx, null);
    return;
  }

  // 打实际落盘路径而非假设的 .mp3：本地曲库保留素材自身扩展名（如 bgm.wav），说错扩展名会误导排查。
  ctx.log(`已配置背景音乐：${result.outputPath}（来源 ${music.id}，风格「${style}」）`);
  // 曲库复制来的记 library、模型现生成的记 ai_generated：由提供者自陈，缺省按 AI 生成——
  // 把一首模型生成的曲子标成「素材库」会让用户误以为它来自某个有明确许可的曲库。
  await persistBgmProvenance(ctx, { kind: music.provenanceKind ?? "ai_generated", provider: music.id });
  reportBgmLength(ctx, result.outputPath, artifacts.renderManifest.durationSeconds);
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把本片 BGM 的来源声明写进 script.json 并同步重写 script.md；传 null 表示本次没拿到曲子，删除旧声明。
 * 一律以「本次实际结果」为准而不是只增不减：用户删掉或换掉曲子后若不清掉旧声明，
 * 交付面板与 script.md 会继续宣称「已配乐」，与实际静音成片对不上——版权标注说错比缺失更伤信任。
 * 写盘失败只记日志不抛：它是附加信息，不该让整片生成失败（与 reportBgmLength 同一基调）。
 * @param ctx 阶段上下文
 * @param provenance 本次实际来源；null 表示本次无 BGM
 */
async function persistBgmProvenance(ctx: StageContext, provenance: AssetProvenance | null): Promise<void> {
  // AssetArtifacts 不含 script（BGM 解析发生在 audio 阶段，产物里只带了 brief/storyboard/renderManifest），
  // 因此这里读回磁盘再写回，和 updateScriptMeta 走同一条落盘路径（script.json + script.md 两写齐）。
  const script = loadScriptPackage(ctx.projectDir);
  if (!script) {
    return;   // 无 script.json 的旧项目：不凭空造一份出来
  }
  if (provenance) {
    script.bgmProvenance = provenance;
  } else if (!script.bgmProvenance) {
    return;   // 本来没有、现在也没有：不白写一次盘，落盘与升级前逐字节相同
  } else {
    delete script.bgmProvenance;
  }
  try {
    writeJsonFile(join(ctx.projectDir, "script.json"), script);
    writeFileSync(join(ctx.projectDir, "script.md"), toScriptMarkdown(script), "utf8");
  } catch (error) {
    ctx.log(`BGM 来源声明未能写入 script：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：曲子明显短于成片时把这件事说出来，而不是让用户听着循环两三遍自己去猜。
 * 刻意只告警不拒绝：render.py 用 `-stream_loop -1` 无限循环 BGM，短曲在功能上是成立的，
 * 上传时就 400 会把「10 秒的片头音效配 30 秒短片」这种合理需求也挡掉；何况创建卡片上传时还没有成片，时长根本无从比对。
 * 探测不到时长（本机没装 ffprobe）就静默跳过——环境缺失不该变成一条看不懂的告警。
 * @param ctx 阶段上下文
 * @param bgmPath BGM 绝对路径（可能是 audio/bgm.mp3 也可能是曲库复制来的其他扩展名）
 * @param filmSeconds 成片时长（秒），来自 render-manifest
 */
async function reportBgmLength(ctx: StageContext, bgmPath: string, filmSeconds: number): Promise<void> {
  let seconds: number | null;
  try {
    seconds = await probeAudioDuration(bgmPath);
  } catch {
    // 探测失败只说明这首曲子读不出时长，不影响它被 render.py 拿去混音；渲染阶段会给出真正的解码错误。
    return;
  }
  if (seconds === null || !Number.isFinite(filmSeconds) || filmSeconds <= 0) {
    return;
  }
  if (seconds < filmSeconds / 2) {
    ctx.log(`注意：背景音乐 ${seconds.toFixed(1)}s，短于成片 ${filmSeconds.toFixed(1)}s 的一半，渲染时会循环播放`);
  }
}

/**
 * @author zhangbaohong  @date 2026-10-27  @see https://github.com/1241751430/AIVideo.git
 * 功能：读取 render-manifest.json 用于渲染跳过判定；缺失、无法解析、shots 非数组或缺 outputFile 时返回 null（视为无法判定，照常渲染）。
 * 不复用 loadAssetArtifacts：渲染后项目会被瘦身（brief/script/storyboard 被删），渲染阶段仍需能读到清单。
 */
function readRenderManifest(projectDir: string): RenderManifest | null {
  const manifest = readRenderManifestFile(projectDir);
  if (!manifest || typeof manifest.outputFile !== "string" || !Array.isArray(manifest.shots)) {
    return null;
  }
  return manifest;
}
