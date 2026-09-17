/**
 * @file job-runner.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 任务引擎：FIFO 并发 1 的队列、job.json 状态机（queued/running/awaiting/done/failed/cancelled）、检查点推进与重做、取消、boot 重启恢复；它是 job.json 的唯一写者。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, ProviderSelection } from "@aivideo/core";
import { createProjectId } from "@aivideo/core";
import type { CheckpointKind, ExecMode, Job, JobDto, JobPhase, JobRequest, StageKind } from "../types.js";
import { EventHub, JobEventLog } from "./events.js";
import { scanProjects, writeJob } from "./job-store.js";
import { defaultStages, hasRemoteProviders, type StageContext, type StageDeps, type StageRunner } from "./stages.js";

/** JobRunner 的注入依赖（全部可测：routes 测试注入假 stages）。 */
export interface JobRunnerDeps {
  /** 仓库根目录。 */
  cwd: string;
  projectsRoot: string;
  config: AppConfig;
  providers: ProviderSelection;
  providersFor?: (profile?: string) => ProviderSelection;
  stages?: StageRunner;
  events?: EventHub;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：任务引擎：持有全部任务的内存权威状态并原子落盘 job.json；串行执行阶段，guided 模式在检查点暂停，cancel/review 驱动状态转移；boot 时恢复中断任务。
 */
export class JobRunner {
  private readonly deps: StageDeps;
  private readonly stages: StageRunner;
  private readonly events: EventHub;
  private readonly providersFor: (profile?: string) => ProviderSelection;
  private readonly jobs = new Map<string, Job>();
  private queue: string[] = [];
  private active: { jobId: string; controller: AbortController } | null = null;

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：注入依赖并装配默认阶段/总线/providers 解析器。
   * @param deps JobRunnerDeps
   */
  constructor(deps: JobRunnerDeps) {
    this.stages = deps.stages ?? defaultStages;
    this.events = deps.events ?? new EventHub();
    this.providersFor = deps.providersFor ?? (() => deps.providers);
    this.deps = {
      cwd: deps.cwd,
      projectsRoot: deps.projectsRoot,
      config: deps.config,
      providersFor: this.providersFor
    };
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：启动恢复：扫描项目目录，running 任务回队（从原阶段续跑，磁盘复用保证安全）、queued 任务重新排队，awaiting/done/failed/cancelled 保持原状，损坏 job.json 不自动执行。
   */
  boot(): void {
    for (const entry of scanProjects(this.deps.projectsRoot)) {
      if (!entry.job) {
        continue;
      }
      const job = entry.job;
      if (this.jobs.has(job.id)) {
        continue;
      }
      this.jobs.set(job.id, job);
      if (job.phase === "running") {
        job.resumeStage = job.stage;
        this.setStatus(job, { phase: "queued", stage: undefined, error: undefined });
      }
    }
    for (const job of this.jobs.values()) {
      if (job.phase === "queued" && !this.queue.includes(job.id)) {
        this.queue.push(job.id);
      }
    }
    this.pump();
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：创建任务（生成 projectId、落盘 job.json、入队并泵动执行），返回初始 Job。
   * @param input execMode + 归一化后的 JobRequest
   */
  create(input: { execMode: ExecMode; request: JobRequest }): Job {
    const projectId = createProjectId(input.request.theme ?? input.request.content ?? "project");
    const now = new Date().toISOString();
    const job: Job = {
      id: projectId,
      projectId,
      createdAt: now,
      updatedAt: now,
      execMode: input.execMode,
      phase: "queued",
      request: input.request
    };
    this.jobs.set(job.id, job);
    writeJob(this.deps.projectsRoot, job);
    this.emit(job, "status", { phase: "queued" });
    this.enqueue(job.id);
    return job;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：按 id 取内存中的任务实体。
   */
  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：任务的对外 DTO（附队列位次与项目目录存在性）。
   */
  dto(jobId: string): JobDto | null {
    const job = this.jobs.get(jobId);
    return job ? this.toDto(job) : null;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：全部已知任务的 DTO 列表，按创建时间倒序。
   */
  list(): JobDto[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((job) => this.toDto(job));
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：取消任务：排队中直接移出队列；运行中置为 cancelled 并 abort 信号（渲染子进程被立即杀，provider 调用在阶段边界生效）；等待中直接落 cancelled。
   * @returns 是否发生状态变化
   */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.phase === "done" || job.phase === "failed" || job.phase === "cancelled") {
      return false;
    }
    this.queue = this.queue.filter((id) => id !== jobId);
    this.setStatus(job, { phase: "cancelled", stage: undefined, checkpoint: undefined, resumeStage: undefined });
    if (this.active?.jobId === jobId) {
      this.active.controller.abort();
    }
    return true;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：检查点决策：approve 按 checkpoint 推进（script 后按是否存在远端计费插入 cost；final 后 done）；redo-stage 重新入队指定阶段；cancel 终止任务。
   * @param jobId 任务 id
   * @param decision approve | redo-stage | cancel
   * @param stage redo-stage 时的目标阶段
   * @returns 决策是否被接受
   */
  review(jobId: string, decision: "approve" | "redo-stage" | "cancel", stage?: StageKind): boolean {
    if (decision === "cancel") {
      return this.cancel(jobId);
    }
    const job = this.jobs.get(jobId);
    if (!job || job.phase !== "awaiting") {
      return false;
    }
    if (decision === "redo-stage") {
      if (!stage || !["script", "assets", "audio", "render"].includes(stage)) {
        return false;
      }
      this.beginRun(job, stage);
      return true;
    }
    switch (job.checkpoint) {
      case "script":
        if (job.request.generationMode === "script") {
          // 仅脚本产物：检查点通过后任务即完成。
          this.setStatus(job, {
            phase: "done",
            checkpoint: undefined,
            stage: undefined,
            result: { videoStale: false }
          });
        } else if (hasRemoteProviders(this.providersFor(job.request.providerProfile))) {
          this.setStatus(job, { phase: "awaiting", checkpoint: "cost" });
        } else {
          this.beginRun(job, "assets");
        }
        return true;
      case "cost":
        this.beginRun(job, "assets");
        return true;
      case "shots":
        this.beginRun(job, "audio");
        return true;
      case "audio":
        this.beginRun(job, "render");
        return true;
      case "final":
        this.setStatus(job, {
          phase: "done",
          checkpoint: undefined,
          stage: undefined,
          result: { videoStale: false }
        });
        return true;
      default:
        return false;
    }
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：任务是否正在执行或排队（删除项目前的闸门）。
   */
  isBusy(jobId: string): boolean {
    return this.active?.jobId === jobId || this.queue.includes(jobId);
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：从内存与队列中移除任务（调用方负责删除磁盘目录）。
   */
  forget(jobId: string): void {
    this.jobs.delete(jobId);
    this.queue = this.queue.filter((id) => id !== jobId);
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：事件总线（供 SSE 路由订阅）。
   */
  get eventHub(): EventHub {
    return this.events;
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：项目目录绝对路径。
   */
  projectDirOf(projectId: string): string {
    return join(this.deps.projectsRoot, projectId);
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：入队并泵动。
   */
  private enqueue(jobId: string): void {
    this.queue.push(jobId);
    this.pump();
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：检查点通过后重新入队执行指定阶段。
   */
  private beginRun(job: Job, stage: StageKind): void {
    job.resumeStage = stage;
    this.setStatus(job, { phase: "queued", checkpoint: undefined, stage: undefined });
    this.enqueue(job.id);
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：队列泵：无活动任务时取出队首执行（并发 1 是有意设计，渲染独占 ffmpeg）。
   */
  private pump(): void {
    if (this.active) {
      return;
    }
    while (this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      const job = this.jobs.get(jobId);
      if (job && job.phase === "queued") {
        void this.drive(jobId);
        return;
      }
    }
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：单任务驱动循环：queued → running:{resumeStage|script} → 逐阶段执行；auto 直行至 done，guided 在检查点停下；阶段异常置 failed；取消静默退出。
   */
  private async drive(jobId: string): Promise<void> {
    const controller = new AbortController();
    this.active = { jobId, controller };
    try {
      const job = this.jobs.get(jobId);
      if (!job || job.phase !== "queued") {
        return;
      }
      this.setStatus(job, { phase: "running", stage: job.resumeStage ?? "script", checkpoint: undefined });
      while (true) {
        const current = this.jobs.get(jobId);
        if (!current || current.phase !== "running" || !current.stage) {
          return;
        }
        const stage = current.stage;
        try {
          await this.runStage(current, stage, controller.signal);
        } catch (error) {
          // Re-read the phase from the map (a fresh reference defeats the
          // "running" narrowing): cancel() may have moved the job to
          // "cancelled" while the stage was awaiting.
          const phaseAfterError: JobPhase = this.jobs.get(jobId)?.phase ?? "cancelled";
          if (phaseAfterError === "cancelled") {
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          this.setStatus(current, { phase: "failed", stage: undefined, error: message });
          this.emit(current, "log", { message: `阶段 ${stage} 失败：${message}` });
          return;
        }
        const phaseAfterStage: JobPhase = this.jobs.get(jobId)?.phase ?? "cancelled";
        if (phaseAfterStage !== "running") {
          return;
        }
        current.resumeStage = undefined;
        const next = this.nextAfterStage(current, stage);
        if (next.kind === "stage") {
          this.setStatus(current, { phase: "running", stage: next.stage });
          continue;
        }
        if (next.kind === "await") {
          this.setStatus(current, { phase: "awaiting", stage: undefined, checkpoint: next.checkpoint });
          return;
        }
        this.setStatus(current, { phase: "done", stage: undefined, result: { videoStale: false } });
        this.emit(current, "log", { message: "任务完成" });
        return;
      }
    } finally {
      this.active = null;
      this.pump();
    }
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：执行一个阶段（构造 StageContext 并转发到注入的 StageRunner）。
   */
  private async runStage(job: Job, stage: StageKind, signal: AbortSignal): Promise<void> {
    const ctx: StageContext = {
      deps: this.deps,
      job,
      projectDir: this.projectDirOf(job.projectId),
      signal,
      log: (message) => this.emit(job, "log", { message })
    };
    this.emit(job, "log", { message: `开始阶段：${stage}` });
    switch (stage) {
      case "script":
        await this.stages.runScript(ctx);
        return;
      case "assets":
        await this.stages.runAssets(ctx);
        return;
      case "audio":
        await this.stages.runAudio(ctx);
        return;
      case "render":
        await this.stages.runRender(ctx);
        return;
    }
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：阶段完成后的转移：auto 依次 script→assets→audio→render→done；guided 每阶段后进入对应检查点。
   */
  private nextAfterStage(job: Job, stage: StageKind): { kind: "stage"; stage: StageKind } | { kind: "await"; checkpoint: CheckpointKind } | { kind: "done" } {
    // "script" 产物模式只要脚本与分镜：脚本阶段后直接收尾，不进入素材/旁白/渲染。
    if (job.request.generationMode === "script") {
      if (job.execMode === "guided" && stage === "script") {
        return { kind: "await", checkpoint: "script" };
      }
      return { kind: "done" };
    }
    if (job.execMode === "auto") {
      switch (stage) {
        case "script":
          return { kind: "stage", stage: "assets" };
        case "assets":
          return { kind: "stage", stage: "audio" };
        case "audio":
          return { kind: "stage", stage: "render" };
        case "render":
          return { kind: "done" };
      }
      return { kind: "done" };
    }
    switch (stage) {
      case "script":
        return { kind: "await", checkpoint: "script" };
      case "assets":
        return { kind: "await", checkpoint: "shots" };
      case "audio":
        return { kind: "await", checkpoint: "audio" };
      case "render":
        return { kind: "await", checkpoint: "final" };
    }
    return { kind: "done" };
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：变更任务字段、刷新 updatedAt、原子落盘并广播 status 事件。
   */
  private setStatus(
    job: Job,
    patch: Partial<Pick<Job, "phase" | "stage" | "checkpoint" | "resumeStage" | "error" | "result">>
  ): void {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    writeJob(this.deps.projectsRoot, job);
    this.emit(job, "status", {
      phase: job.phase,
      stage: job.stage,
      checkpoint: job.checkpoint,
      error: job.error
    });
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：追加事件到 events.jsonl 并向进程内监听者广播。
   */
  private emit(job: Job, type: "status" | "log", data: Record<string, unknown>): void {
    const log = new JobEventLog(this.projectDirOf(job.projectId));
    const event = log.append(type, data);
    this.events.publish(job.id, event);
  }

  /**
   * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
   * 功能：Job → JobDto（补队列位次与目录存在性）。
   */
  private toDto(job: Job): JobDto {
    const position = this.queue.indexOf(job.id);
    return {
      ...job,
      queuePosition: position >= 0 ? position + 1 : undefined,
      hasProjectDir: existsSync(this.projectDirOf(job.projectId))
    };
  }
}
