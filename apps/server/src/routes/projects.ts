/**
 * @file projects.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 项目/任务路由：创建（brief 解析 + 校验 + 把分片上传会话里的参考图按序搬进 input/、把会话里的背景音乐搬进 audio/）、列表（任务 + 无任务旧目录 + 损坏隔离）、详情、删除、取消、检查点决策、工件快照（含按 render-manifest 每镜 assetKind 推导的画面模式 assetMode）与 SSE 事件流。
 * 另含换曲/清曲两个端点：任务跑起来之后，BGM 只能靠它们替换（创建时选中的曲子走创建请求本身）。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Hono } from "hono";
import {
  createProjectId,
  findProjectBgm,
  isValidProjectId,
  nonEmptyFileExists,
  previousVideoRelativePath,
  readRenderManifestFile,
  shotImageRelative,
  shotVideoRelative
} from "@aivideo/core";
import { MAX_BGM_BYTES } from "@aivideo/shared";
import type { ExecMode, JobRequest, ProjectListItem } from "../types.js";
import { sseFrame } from "../jobs/events.js";
import { removeProject, scanProjects } from "../jobs/job-store.js";
import { isStageKind } from "../jobs/transitions.js";
import { buildJobRequest, bgmUploadIdOf, uploadIdOf } from "./create-request.js";
import { UploadError, consumeUploadSession, removeUploadSession } from "../jobs/upload-store.js";
import { consumeUploadBgm, receiveBgm, removeProjectBgm } from "../jobs/bgm-store.js";
import { guardEditable } from "./guard.js";
import type { ServerDeps } from "../app.js";

export type { ProjectListItem } from "../types.js";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：构建项目/任务路由并挂载到 /api/projects。
 * @param deps 服务依赖
 * @returns Hono 子应用
 */
