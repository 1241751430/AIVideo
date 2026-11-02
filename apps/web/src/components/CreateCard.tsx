/**
 * @file CreateCard.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 创建视图：brief 主输入（渐变聚焦描边）+ 实时键值解析预览 chips；参考图拖拽/点击选择后分片上传（先建会话、三路并发逐张 PUT 二进制流、字节级进度与可取消、失败后从断点续传、创建任务只带 uploadId，单请求体积与张数无关）；背景音乐选曲即预上传到独立会话（创建时只带 bgmUploadId，因为任务一创建就入队，之后再 PUT /:id/bgm 会被 409 拒绝）；执行/产物模式胶囊、时长滑块与预设、比例/平台/语言选择器（后端 buildJobRequest 均已支持）、Provider 配置选择、风格模板横滑画廊（含适用场景与语气）、⌘Enter 快捷提交。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Music, Sparkles, X } from "lucide-react";
import type { SkillCard, SummaryResponse } from "@aivideo/shared";
import { MAX_BGM_BYTES, MAX_INPUT_IMAGES, MAX_INPUT_IMAGE_BYTES } from "@aivideo/shared";
import { api, type UploadProgress } from "../api";
import { uploadRefImages, type UploadBatchProgress } from "../upload";
import { useToast } from "../hooks/useToasts";
import Chip from "./Chip";

/** CreateCard 组件入参。 */
interface Props {
  summary: SummaryResponse | null;
  skills: SkillCard[];
  onCreated: (jobId: string) => void;
}

/** 比例候选（core sizeMap 支持的四档 + 默认）。 */
const ASPECTS = ["9:16", "16:9", "1:1", "4:5"];

/** 平台候选。 */
const PLATFORMS: Array<{ value: string; label: string }> = [
  { value: "douyin", label: "抖音" },
  { value: "kuaishou", label: "快手" },
  { value: "xiaohongshu", label: "小红书" },
  { value: "bilibili", label: "B 站" },
  { value: "tiktok", label: "TikTok" },
  { value: "youtube", label: "YouTube" }
];

/** 语言候选（BCP-47，与 core 推断结果对齐）。 */
const LANGUAGES: Array<{ value: string; label: string }> = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en-US", label: "英语" },
  { value: "ja-JP", label: "日语" },
  { value: "ko-KR", label: "韩语" },
  { value: "ru-RU", label: "俄语" }
];

/** 时长预设。 */
const DUR_PRESETS = [15, 30, 45, 60, 90];

/** 本地镜像 core BRIEF_KEY_MAP 的常见拼写 → 规范键。 */
const BRIEF_KEY_ALIASES: Record<string, string> = {
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
  profile: "profile",
  provider: "profile",
  providerprofile: "profile",
  "模型配置": "profile",
  "配置档": "profile",
  image: "images",
  images: "images",
  "图片": "images",
  "参考图片": "images",
  dialogue: "dialogue",
  lines: "dialogue",
  "台词": "dialogue",
  "对白": "dialogue",
  "脚本台词": "dialogue",
  bgm: "bgm",
  music: "bgm",
  "音乐": "bgm",
  "背景音乐": "bgm"
};

/**
 * 台词块的起始标记：与 core 的 `DIALOGUE_BLOCK_PATTERN` 同口径。台词的值是**整段原文**而不是「一段键值对」——
 * 它带分号、换行，正是 brief 的分段符，后台是整块摄取的，前端预览也必须同样先整块摘走，
 * 否则用户在这里看到的预览是一地碎句，还以为自己写错了。
 */
const DIALOGUE_BLOCK_PATTERN = /^[ \t]*(?:台词|对白|脚本台词|dialogue)[ \t]*[:：]/im;

const KEY_LABELS: Record<string, string> = {
  theme: "主题",
  content: "内容",
  mode: "模式",
  skill: "模板",
  aspect: "比例",
  duration: "时长",
  language: "语言",
  platform: "平台",
  profile: "配置",
  images: "参考图",
  dialogue: "台词",
  bgm: "背景音乐"
};

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：前端镜像解析 brief 的「键：值」分段，仅用于预览展示（最终以后端解析为准）。
 * 台词块整段取走到文本末尾（与 core 的 `extractDialogueBlock` 一致），否则它的分号/换行会被切成碎句。
 * @param text brief 原文
 */
