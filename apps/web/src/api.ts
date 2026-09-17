/**
 * @file api.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 工作台 REST/SSE 客户端封装：统一 JSON 解析与错误归一化，全部请求路径与响应形状对齐 @aivideo/shared 线协议；另导出媒体文件 URL 构造器。
 * @see https://github.com/1241751430/AIVideo.git
 */
import type {
  ArtifactsSnapshot,
  CostPreview,
  JobDto,
  OpenFolderResponse,
  ProjectListItem,
  ReviewDecision,
  ScriptMetaBody,
  ShotEditBody,
  SkillCard,
  SummaryResponse
} from "@aivideo/shared";

/** API 错误：保留 HTTP 状态码与服务端 error 文案供 UI 展示。 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：发起 JSON 请求；非 2xx 时解析 {error} 文案抛 ApiError。
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // 非 JSON 错误体（如网关 502），保留状态码文案
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

/** 镜头编辑响应：失效矩阵结果 + 最新任务视图。 */
export interface ShotEditResponse {
  ok: boolean;
  assetInvalidated: boolean;
  audioInvalidated: boolean;
  deleted: string[];
  job: JobDto;
}

/** 脚本元信息编辑响应。 */
export interface ScriptEditResponse {
  ok: boolean;
  videoStale: boolean;
  job: JobDto;
}

/** 单镜重试响应：被删除待重做的文件（项目相对路径）。 */
export interface RetryResponse {
  ok: boolean;
  deleted: string[];
}

/** 创建任务请求体（与 routes/projects.ts buildJobRequest 对齐）。 */
export interface CreateProjectBody {
  briefText: string;
  mode: "auto" | "guided";
  generationMode: "video" | "script";
  skill?: string;
  durationSeconds?: number;
  providerProfile?: string;
}

/** 工作台全部后端调用。 */
export const api = {
  summary: () => request<SummaryResponse>("/api/summary"),
  skills: () => request<{ skills: SkillCard[] }>("/api/skills"),
  listProjects: () => request<{ projects: ProjectListItem[] }>("/api/projects"),
  getProject: (id: string) => request<{ project: JobDto }>(`/api/projects/${encodeURIComponent(id)}`),
  createProject: (body: CreateProjectBody) =>
    request<{ job: JobDto }>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  deleteProject: (id: string) => request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  cancel: (id: string) => request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  review: (id: string, body: ReviewDecision) =>
    request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify(body) }),
  artifacts: (id: string) => request<ArtifactsSnapshot>(`/api/projects/${encodeURIComponent(id)}/artifacts`),
  updateScript: (id: string, patch: ScriptMetaBody) =>
    request<ScriptEditResponse>(`/api/projects/${encodeURIComponent(id)}/artifacts/script`, {
      method: "PUT",
      body: JSON.stringify(patch)
    }),
  updateShot: (id: string, shotId: string, patch: ShotEditBody) =>
    request<ShotEditResponse>(`/api/projects/${encodeURIComponent(id)}/shots/${encodeURIComponent(shotId)}`, {
      method: "PUT",
      body: JSON.stringify(patch)
    }),
  retryShot: (id: string, shotId: string, target: "asset" | "audio") =>
    request<RetryResponse>(`/api/projects/${encodeURIComponent(id)}/shots/${encodeURIComponent(shotId)}/retry`, {
      method: "POST",
      body: JSON.stringify({ target })
    }),
  costPreview: (id: string) => request<{ preview: CostPreview }>(`/api/projects/${encodeURIComponent(id)}/cost-preview`),
  rerender: (id: string) => request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/rerender`, { method: "POST" }),
  openFolder: (id: string) =>
    request<OpenFolderResponse>(`/api/projects/${encodeURIComponent(id)}/open-folder`, { method: "POST" })
};

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：构造项目内媒体文件的预览 URL（GET /:id/file?path=）。
 */
export function fileUrl(projectId: string, relativePath: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(relativePath)}`;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：构造成片视频流式播放/下载 URL（GET /:id/video，支持 Range）。
 */
export function videoUrl(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/video`;
}
