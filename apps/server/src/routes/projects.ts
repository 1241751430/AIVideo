/**
 * @file projects.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 项目/任务路由：创建（brief 解析 + 校验）、列表（任务 + 无任务旧目录 + 损坏隔离）、详情、删除、取消、检查点决策、工件快照与 SSE 事件流。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import {
  GenerateRequest,
  GenerationMode,
  inferInputLanguage,
  isValidProjectId,
  parseDuration,
  parseStructuredBrief,
  shotImageRelative,
  shotVideoRelative,
  validateGenerateRequest
} from "@aivideo/core";
import type { ExecMode, JobDto, JobRequest } from "../types.js";
import { JobEventLog, sseFrame } from "../jobs/events.js";
import { removeProject, scanProjects } from "../jobs/job-store.js";
import type { ServerDeps } from "../app.js";

/** GET /api/projects 列表条目：任务、无任务的旧项目目录、或损坏隔离项。 */
export interface ProjectListItem {
  projectId: string;
  kind: "job" | "project" | "corrupt";
  job?: JobDto;
  title?: string;
  hasVideo?: boolean;
  updatedAt?: string;
}

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
    try {
      const parsed = buildJobRequest(deps, body);
      request = parsed.request;
      execMode = parsed.execMode;
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    const job = deps.runner.create({ execMode, request });
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
    if (decision === "redo-stage" && !["script", "assets", "audio", "render"].includes(String(stage))) {
      return c.json({ error: "redo-stage requires a valid stage" }, 400);
    }
    const ok = deps.runner.review(c.req.param("id"), decision, stage as never);
    return ok ? c.json({ ok: true }) : c.json({ error: "Not awaiting a checkpoint" }, 409);
  });

  router.get("/:id/artifacts", (c) => {
    const id = c.req.param("id");
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
    const manifest = readJson("render-manifest.json") as {
      shots?: Array<Record<string, unknown>>;
      outputFile?: string;
    } | null;
    const script = readJson("script.json");
    const brief = readJson("brief.json");
    const fileExists = (absolutePath: string): boolean => {
      try {
        const st = statSync(absolutePath);
        return st.isFile() && st.size > 0;
      } catch {
        return false;
      }
    };
    const exists = (relative: string): boolean => fileExists(resolve(dir, relative));
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
          manifestAsset: typeof entry.assetPath === "string" && exists(entry.assetPath) ? entry.assetPath : null
        }
      };
    });
    return c.json({
      brief,
      script,
      storyboard,
      manifest,
      shots,
      videoReady: manifest?.outputFile ? exists(resolve(dir, manifest.outputFile)) : false
    });
  });

  router.get("/:id/events", (c) => {
    const id = c.req.param("id");
    if (!deps.runner.get(id) && !existsSync(join(deps.projectsRoot, id))) {
      return c.json({ error: "Unknown project" }, 404);
    }
    const header = c.req.header("last-event-id");
    const lastEventId = Math.max(0, Number.parseInt(header ?? "0", 10) || 0);
    const log = new JobEventLog(deps.runner.projectDirOf(id));
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
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把创建请求（briefText 与显式字段）合成为 JobRequest：显式字段优先、经 core 的 validateGenerateRequest 护栏校验；mode=auto|guided 是执行模式，generationMode 是产物模式。
 * @param deps 服务依赖（取配置默认值）
 * @param body 请求 JSON
 * @returns JobRequest 与执行模式；非法输入抛错
 */
export function buildJobRequest(deps: ServerDeps, body: Record<string, unknown>): { request: JobRequest; execMode: ExecMode } {
  const briefText = typeof body.briefText === "string" ? body.briefText : "";
  const fields = briefText.trim() ? parseStructuredBrief(briefText) : {};
  const defaults = deps.config.defaults;
  const explicitString = (key: string): string | undefined =>
    typeof body[key] === "string" && (body[key] as string).trim() ? (body[key] as string).trim() : undefined;

  const theme = explicitString("theme") ?? fields.theme;
  const content = explicitString("content") ?? fields.content;
  if (!theme && !content) {
    throw new Error("theme 或 content 至少提供一个（可直接输入一段 brief）");
  }
  for (const [label, value] of [["theme", theme], ["content", content]] as const) {
    if (value && value.length > 2000) {
      throw new Error(`${label} 超过 2000 字符上限`);
    }
  }

  const rawGenerationMode = explicitString("generationMode") ?? fields.mode;
  const generationMode: GenerationMode = rawGenerationMode === "script" ? "script" : "video";
  const skill = explicitString("skill") ?? fields.skill ?? "auto";
  const rawDuration = body.durationSeconds;
  const durationSeconds =
    typeof rawDuration === "number" ? Math.round(rawDuration) : (parseDuration(fields.duration) ?? defaults.durationSeconds);
  const aspectRatio = explicitString("aspectRatio") ?? fields.aspect ?? defaults.aspectRatio;
  const language =
    explicitString("language") ?? fields.language ?? inferInputLanguage([theme, content]) ?? defaults.language;
  const platform = explicitString("platform") ?? fields.platform ?? defaults.platform;
  const providerProfile = explicitString("providerProfile") ?? fields["provider-profile"];

  const generateRequest: GenerateRequest = {
    theme,
    content,
    images: [],
    skill,
    mode: generationMode,
    aspectRatio,
    durationSeconds,
    language,
    platform,
    persistArtifacts: true
  };
  validateGenerateRequest(generateRequest);

  const execMode: ExecMode = explicitString("mode") === "guided" ? "guided" : "auto";
  const request: JobRequest = {
    theme,
    content,
    generationMode,
    skill,
    aspectRatio,
    durationSeconds,
    language,
    platform,
    providerProfile
  };
  return { request, execMode };
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
  try {
    const manifest = JSON.parse(
      readFileSync(join(deps.projectsRoot, projectId, "render-manifest.json"), "utf8")
    ) as { outputFile?: string };
    if (!manifest.outputFile) {
      return false;
    }
    return existsSync(resolve(deps.projectsRoot, projectId, manifest.outputFile));
  } catch {
    return false;
  }
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