function parseBriefPreview(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const dialogueMatch = DIALOGUE_BLOCK_PATTERN.exec(text);
  const head = dialogueMatch ? text.slice(0, dialogueMatch.index) : text;
  const dialogue = dialogueMatch ? text.slice(dialogueMatch.index + dialogueMatch[0].length).trim() : "";
  for (const seg of head.split(/[;\n；]+/)) {
    const match = seg.trim().match(/^([^:：]{1,16})\s*[:：]\s*(.+)$/);
    if (!match) {
      continue;
    }
    const rawKey = (match[1] ?? "").trim().toLowerCase();
    const value = (match[2] ?? "").trim();
    const canonical = BRIEF_KEY_ALIASES[rawKey];
    if (canonical && value) {
      out.push({ key: canonical, value });
    }
  }
  if (dialogue) {
    out.push({ key: "dialogue", value: dialogue });
  }
  return out.slice(0, 8);
}

/** 参考图待选项：保留原始 File 用于分片上传，缩略预览走 object URL（不进内存里的 base64 大字符串）。 */
interface RefPick {
  name: string;
  file: File;
  previewUrl: string;
}

/**
 * 选图阶段的快速预校验上限：直接引 @aivideo/shared 的常量，与服务端落盘校验、core 的生成前校验同源，
 * 不再在前端抄一份数字（抄一份的下场是某天上限调了、前端还在按老数字放行或误拦）。
 */
const MAX_REFS = MAX_INPUT_IMAGES;
const MAX_REF_BYTES = MAX_INPUT_IMAGE_BYTES;

/** 上传区的说明文案：数字直接由常量拼出来，改上限时文案不会忘记同步。 */
const REF_HINT = `参考图（可选）：点击或拖入 png/jpeg/webp，单张 ≤${MAX_REF_BYTES / (1024 * 1024)}MB、最多 ${MAX_REFS} 张`;

/** 背景音乐上限：与 PUT /api/uploads/:id/bgm 的服务端限流同源。 */
const MAX_BGM_SIZE = MAX_BGM_BYTES;

/** 选曲可接受的 MIME：服务端最终以文件头魔数判定，这里只做「明显不是音频」的前置拦截。 */
const BGM_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/aac", "audio/mp4", "audio/x-m4a", "audio/ogg"];

/**
 * 选曲提示：只说当前真做得到的事。没选曲子时，流水线会按脚本的 bgmStyle 去本地素材库找，
 * 找到就配上、找不到就明说「本片无 BGM」——不会编一首出来，所以这里不能承诺「不选也会有音乐」。
 */
const BGM_HINT = `背景音乐（可选）：mp3/wav/aac/m4a/ogg，单首 ≤${MAX_BGM_SIZE / (1024 * 1024)}MB；不选则按脚本 BGM 风格从本地曲库匹配`;

/** 选曲状态：上传成功的曲子记下会话 id（创建任务时只带它）与展示用的元信息。 */
interface BgmPick {
  uploadId: string;
  name: string;
  bytes: number;
  /** 服务端 ffprobe 探到的时长；本机没装 ffprobe 时为 null，界面就不显示时长而不是编一个。 */
  durationSeconds: number | null;
}

