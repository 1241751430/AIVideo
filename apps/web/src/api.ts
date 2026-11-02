/**
 * @file api.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 工作台 REST/SSE 客户端封装：统一 JSON 解析与错误归一化，全部请求路径与响应形状对齐 @aivideo/shared 线协议；另导出媒体文件 URL 构造器。
 * @see https://github.com/1241751430/AIVideo.git
 */
import type {
  ArtifactsSnapshot,
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
  return send<T>(path, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
}

/**
 * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
 * 功能：发请求并统一处理非 2xx：优先取响应体里的 {error} 文案，解析失败退回状态码文案。
 * 与 request 分开是因为二进制上传不能带 application/json 头（要带图片自己的 MIME）。
 */
async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
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

/** 批量重试响应：重排的镜头数 + 被删除待重做的文件（项目相对路径）。 */
export interface RetryBatchResponse {
  ok: boolean;
  retried: number;
  deleted: string[];
}

/** 创建任务请求体（与 routes/create-request.ts 的 buildJobRequest 对齐）。 */
export interface CreateProjectBody {
  briefText: string;
  mode: "auto" | "guided";
  generationMode: "video" | "script";
  skill?: string;
  durationSeconds?: number;
  providerProfile?: string;
  aspectRatio?: string;
  language?: string;
  platform?: string;
  /** 分片上传会话 id（POST /api/uploads 建会话、逐张 PUT 后的返回值）；服务端按序搬进 inputImages。 */
  uploadId?: string;
  /**
   * 背景音乐的上传会话 id（另一个会话，与 uploadId 互不影响）：创建任务时服务端把会话里的 `bgm.<ext>` 搬进
   * `audio/bgm.<ext>`。任务一创建就入队开跑，之后 `PUT /:id/bgm` 会被 409 拒绝，所以创建卡片选的曲子只能走这条路。
   */
  bgmUploadId?: string;
}

/** POST /api/uploads 响应：会话 id 与单张/数量上限（前端据此做预校验，避免白传）。 */
export interface UploadSessionResponse {
  uploadId: string;
  maxImages: number;
  maxBytes: number;
}

/** GET /api/uploads/:id 响应：会话里已经落定的图片（续传时据此跳过已传的张）。 */
export interface UploadSessionState {
  uploadId: string;
  images: Array<{ index: number; ext: string; bytes: number }>;
}

/** 单张参考图的上传进度：loaded/total 均为字节数，total 由浏览器按请求体长度给出。 */
export interface UploadProgress {
  loaded: number;
  total: number;
}

/** 单张上传的可选控制：取消信号与进度回调。 */
export interface UploadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}

/** 背景音乐落盘结果（与 server 的 StoredBgm 对齐）：项目接口给项目内相对路径，会话接口给会话内文件名。 */
export interface StoredBgm {
  path: string;
  ext: string;
  bytes: number;
  /** 时长秒数；服务端未安装 ffprobe 时为 null（环境缺失不阻断上传）。 */
  durationSeconds: number | null;
}

/** PUT /api/uploads/:id/:index 响应。 */
export interface UploadedImageResponse {
  image: { index: number; ext: string; bytes: number };
}

/** PUT /api/uploads/:id/bgm 与 PUT /api/projects/:id/bgm 的响应。 */
export interface UploadBgmResponse {
  bgm: StoredBgm;
}

/** DELETE /api/projects/:id/bgm 响应：幂等，本来没有曲子时 removed 为空数组。 */
export interface DeleteBgmResponse {
  ok: boolean;
  removed: string[];
}

/** GET /api/healthz 响应：存活标记 + 配置告警列表。 */
export interface HealthResponse {
  ok: boolean;
  warnings?: string[];
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：以 PUT 上传一段二进制（参考图或背景音乐）：请求体就是文件本身，Content-Type 取文件自己的 MIME。
 * 用 XMLHttpRequest 而非 fetch：fetch 至今没有上传进度事件，fetch 下只能显示「第 3/20 张」这种颗粒度，
 * 用户既不知道进度也不知道还要等多久。XHR 的 upload.onprogress 给得出字节数级进度，abort() 也能真正停掉在途的字节流。
 * 响应与错误归一化口径与 send() 一致：非 2xx 优先取响应体里的 {error} 文案。
 * @param path 请求路径
 * @param file 文件二进制
 * @param options 取消信号与进度回调
 * @returns 解析后的响应体
 */
function putBinary<T>(path: string, file: Blob, options: UploadOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", path);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.responseType = "text";
    const onAbort = (): void => xhr.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException("上传已取消", "AbortError"));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const settle = (): void => options.signal?.removeEventListener("abort", onAbort);
    xhr.upload.onprogress = (event: ProgressEvent): void => {
      if (event.lengthComputable) {
        options.onProgress?.({ loaded: event.loaded, total: event.total });
      }
    };
    xhr.onload = (): void => {
      settle();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new ApiError(xhr.status, "上传响应无法解析"));
        }
        return;
      }
      // 与服务端 send() 同口径：优先用响应体里的 {error} 文案，解析不出才退回状态码。
      let message = `${xhr.status} ${xhr.statusText}`;
      try {
        const body = JSON.parse(xhr.responseText) as { error?: string };
        if (body.error) {
          message = body.error;
        }
      } catch {
        // 非 JSON 错误体（网关 413/502 等），保留状态码文案
      }
      reject(new ApiError(xhr.status, message));
    };
    xhr.onerror = (): void => {
      settle();
      reject(new ApiError(0, "网络错误：上传中断，请重试"));
    };
    xhr.onabort = (): void => {
      settle();
      reject(new DOMException("上传已取消", "AbortError"));
    };
    xhr.send(file);
  });
}