export function projectRoutes(deps: ServerDeps): Hono {
  const router = new Hono();

  router.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return c.json({ error: "JSON body required" }, 400);
    }
    let request: JobRequest;
    let execMode: ExecMode;
    let projectId: string | undefined;
    let uploadId: string | undefined;
    let bgmUploadId: string | undefined;
    try {
      const parsed = buildJobRequest(deps.config, body);
      request = parsed.request;
      execMode = parsed.execMode;
      uploadId = uploadIdOf(body);
      bgmUploadId = bgmUploadIdOf(body);
      if (uploadId || bgmUploadId) {
        // 先预生成 projectId 再把会话里的素材搬进项目，最后才建任务；createProjectId 含时间戳+uuid，无撞名竞态。
        // 曲子和参考图各占一个会话，谁先搬都不影响对方——任务一创建就入队开跑，
        // 那时 PUT /:id/bgm 已被 guardEditable 挡成 409，曲子只能在这一次请求里落定。
        projectId = createProjectId(request.theme ?? request.content ?? "project");
        if (bgmUploadId) {
          consumeUploadBgm(deps.projectsRoot, projectId, bgmUploadId);
        }
        if (uploadId) {
          request.inputImagePaths = consumeUploadSession(deps.projectsRoot, projectId, uploadId);
        }
      }
    } catch (error) {
      if (projectId) {
        rmSync(join(deps.projectsRoot, projectId), { recursive: true, force: true });
      }
      // 会话异常（缺张/已过期）时一并销毁：半消费的会话再重试只会继续报缺张，不如让客户端整批重传。
      if (uploadId) {
        removeUploadSession(deps.projectsRoot, uploadId);
      }
      if (bgmUploadId) {
        removeUploadSession(deps.projectsRoot, bgmUploadId);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    const job = deps.runner.create({ execMode, request, projectId });
    // 曲子那个会话未必会被 consumeUploadSession 收尾：用户可能只选了曲子没选图（uploadId 为空），
    // 或者图与曲共用一个会话（那时上面已经删过了，这里是幂等的空操作）。
    // 不补这一下，曲子会话会留下一个空目录躺到 24h TTL 才被扫走。
    if (bgmUploadId) {
      removeUploadSession(deps.projectsRoot, bgmUploadId);
    }
    return c.json({ job: deps.runner.dto(job.id) }, 201);
  });

  router.get("/", (c) => {
    const items: ProjectListItem[] = deps.runner.list().map((job) => ({
      projectId: job.projectId,
      kind: "job" as const,
      job,
      updatedAt: job.updatedAt
    }));
    const known = new Set(items.map((item) => item.projectId));
    for (const entry of scanProjects(deps.projectsRoot)) {
      if (known.has(entry.projectId)) {
        continue;
      }
      if (entry.corrupt) {
        items.push({ projectId: entry.projectId, kind: "corrupt" });
        continue;
      }
      items.push({
        projectId: entry.projectId,
        kind: "project",
        title: readProjectTitle(entry.projectId, deps) ?? undefined,
        hasVideo: hasRenderedVideo(entry.projectId, deps),
        updatedAt: directoryMtime(deps.projectsRoot, entry.projectId)
      });
    }
    items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return c.json({ projects: items });
  });

  router.get("/:id", (c) => {
    const id = c.req.param("id");
    const dto = deps.runner.dto(id);
    if (!dto) {
      return c.json({ error: "Unknown project" }, 404);
    }
    return c.json({ project: dto });
  });

  router.delete("/:id", (c) => {
    const id = c.req.param("id");
    if (!isValidProjectId(id)) {
      return c.json({ error: "Invalid project id" }, 400);
    }
    if (deps.runner.isBusy(id)) {
      return c.json({ error: "任务进行中，请先取消" }, 409);
    }
    const known = deps.runner.get(id) ?? null;
    const dir = join(deps.projectsRoot, id);
    if (!known && !existsSync(dir)) {
      return c.json({ error: "Unknown project" }, 404);
    }
    deps.runner.forget(id);
    removeProject(deps.projectsRoot, id);
    return c.json({ ok: true });
  });

  router.post("/:id/cancel", (c) => {
    const ok = deps.runner.cancel(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "Task is not cancellable" }, 409);
  });

  router.post("/:id/review", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { decision?: string; stage?: string } | null;
    const decision = body?.decision;
    if (decision !== "approve" && decision !== "cancel" && decision !== "redo-stage") {
      return c.json({ error: "decision must be approve|cancel|redo-stage" }, 400);
    }
    const stage = body?.stage;
    // 只接受真实阶段名：加 as never 会把非法值一路送到 runner，靠 runner 再拒一次——两处判据容易走偏。
    if (decision === "redo-stage" && !isStageKind(stage)) {
      return c.json({ error: "redo-stage requires a valid stage" }, 400);
    }
    const ok = deps.runner.review(c.req.param("id"), decision, isStageKind(stage) ? stage : undefined);
    return ok ? c.json({ ok: true }) : c.json({ error: "Not awaiting a checkpoint" }, 409);
  });

  /**
   * 换曲/清曲：请求体即音频二进制，与参考图上传同一套「流式落盘 + 魔数嗅探 + 原子改名」。
   * 不做 multipart：单文件、单请求，multipart 只会为了一个字段名引入一个解析器。
   */
  router.put("/:id/bgm", async (c) => {
    const guard = guardEditable(deps, c.req.param("id"));
    if (!guard.ok) {
      return c.json({ error: guard.error }, guard.status);
    }
    // 先用 Content-Length 挡掉明显超限的请求体：不必白读 20MB 以上的字节再判超限。
    const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_BGM_BYTES) {
      return c.json({ error: `背景音乐不能超过 ${MAX_BGM_BYTES / (1024 * 1024)}MB` }, 413);
    }
    try {
      const bgm = await receiveBgm(guard.projectDir, c.req.raw.body);
      // 换了曲子，成片里的混音就不再是这一版：标脏让界面提示「可重新渲染」。
      // 指纹那边也会因为文件变了而失配，所以即便用户直接点续跑，渲染阶段也不会被跳过。
      deps.runner.markVideoStale(guard.job.id);
      return c.json({ bgm });
    } catch (error) {
      if (error instanceof UploadError) {
        return c.json({ error: error.message }, error.status);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  router.delete("/:id/bgm", (c) => {
    const guard = guardEditable(deps, c.req.param("id"));
    if (!guard.ok) {
      return c.json({ error: guard.error }, guard.status);
    }
    // 幂等：本来就没有 BGM 也回 200——客户端重试、连点两下都不该看到错误。
    const removed = removeProjectBgm(guard.projectDir).map((file) => file.slice(guard.projectDir.length + 1));
    if (removed.length > 0) {
      deps.runner.markVideoStale(guard.job.id);
    }
    return c.json({ ok: true, removed });
  });

  router.get("/:id/artifacts", (c) => {
    const id = c.req.param("id");
    // 非法 id 直接拒绝：下面要按它拼路径并 readFileSync，不能让它越过 projectsRoot。
    if (!isValidProjectId(id)) {
      return c.json({ error: "Invalid project id" }, 400);
    }
    const project = deps.runner.get(id);
    const dir = deps.runner.projectDirOf(id);
    if (!project && !existsSync(dir)) {
      return c.json({ error: "Unknown project" }, 404);
    }
    const readJson = (name: string): unknown => {
      try {
        return JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        return null;
      }
    };
    const storyboard = readJson("storyboard.json") as { shots?: Array<Record<string, unknown>> } | null;
    // 盘上可能是 input/state 分节的 v1，也可能还是老项目的扁平清单；统一归一化后原样回给前端。
    const manifest = readRenderManifestFile(dir);
    const script = readJson("script.json");
    const brief = readJson("brief.json");
    // 全片 BGM 的来源声明就写在 script.json 里（audio 阶段落的），这里原样抬到快照顶层：
    // 交付面板要在「BGM 那一行」与「素材来源清单」两处各渲染一次，前端就不必每处都去断言 script 的形状。
    // 只认普通对象——script.json 是用户可以手改的文件，形状不可信；其余一律按「未登记」处理，绝不在读侧补字段。
    const scriptBgm = (script as { bgmProvenance?: unknown } | null)?.bgmProvenance;
    const bgmProvenance =
      scriptBgm && typeof scriptBgm === "object" && !Array.isArray(scriptBgm)
        ? (scriptBgm as Record<string, unknown>)
        : null;
    const fileExists = (absolutePath: string): boolean => nonEmptyFileExists(absolutePath);
    const exists = (relative: string): boolean => fileExists(resolve(dir, relative));
    // 本片画面的实际来源模式：只看 render-manifest 每镜的 assetKind——那是素材阶段亲手写下的
    // 「这一镜最后拿到了什么」，比分镜里的声明更贴近实际（远端失败回退标题卡时 assetKind 就停在 generated-card）。
    // 老格式条目可能根本没有 assetKind（normalizeRenderManifest 原样透传、不补默认值），一律按标题卡计；
    // 非枚举的历史值（如 "generated-image"）只要不是 generated-card 就算真实画面。
    // 脚本模式不产画面、或清单里还没有镜头时给 null：那时没有「画面模式」可谈，界面据此不渲染提示。
    const shotKinds =
      project?.request.generationMode === "script"
        ? []
        : (manifest?.shots ?? []).map((entry) => entry.assetKind as string | undefined);
    const cardShotCount = shotKinds.filter((kind) => kind === undefined || kind === "generated-card").length;
    const assetMode =
      shotKinds.length === 0
        ? null
        : cardShotCount === 0
          ? ("generated" as const)
          : cardShotCount === shotKinds.length
            ? ("title-card" as const)
            : ("mixed" as const);
    // 重渲是覆盖式操作（见 renderProject 里的 .prev 备份）：把上一版的位置也一并算出来，
    // 用户才有机会在覆盖后取回旧成片。没有 manifest 就没有「上一版」这个概念。
    const previousCandidate = manifest?.outputFile ? previousVideoRelativePath(manifest.outputFile) : null;
    const previousFile = previousCandidate && exists(previousCandidate) ? previousCandidate : null;
    const shots = (manifest?.shots ?? []).map((entry) => {
      const shotId = String(entry.shotId ?? "");
      const shotVideo = shotVideoRelative(shotId);
      const shotImage = shotImageRelative(shotId);
      const audioRelative = `audio/${shotId}.wav`;
      return {
        ...entry,
        storyboard: (storyboard?.shots ?? []).find((s) => s.id === shotId) ?? null,
        files: {
          video: exists(shotVideo) ? shotVideo : null,
          image: exists(shotImage) ? shotImage : null,
          audio: exists(audioRelative) ? audioRelative : null,
          manifestAsset: serveableAssetPath(dir, entry.assetPath)
        }
      };
    });
    return c.json({
      brief,
      script,
      bgmProvenance,
      storyboard,
      manifest,
      assetMode,
      shots,
      bgm: findProjectBgm(dir),
      videoReady: manifest?.outputFile ? exists(resolve(dir, manifest.outputFile)) : false,
      // 这两份是「可交付但只在磁盘上」的产物：交付面板要给出下载入口，就得先知道盘上有没有。
      // 走同一套 fileExists 口径（存在且非空），避免把 0 字节的残留文件当成可下载。
      scriptMdReady: exists("script.md"),
      captionsReady: exists(manifest?.captionsFile ?? "captions/captions.srt"),
      // 重渲是覆盖式操作（见 renderProject 里的 .prev 备份）：把上一版的位置也告诉前端，
      // 用户才有机会在覆盖后取回旧成片。
      previousVideoReady: previousFile !== null,
      previousVideoFile: previousFile
    });
  });

  router.get("/:id/events", (c) => {
    const id = c.req.param("id");
    // 与 DELETE/artifacts 同口径：非法 id 不应被拼进文件系统路径。
    if (!isValidProjectId(id)) {
      return c.json({ error: "Invalid project id" }, 400);
    }
    if (!deps.runner.get(id) && !existsSync(join(deps.projectsRoot, id))) {
      return c.json({ error: "Unknown project" }, 404);
    }
    const header = c.req.header("last-event-id");
    const lastEventId = Math.max(0, Number.parseInt(header ?? "0", 10) || 0);
    // 用 runner 缓存的实例：它和 runner 内部追加共用同一份「文件已成什么样」的缓存，
    // 这里若自己 new 一个，缓存永远为空，每次连接都要把 events.jsonl 整份读出来重放。
    const log = deps.runner.eventLogOf(id);
    const hub = deps.runner.eventHub;
    let cleanup = (): void => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const push = (event: Parameters<typeof sseFrame>[0]): void => {
          if (closed) {
            return;
          }
          try {
            controller.enqueue(encoder.encode(sseFrame(event)));
          } catch {
            closed = true;
          }
        };
        for (const event of log.after(lastEventId)) {
          push(event);
        }
        const unsubscribe = hub.subscribe(id, push);
        const keepalive = setInterval(() => {
          if (!closed) {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              closed = true;
            }
          }
        }, 15000);
        cleanup = () => {
          closed = true;
          clearInterval(keepalive);
          unsubscribe();
        };
      },
      cancel() {
        cleanup();
      }
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      }
    });
  });

  return router;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：把 manifest 的 assetPath 归一化为可供 /file 使用的项目内相对路径；绝对路径仅当解析后落在项目目录内且文件非空时转相对，越界、缺失或空文件返回 null。
 * @param projectDir 项目目录绝对路径
 * @param assetPath manifest 镜头 assetPath 原值（相对或绝对）
 * @returns 项目相对路径或 null
 */