/** 上传失败后保留的会话：主按钮据此变成「继续上传」，从服务端已落定的那张之后接着传。 */
interface PendingUpload {
  uploadId: string;
  /** 逐张指纹（有序）：前缀一致就说明已传的那几张序号没变，能直接续传；删、换、调序都会让前缀失配。 */
  signatures: string[];
  /** 上次中断时服务端已落定的张数，仅用于文案；真值每次都以 GET 会话为准。 */
  done: number;
  /** 建会话时服务端给的上限：续传时不必再问一遍（会话本身记着它当时的上限）。 */
  maxImages: number;
  maxBytes: number;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：单张参考图的指纹：名称 + 字节数 + 修改时间，足以分辨「同一张」与「换了一张同名的」。
 * @param pick 参考图待选项
 * @returns 指纹
 */
function pickSignature(pick: RefPick): string {
  return `${pick.name}:${pick.file.size}:${pick.file.lastModified}`;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：判断旧会话还能不能续：旧的逐张指纹必须是当前选图的**前缀**。
 * 服务端按序号落盘，只有「前面几张没动过」才能把旧序号当断点用；中间删一张会让后面全体错位，只能重新开。
 * @param previous 旧会话的逐张指纹
 * @param current 当前选图的逐张指纹
 * @returns 可续时返回可复用的张数，否则返回 0
 */
function resumePrefixLength(previous: string[], current: string[]): number {
  if (previous.length === 0 || previous.length > current.length) {
    return 0;
  }
  for (const [index, signature] of previous.entries()) {
    if (current[index] !== signature) {
      return 0;
    }
  }
  return previous.length;
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把字节数折成一位小数的 MB 文案；上传进度写成「12.4 / 84.0 MB」比裸字节数好读一个量级。
 * @param bytes 字节数
 * @returns MB 文案
 */
function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：把秒数折成 m:ss 文案；null 表示服务端没能探测（本机没装 ffprobe），返回 null 让调用方整段不渲染。
 * @param seconds 时长秒数
 * @returns m:ss 文案或 null
 */
function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染 brief 输入与全部创建选项，提交后回调进入任务详情。
 */
export default function CreateCard({ summary, skills, onCreated }: Props) {
  const toast = useToast();
  const [brief, setBrief] = useState("");
  const [execMode, setExecMode] = useState<"auto" | "guided">("auto");
  const [generationMode, setGenerationMode] = useState<"video" | "script">("video");
  const [skill, setSkill] = useState("auto");
  const [duration, setDuration] = useState<number | null>(null);
  const [aspect, setAspect] = useState("");
  const [language, setLanguage] = useState("");
  const [platform, setPlatform] = useState("");
  const [profile, setProfile] = useState("");
  const [refPicks, setRefPicks] = useState<RefPick[]>([]);
  /** 已上传完成的曲子（含它所在的上传会话 id）；null 表示这次使用服务端默认配乐。 */
  const [bgmPick, setBgmPick] = useState<BgmPick | null>(null);
  /** 选曲后立刻上传：曲子只有几 MB，但也要让用户看见进度、也能取消。 */
  const [bgmPhase, setBgmPhase] = useState<"idle" | "uploading" | "failed">("idle");
  const [bgmProgress, setBgmProgress] = useState<UploadProgress | null>(null);
  const [bgmError, setBgmError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 提交阶段：决定主按钮文案，以及上传区要不要给出「取消上传」。 */
  const [phase, setPhase] = useState<"idle" | "uploading" | "creating">("idle");
  const [uploadProgress, setUploadProgress] = useState<UploadBatchProgress | null>(null);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 在途上传的取消柄：卸载或用户点「取消上传」时立刻停掉在途字节流，而不是让它默默传完。 */
  const abortRef = useRef<AbortController | null>(null);

  /** 在途选曲上传的取消柄：换曲、清除或卸载时立刻停掉，别让一首被放弃的曲子继续占着带宽。 */
  const bgmAbortRef = useRef<AbortController | null>(null);

  /**
   * 最近一次进度快照。用 ref 而不是局部变量：进度是从上传回调里异步推进的，
   * 失败分支要读到「中断那一刻」的值来记断点，而 TS 对闭包里赋值的局部变量不会收窄类型，读出来会是 null。
   */
  const progressRef = useRef<UploadBatchProgress | null>(null);

  // object URL 必须显式回收：卸载时把当时还在列表里的预览一并释放，否则已删/已提交的图会一直占着内存。
  const picksRef = useRef<RefPick[]>([]);
  useEffect(() => {
    picksRef.current = refPicks;
  }, [refPicks]);

  /** 已上传的曲子会话：卸载时若还没被创建请求消费掉，得连会话一起销毁（曲子本身占了服务端磁盘）。 */
  const bgmPickRef = useRef<BgmPick | null>(null);
  useEffect(() => {
    bgmPickRef.current = bgmPick;
  }, [bgmPick]);
  useEffect(
    () => () => {
      // 卸载（含提交成功后跳转）时一并中止在途上传：用户已经离开这页了，浏览器不该还在后台替他传 200MB。
      abortRef.current?.abort();
      bgmAbortRef.current?.abort();
      // 选好的曲子若没随创建请求交出去，会话会一直占着磁盘到 24 小时 TTL；卸载时顺手销毁。
      // 提交成功时 bgmPick 已被清空，这里自然不会多删一次（也不会误删已被搬走的会话）。
      const pendingBgm = bgmPickRef.current;
      if (pendingBgm) {
        void api.deleteUploadSession(pendingBgm.uploadId).catch(() => undefined);
      }
      for (const pick of picksRef.current) {
        URL.revokeObjectURL(pick.previewUrl);
      }
    },
    []
  );

  /** 放弃已传的那批图并销毁会话：用户明确点「放弃已传」时调用。 */
  const discardPending = (): void => {
    setPendingUpload((stale) => {
      if (stale) {
        // 尽力而为：删不掉也只是占着磁盘到 24 小时 TTL 到期，不该给用户弹错误。
        void api.deleteUploadSession(stale.uploadId).catch(() => undefined);
      }
      return null;
    });
    setUploadProgress(null);
  };

  /** 用户主动中止在途上传：已落定的张留在会话里，可随时续传。 */
  const cancelUpload = (): void => {
    abortRef.current?.abort();
  };

  const defaultDuration = summary?.defaults.durationSeconds ?? 30;
  const shownDuration = duration ?? defaultDuration;

  const parsed = useMemo(() => parseBriefPreview(brief), [brief]);

  /**
   * 本次能否续传：旧会话的逐张指纹必须是当前选图的前缀。
   * 单独派生而不是每次提交时算，是因为按钮文案、「继续上传」提示也要用它，得和提交路径看同一份判断。
   */
  const resumablePending = useMemo(
    () =>
      pendingUpload && resumePrefixLength(pendingUpload.signatures, refPicks.map(pickSignature)) > 0
        ? pendingUpload
        : null,
    [pendingUpload, refPicks]
  );

  const removeRef = (index: number): void => {
    setRefPicks((prev) => {
      const pick = prev[index];
      if (pick) {
        URL.revokeObjectURL(pick.previewUrl);
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const addRefFiles = (files: File[]): void => {
    const okTypes = ["image/png", "image/jpeg", "image/webp"];
    const remaining = MAX_REFS - refPicks.length;
    if (remaining <= 0) {
      toast.error(`参考图最多 ${MAX_REFS} 张`);
      return;
    }
    const accepted: RefPick[] = [];
    for (const file of files.slice(0, remaining)) {
      if (!okTypes.includes(file.type)) {
        toast.error(`「${file.name}」不是支持的图片格式（png/jpeg/webp）`);
        continue;
      }
      if (file.size > MAX_REF_BYTES) {
        toast.error(`「${file.name}」超过 ${MAX_REF_BYTES / (1024 * 1024)}MB 上限`);
        continue;
      }
      accepted.push({ name: file.name, file, previewUrl: URL.createObjectURL(file) });
    }
    if (files.length > remaining) {
      toast.error(`超出数量上限，仅接收前 ${remaining} 张`);
    }
    if (accepted.length > 0) {
      setRefPicks((prev) => [...prev, ...accepted]);
    }
  };

  /**
   * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
   * 功能：清掉当前选中的曲子并销毁它所在的上传会话（尽力而为，删不掉也只是占盘到 TTL 到期）。
   * @param pick 要丢弃的选曲；缺省时丢弃 state 里那一份
   */
  const dropBgm = (pick: BgmPick | null = bgmPick): void => {
    bgmAbortRef.current?.abort();
    bgmAbortRef.current = null;
    setBgmProgress(null);
    setBgmError(null);
    setBgmPhase("idle");
    setBgmPick(null);
    if (pick) {
      void api.deleteUploadSession(pick.uploadId).catch(() => undefined);
    }
  };

  /**
   * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
   * 功能：选曲即上传：开一个**独立于参考图**的上传会话，把曲子 PUT 进去并记住 uploadId，创建任务时随请求带上。
   * 为什么不能「先创建任务、再 PUT /:id/bgm」：任务一创建就入队开跑，那时 guardEditable 会把换曲挡成 409。
   * 上传失败时把会话一起销毁（曲子在服务端只占盘，留着也没用），并把错误摊在选曲区里，让用户换一首重试。
   * @param file 用户选中的音频文件
   */
  const addBgmFile = async (file: File): Promise<void> => {
    if (bgmPhase === "uploading") {
      return;
    }
    if (!BGM_TYPES.includes(file.type)) {
      // 只做前置拦截：某些系统给 m4a/ogg 的 MIME 并不标准，真正的判据在服务端（文件头魔数）。
      const byExt = /\.(mp3|wav|aac|m4a|ogg)$/i.test(file.name);
      if (!byExt) {
        setBgmError(`「${file.name}」不是支持的音频格式（mp3/wav/aac/m4a/ogg）`);
        return;
      }
    }
    if (file.size > MAX_BGM_SIZE) {
      setBgmError(`「${file.name}」超过 ${MAX_BGM_SIZE / (1024 * 1024)}MB 上限`);
      return;
    }
    // 换曲时先放掉上一首：一首换一首，界面上永远只有当前这一首。
    const previous = bgmPick;
    setBgmPick(null);
    if (previous) {
      void api.deleteUploadSession(previous.uploadId).catch(() => undefined);
    }
    setBgmError(null);
    setBgmPhase("uploading");
    setBgmProgress({ loaded: 0, total: file.size });
    const controller = new AbortController();
    bgmAbortRef.current = controller;
    let uploadId: string | undefined;
    try {
      const session = await api.createUploadSession();
      uploadId = session.uploadId;
      const res = await api.uploadSessionBgm(uploadId, file, {
        signal: controller.signal,
        onProgress: (progress) => setBgmProgress(progress)
      });
      setBgmPick({
        uploadId,
        name: file.name,
        bytes: res.bgm.bytes,
        durationSeconds: res.bgm.durationSeconds
      });
      setBgmPhase("idle");
      setBgmProgress(null);
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (uploadId) {
        void api.deleteUploadSession(uploadId).catch(() => undefined);
      }
      setBgmPhase("failed");
      setBgmProgress(null);
      setBgmError(
        aborted
          ? "已取消上传，重新选择即可"
          : err instanceof Error
            ? err.message
            : String(err)
      );
    } finally {
      if (bgmAbortRef.current === controller) {
        bgmAbortRef.current = null;
      }
    }
  };

  /**
   * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
   * 功能：提交创建：有参考图时先开分片上传会话，三路并发逐张 PUT（字节级进度、随时可取消），再把 uploadId 交给创建接口。
   * 上传中断不销毁会话：已传的几十 MB 不该因为一次断线作废，记下逐张指纹留着续传；只有创建成功（服务端已把图搬走）
   * 或用户点「放弃已传」才销毁。
   */
  const submit = async (): Promise<void> => {
    if (!brief.trim()) {
      setError("请先输入一段创作描述");
      return;
    }
    if (busy) {
      return;
    }
    if (bgmPhase === "uploading") {
      // 曲子还没落进会话时提交，只会得到一个没带上 bgmUploadId 的任务，用户的曲子静默丢失。
      setError("背景音乐还在上传，稍等片刻或先取消选曲再提交");
      return;
    }
    setBusy(true);
    setError(null);
    const picks = refPicks;
    const signatures = picks.map(pickSignature);
    const resumable = resumablePending;
    let maxImages = MAX_REFS;
    let maxBytes = MAX_REF_BYTES;
    let uploadId: string | undefined;
    // 曲子走自己的会话，与参考图的 uploadId 互不影响：服务端先搬曲子、再搬图。
    const bgmUploadId = bgmPick?.uploadId;
    /** 创建请求是否已发出：发出后的失败会让服务端销毁曲子会话，本地引用也必须跟着作废。 */
    let creatingStarted = false;
    progressRef.current = null;
    try {
      if (picks.length > 0) {
        let skipIndexes: ReadonlySet<number> = new Set<number>();
        if (resumable) {
          // 续传先问服务端：本地只知道「传过一轮」，只有服务端知道哪几张真的落了盘。
          // 会话已过期（GET 404）就退化成全新上传，用户看到的是「重传」而不是一条看不懂的错误。
          const state = await api.getUploadSession(resumable.uploadId).catch(() => null);
          if (state) {
            uploadId = resumable.uploadId;
            skipIndexes = new Set(
              state.images.map((image) => image.index).filter((index) => index < picks.length)
            );
            maxImages = resumable.maxImages;
            maxBytes = resumable.maxBytes;
          }
        }
        if (!uploadId) {
          const session = await api.createUploadSession();
          uploadId = session.uploadId;
          maxImages = session.maxImages;
          maxBytes = session.maxBytes;
          // 旧会话（已过期、或选图改过导致前缀失配）和这次提交再无关系，留着只是占盘到 24 小时 TTL，顺手清掉。
          const stale = pendingUpload;
          setPendingUpload(null);
          if (stale) {
            void api.deleteUploadSession(stale.uploadId).catch(() => undefined);
          }
        }
        // 上限以服务端为准再核一次：本地预校验用的是编译期常量，若服务端调低过上限（灰度发布、多版本共存），
        // 只有这里的真实值能拦住——否则要等第 N 张传完才收到 413，前面的往返全白费。
        if (picks.length > maxImages) {
          throw new Error(`参考图最多 ${maxImages} 张，请先移除多余的图片再提交`);
        }
        const oversize = picks.find((pick) => pick.file.size > maxBytes);
        if (oversize) {
          throw new Error(`「${oversize.name}」超过单张 ${maxBytes / (1024 * 1024)}MB 上限`);
        }
        const controller = new AbortController();
        abortRef.current = controller;
        setPhase("uploading");
        // 续传时进度条的起点就是断点：跳过的张按「整张已传」计入，否则会出现「已完成 5/20 张、进度 0%」这种自相矛盾的画面。
        let skippedBytes = 0;
        picks.forEach((pick, index) => {
          if (skipIndexes.has(index)) {
            skippedBytes += pick.file.size;
          }
        });
        const start: UploadBatchProgress = {
          done: skipIndexes.size,
          total: picks.length,
          loadedBytes: skippedBytes,
          totalBytes: picks.reduce((sum, pick) => sum + pick.file.size, 0)
        };
        progressRef.current = start;
        setUploadProgress(start);
        await uploadRefImages(uploadId, picks, {
          signal: controller.signal,
          skipIndexes,
          onProgress: (next) => {
            progressRef.current = next;
            setUploadProgress(next);
          }
        });
        abortRef.current = null;
      }
      setPhase("creating");
      // 从这里开始，请求一旦发出，服务端就可能已经消费掉曲子的会话：失败时本地引用必须作废。
      creatingStarted = true;
      const res = await api.createProject({
        briefText: brief.trim(),
        mode: execMode,
        generationMode,
        skill,
        durationSeconds: shownDuration,
        providerProfile: profile || undefined,
        aspectRatio: aspect || undefined,
        language: language || undefined,
        platform: platform || undefined,
        uploadId,
        bgmUploadId
      });
      // 会话里的图（与曲子）已被服务端搬进项目目录，本地这份续传凭据随之作废；不必再 DELETE（会话已经不在了）。
      setPendingUpload(null);
      // 曲子的会话同样已被消费：清掉本地引用，否则卸载时会再发一次 DELETE 打向一个不存在的会话。
      setBgmPick(null);
      toast.success("任务已创建，开始执行");
      onCreated(res.job.id);
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      // 创建请求一旦发出去，服务端在 400 分支里会连同曲子的会话一起销毁（半消费的会话留着只会继续报错），
      // 所以这条路上必须把本地选曲也丢掉，让用户重新选——否则下次提交必然撞 404「会话已过期」。
      // 参考图上传失败（还没走到创建）时曲子会话仍然完好，不动它。
      if (creatingStarted) {
        setBgmPick(null);
      }
      if (uploadId) {
        setPendingUpload({
          uploadId,
          signatures,
          done: progressRef.current?.done ?? 0,
          maxImages,
          maxBytes
        });
      }
      setError(
        aborted
          ? "上传已取消，已传的图片会保留，再次提交会从断点继续"
          : err instanceof Error
            ? err.message
            : String(err)
      );
      setBusy(false);
      setPhase("idle");
    } finally {
      abortRef.current = null;
    }
  };

  return (
    <section className="card create-hero">
      <h2>
        <Sparkles size={16} className="h2-ico" aria-hidden="true" />
        从一个想法开始
      </h2>
      <div className="create-form">
        <textarea
          className="brief-input"
          placeholder="例如：主题：夏季防晒喷雾测评；时长：45s；平台：抖音。也可以直接写一段口播想法，结构化键会被自动解析。（⌘/Ctrl + Enter 快速生成）"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              void submit();
            }
          }}
          aria-label="创作描述"
        />
        {parsed.length > 0 && (
          <div className="brief-chips" title="本地预览解析，最终以后端解析为准">
            {parsed.map((item, index) => (
              <Chip key={`${item.key}-${index}`} tone="brand" label={`${KEY_LABELS[item.key] ?? item.key}：${item.value}`} />
            ))}
          </div>
        )}
        <div
          className={`ref-dropzone${dragOver ? " over" : ""}${busy ? " busy" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) {
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (!busy) {
              addRefFiles(Array.from(e.dataTransfer.files));
            }
          }}
        >
          <label className="ref-drop-label">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={busy}
              onChange={(e) => {
                if (e.target.files) {
                  addRefFiles(Array.from(e.target.files));
                }
                e.target.value = "";
              }}
            />
            <ImagePlus size={15} aria-hidden="true" />
            {REF_HINT}
          </label>
          {refPicks.length > 0 && (
            <div className="ref-picks">
              {refPicks.map((pick, index) => (
                <span className="ref-pick" key={`${pick.name}-${pick.previewUrl}`}>
                  <img src={pick.previewUrl} alt={pick.name} />
                  <button
                    type="button"
                    className="icon-btn ref-remove"
                    aria-label={`移除 ${pick.name}`}
                    disabled={busy}
                    onClick={() => removeRef(index)}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {uploadProgress && (phase === "uploading" || uploadProgress.done > 0) && (
            <div className="upload-meter">
              <div className="upload-meter-head">
                <span className="upload-meter-note">
                  {phase === "uploading" ? "上传参考图" : "已中断"} {uploadProgress.done}/{uploadProgress.total} 张
                  <span className="prog-num">
                    {" "}
                    · {formatMb(uploadProgress.loadedBytes)} / {formatMb(uploadProgress.totalBytes)} MB
                  </span>
                </span>
                {phase === "uploading" ? (
                  <button type="button" className="fchip" onClick={cancelUpload}>
                    取消上传
                  </button>
                ) : (
                  <button type="button" className="fchip" onClick={discardPending}>
                    放弃已传
                  </button>
                )}
              </div>
              <div
                className="prog-track"
                role="progressbar"
                aria-label="参考图上传进度"
                aria-valuemin={0}
                aria-valuemax={uploadProgress.totalBytes}
                aria-valuenow={Math.min(uploadProgress.loadedBytes, uploadProgress.totalBytes)}
              >
                <div
                  className={`prog-fill${phase === "uploading" ? " live" : ""}`}
                  style={{
                    width: `${uploadProgress.totalBytes > 0 ? Math.min(100, (uploadProgress.loadedBytes / uploadProgress.totalBytes) * 100) : 0}%`
                  }}
                />
              </div>
            </div>
          )}
        </div>
        <div className={`bgm-pick${bgmPhase === "uploading" ? " busy" : ""}`}>
          <label className="bgm-pick-label">
            <input
              type="file"
              accept="audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg"
              disabled={busy || bgmPhase === "uploading"}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  void addBgmFile(file);
                }
                e.target.value = "";
              }}
            />
            <Music size={15} aria-hidden="true" />
            {bgmPick ? "换一首背景音乐" : BGM_HINT}
          </label>
          {bgmPick && (
            <span className="bgm-file">
              <span className="bgm-name" title={bgmPick.name}>
                {bgmPick.name}
              </span>
              <span className="bgm-meta">
                {/* 时长探测不到（服务端没装 ffprobe）时整段不渲染，而不是显示一个编出来的数字。 */}
                {[formatDuration(bgmPick.durationSeconds), `${formatMb(bgmPick.bytes)} MB`].filter(Boolean).join(" · ")}
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`移除背景音乐 ${bgmPick.name}`}
                disabled={busy}
                onClick={() => dropBgm()}
              >
                <X size={12} />
              </button>
            </span>
          )}
          {bgmPhase === "uploading" && bgmProgress && (
            <div className="upload-meter">
              <div className="upload-meter-head">
                <span className="upload-meter-note">
                  上传背景音乐
                  <span className="prog-num">
                    {" "}
                    · {formatMb(bgmProgress.loaded)} / {formatMb(bgmProgress.total)} MB
                  </span>
                </span>
                <button type="button" className="fchip" onClick={() => bgmAbortRef.current?.abort()}>
                  取消上传
                </button>
              </div>
              <div
                className="prog-track"
                role="progressbar"
                aria-label="背景音乐上传进度"
                aria-valuemin={0}
                aria-valuemax={bgmProgress.total}
                aria-valuenow={Math.min(bgmProgress.loaded, bgmProgress.total)}
              >
                <div
                  className="prog-fill live"
                  style={{
                    width: `${bgmProgress.total > 0 ? Math.min(100, (bgmProgress.loaded / bgmProgress.total) * 100) : 0}%`
                  }}
                />
              </div>
            </div>
          )}
          {bgmError && (
            <p className="bgm-error" role="alert">
              {bgmError}
            </p>
          )}
        </div>
        <div className="create-grid">
          <div className="cg-cell">
            <span className="cg-label">执行模式</span>
            <span className="radio-group">
              <label className={`pill${execMode === "auto" ? " on" : ""}`}>
                <input type="radio" checked={execMode === "auto"} onChange={() => setExecMode("auto")} />
                全自动
              </label>
              <label className={`pill${execMode === "guided" ? " on" : ""}`}>
                <input type="radio" checked={execMode === "guided"} onChange={() => setExecMode("guided")} />
                分步确认
              </label>
            </span>
          </div>
          <div className="cg-cell">
            <span className="cg-label">产物模式</span>
            <span className="radio-group">
              <label className={`pill${generationMode === "video" ? " on" : ""}`}>
                <input type="radio" checked={generationMode === "video"} onChange={() => setGenerationMode("video")} />
                完整视频
              </label>
              <label className={`pill${generationMode === "script" ? " on" : ""}`}>
                <input type="radio" checked={generationMode === "script"} onChange={() => setGenerationMode("script")} />
                仅脚本分镜
              </label>
            </span>
          </div>
          <div className="cg-cell">
            <span className="cg-label">
              时长 <b className="cg-value">{shownDuration}s</b>
              {duration === null && <em className="muted">（默认）</em>}
            </span>
            <div className="dur-row">
              {DUR_PRESETS.map((preset) => (
                <button
                  key={preset}
                  className={`fchip${shownDuration === preset && duration !== null ? " selected" : ""}`}
                  onClick={() => setDuration(preset)}
                >
                  {preset}s
                </button>
              ))}
              <button className="fchip" title="恢复服务端默认时长" onClick={() => setDuration(null)}>
                默认
              </button>
            </div>
            <input
              type="range"
              min={5}
              max={180}
              step={5}
              value={shownDuration}
              aria-label="时长滑块（秒）"
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </div>
          <label className="cg-cell">
            <span className="cg-label">画面比例</span>
            <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              <option value="">默认（{summary?.defaults.aspectRatio ?? "9:16"}）</option>
              {ASPECTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="cg-cell">
            <span className="cg-label">发布平台</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">默认（{summary?.defaults.platform ?? "douyin"}）</option>
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="cg-cell">
            <span className="cg-label">口播语言</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="">默认（{summary?.defaults.language ?? "zh-CN"}，可自动推断）</option>
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          {summary && summary.profiles.length > 1 && (
            <label className="cg-cell">
              <span className="cg-label">Provider 配置</span>
              <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                <option value="">默认（{summary.activeProfile}）</option>
                {summary.profiles
                  .filter((id) => id !== summary.activeProfile)
                  .map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </div>
        <div>
          <div className="muted" style={{ marginBottom: 6 }}>
            风格模板
          </div>
          <div className="skill-rail">
            <button
              type="button"
              className={`skill-card${skill === "auto" ? " selected" : ""}`}
              onClick={() => setSkill("auto")}
            >
              <div className="name">自动匹配</div>
              <div className="desc">根据 brief 自动选择叙事风格</div>
            </button>
            {skills.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`skill-card${skill === item.id ? " selected" : ""}`}
                onClick={() => setSkill(item.id)}
                title={item.tone ? `语气：${item.tone}` : undefined}
              >
                <div className="name">{item.name}</div>
                <div className="desc">{item.description}</div>
                {(item.suitableFor.length > 0 || item.tone) && (
                  <div className="skill-meta">
                    {item.suitableFor.slice(0, 3).map((tag) => (
                      <span key={tag} className="skill-tag">
                        {tag}
                      </span>
                    ))}
                    {item.tone && <span className="skill-tone">{item.tone}</span>}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
        {summary && (
          <div className="muted" style={{ fontSize: 12 }}>
            当前 provider：文本 {summary.providers.text?.id ?? "本地"} ｜ 图像 {summary.providers.image?.id ?? "无"} ｜
            视频 {summary.providers.video?.id ?? "无"} ｜ 配音 {summary.providers.speech?.id ?? "无"} ｜
            音乐 {summary.providers.music?.id ?? "无"}
            {(summary.providers.image?.remote ||
              summary.providers.video?.remote ||
              summary.providers.speech?.remote ||
              summary.providers.music?.remote) &&
              "（含远端提供者）"}
            {!summary.render.gpu && "（渲染未启用 GPU）"}
          </div>
        )}
        {error && <div className="error-line">{error}</div>}
        <div>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {phase === "uploading"
              ? "上传中…"
              : phase === "creating"
                ? "创建中…"
                : resumablePending
                  ? "继续上传并创建"
                  : execMode === "guided"
                    ? "开始（分步确认）"
                    : "生成（全自动）"}
          </button>
          {!busy && resumablePending && (
            <span className="prog-note" style={{ marginLeft: 10 }}>
              上次已传 {resumablePending.done} 张，将从断点继续
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
