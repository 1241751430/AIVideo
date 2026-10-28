/**
 * @file stages.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 流水线四阶段对 @aivideo/core 的薄封装：脚本生成落盘、付费素材、旁白合成、ffmpeg 渲染；统一注入进度日志与取消信号，复用判据一律为「输入指纹未变且产物仍在磁盘」。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { join, resolve } from "node:path";
import {
  AppConfig,
  GenerateRequest,
  ProviderSelection,
  RenderManifest,
  compareStageFingerprint,
  ensureRenderEnvironmentReady,
  generateArtifacts,
  getSkillById,
  loadAssetArtifacts,
  materializeProject,
  nonEmptyFileExists,
  prepareGeneratedAssets,
  readRenderManifestFile,
  readStageFingerprints,
  recordStageFingerprints,
  renderProject,
  renderStageFingerprint,
  scriptStageFingerprint,
  selectSkill,
  synthesizeNarration
} from "@aivideo/core";
import type { Job } from "../types.js";

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
      ctx.log("本地提供者可出片：素材阶段无需调用远端");
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
      speechProvider: providers.speech,
      force: ctx.job.force === "audio",
      language: artifacts.brief.language,
      reportProgress: ctx.log
    });
    ctx.log(`旁白阶段完成：合成 ${narration.synthesized}，复用 ${narration.reused}，失败 ${narration.failed}`);
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
        onStdoutLine: (line) => {
          if (line.startsWith("Clip ")) {
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