function serveableAssetPath(projectDir: string, assetPath: unknown): string | null {
  if (typeof assetPath !== "string" || !assetPath) {
    return null;
  }
  const target = resolve(projectDir, assetPath);
  try {
    const st = statSync(target);
    if (!st.isFile() || st.size === 0) {
      return null;
    }
  } catch {
    return null;
  }
  const rel = relative(projectDir, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  return rel;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：读取旧项目目录的展示标题（script.json title → brief.json theme → id）。
 */
function readProjectTitle(projectId: string, deps: ServerDeps): string | null {
  const dir = join(deps.projectsRoot, projectId);
  for (const [file, pick] of [
    ["script.json", (parsed: Record<string, unknown>) => (typeof parsed.title === "string" ? parsed.title : null)],
    ["brief.json", (parsed: Record<string, unknown>) => (typeof parsed.theme === "string" ? parsed.theme : null)]
  ] as const) {
    try {
      const title = pick(JSON.parse(readFileSync(join(dir, file), "utf8")));
      if (title) {
        return title;
      }
    } catch {
      // fall through to the next candidate
    }
  }
  return projectId;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：判断项目是否已有成片（render-manifest.json 的 outputFile 存在且非空）。
 */
function hasRenderedVideo(projectId: string, deps: ServerDeps): boolean {
  const manifest = readRenderManifestFile(join(deps.projectsRoot, projectId));
  if (!manifest?.outputFile) {
    return false;
  }
  return nonEmptyFileExists(resolve(deps.projectsRoot, projectId, manifest.outputFile));
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：项目目录的修改时间（ISO 字符串），stat 失败返回 undefined。
 */
function directoryMtime(projectsRoot: string, projectId: string): string | undefined {
  try {
    return statSync(join(projectsRoot, projectId)).mtime.toISOString();
  } catch {
    return undefined;
  }
}