/** 工作台全部后端调用。 */
export const api = {
  summary: () => request<SummaryResponse>("/api/summary"),
  healthz: () => request<HealthResponse>("/api/healthz"),
  skills: () => request<{ skills: SkillCard[] }>("/api/skills"),
  listProjects: () => request<{ projects: ProjectListItem[] }>("/api/projects"),
  getProject: (id: string) => request<{ project: JobDto }>(`/api/projects/${encodeURIComponent(id)}`),
  createProject: (body: CreateProjectBody) =>
    request<{ job: JobDto }>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  /** 新建参考图上传会话（服务端落 projectsRoot/.uploads/<uploadId>，24 小时无动静自动清理）。 */
  createUploadSession: () => request<UploadSessionResponse>("/api/uploads", { method: "POST" }),
  /** 读取会话已落定的图片：上传中断后据此跳过已传的张，不必整批重来。 */
  getUploadSession: (uploadId: string) => request<UploadSessionState>(`/api/uploads/${encodeURIComponent(uploadId)}`),
  /**
   * 上传单张参考图：请求体就是图片二进制本身，一次一张，单请求体积与张数无关。
   * 这里用 XMLHttpRequest 而非 fetch：fetch 至今没有上传进度事件，20 张 × 10MB 的批次
   * 在 fetch 下只能显示「第 3/20 张」这种颗粒度，用户既不知道进度也不知道还要等多久。
   * XHR 的 upload.onprogress 给得出字节数级进度，abort() 也能让「取消」真正停掉在途的字节流。
   */
  uploadImage: (uploadId: string, index: number, file: Blob, options: UploadOptions = {}) =>
    putBinary<UploadedImageResponse>(`/api/uploads/${encodeURIComponent(uploadId)}/${index}`, file, options),
  /**
   * 把创建卡片选中的背景音乐传进上传会话（`<会话>/bgm.<ext>`）：创建任务时由 bgmUploadId 引用，
   * 服务端搬进 `audio/bgm.<ext>`。为什么要先传而不能创建后再 PUT：任务一创建就入队开跑，
   * 那时 `PUT /api/projects/:id/bgm` 会被 409 拒绝。
   */
  uploadSessionBgm: (uploadId: string, file: Blob, options: UploadOptions = {}) =>
    putBinary<UploadBgmResponse>(`/api/uploads/${encodeURIComponent(uploadId)}/bgm`, file, options),
  /** 给已存在的项目换曲（覆盖式：同一项目永远只有一首 `audio/bgm.*`）。 */
  uploadBgm: (projectId: string, file: Blob, options: UploadOptions = {}) =>
    putBinary<UploadBgmResponse>(`/api/projects/${encodeURIComponent(projectId)}/bgm`, file, options),
  /** 清空项目自定义背景音乐；幂等（本来没有也回 200，removed 为空数组）。 */
  deleteBgm: (projectId: string) =>
    send<DeleteBgmResponse>(`/api/projects/${encodeURIComponent(projectId)}/bgm`, { method: "DELETE" }),
  /** 放弃上传会话（清掉已传的临时图）；失败不抛，仅用于卸载/取消时的尽力清理。 */
  deleteUploadSession: (uploadId: string) =>
    send<{ ok: boolean }>(`/api/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" }),
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
  /** 批量重试：缺省重排全部产物缺失的失败镜头（后端 POST /:id/shots/retry-batch，单次重排素材阶段）。 */
  retryBatch: (id: string, shotIds?: string[]) =>
    request<RetryBatchResponse>(`/api/projects/${encodeURIComponent(id)}/shots/retry-batch`, {
      method: "POST",
      body: JSON.stringify(shotIds ? { shotIds } : {})
    }),
  /** 镜头拖拽排序：按新顺序提交 shotId 列表（后端 PUT /:id/shots/order，Phase D 落地）。 */
  reorderShots: (id: string, shotIds: string[]) =>
    request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/shots/order`, {
      method: "PUT",
      body: JSON.stringify({ shotIds })
    }),
  rerender: (id: string) => request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/rerender`, { method: "POST" }),
  /** 失败/取消后从断点继续（后端 POST /:id/resume；已完成的阶段靠输入指纹自动跳过）。 */
  resume: (id: string) => request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/resume`, { method: "POST" }),
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

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：构造任务参考图预览 URL（GET /:id/input-image?index=，读 brief.inputImages）。
 */
export function inputImageUrl(projectId: string, index: number): string {
  return `/api/projects/${encodeURIComponent(projectId)}/input-image?index=${index}`;
}
