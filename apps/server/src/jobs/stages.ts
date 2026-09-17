/**
 * @file stages.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 流水线四阶段对 @aivideo/core 的薄封装：脚本生成落盘、付费素材、旁白合成、ffmpeg 渲染；统一注入进度日志与取消信号。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { join } from "node:path";
import {
  AppConfig,
  GenerateRequest,
  ProviderSelection,
  ensureRenderEnvironmentReady,
  generateArtifacts,
  getSkillById,
  loadAssetArtifacts,
  materializeProject,
  prepareGeneratedAssets,
  renderProject,
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
 * 功能：把任务请求映射为 core 的 GenerateRequest（工作台不传图片与清理开关，产物一律持久化）。
 * @param job 任务实体
 */
export function toGenerateRequest(job: Job): GenerateRequest {
  const request = job.request;
  return {
    theme: request.theme,
    content: request.content,
    images: [],
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
 * 功能：是否存在任何远端（计费）提供者——guided 模式据此决定是否插入计费检查点。
 * @param providers 当前装配的提供者集合
 */
export function hasRemoteProviders(providers: ProviderSelection): boolean {
  return Boolean(
    (providers.text && providers.text.isRemote) ||
      (providers.image && providers.image.isRemote) ||
      (providers.video && providers.video.isRemote) ||
      (providers.speech && providers.speech.isRemote)
  );
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：真实流水线四阶段：script 阶段已有落盘分镜则直接复用（断点续跑即恢复机制）；assets/audio 复用 core 的续跑；render 用 AbortSignal 杀子进程、ffmpeg 的 Clip 进度行转成日志。
 */
export const defaultStages: StageRunner = {
  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：脚本阶段：选择 Skill、生成脚本与分镜并 materialize 落盘；storyboard 已存在时跳过（重启续跑不重复付费）。
   */
  async runScript(ctx) {
    ctx.signal.throwIfAborted();
    if (loadAssetArtifacts(ctx.projectDir)) {
      ctx.log("发现已有脚本与分镜，跳过生成（续跑复用）");
      return;
    }
    const providers = ctx.deps.providersFor(ctx.job.request.providerProfile);
    const request = toGenerateRequest(ctx.job);
    const skill = request.skill === "auto" ? await selectSkill(request, providers) : getSkillById(request.skill);
    if (!skill) {
      throw new Error(`Unknown skill: ${request.skill}`);
    }
    ctx.log(`选用模板：${skill.id}（${skill.name}）`);
    const artifacts = await generateArtifacts({ request, providers, skill });
    materializeProject(ctx.projectDir, artifacts);
    ctx.log(`脚本与分镜已生成：${artifacts.script.scenes.length} 个镜头`);
  },

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：素材阶段：按落盘分镜调用远端图/视频提供者，磁盘已有资产自动复用。
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
   * 功能：旁白阶段：逐镜合成配音，已有 wav 复用。
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
      reportProgress: ctx.log
    });
    ctx.log(`旁白阶段完成：合成 ${narration.synthesized}，复用 ${narration.reused}，失败 ${narration.failed}`);
  },

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：渲染阶段：确认 ffmpeg 环境后调用渲染 worker，取消时立即杀子进程；只把 "Clip i/N" 进度行转发到事件流以控制日志量。
   */
  async runRender(ctx) {
    ctx.signal.throwIfAborted();
    await ensureRenderEnvironmentReady();
    const { log } = await renderProject({
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
    ctx.log(`渲染完成（ffmpeg ${Math.max(0, log.split("\n").filter(Boolean).length)} 行输出）`);
  }
};
