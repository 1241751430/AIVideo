/**
 * @file CreateCard.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 创建视图：brief 主输入（渐变聚焦描边）+ 实时键值解析预览 chips；参考图拖拽/点击选择后逐张分片上传（先建会话、每张一次 PUT 二进制流、创建任务只带 uploadId，单请求体积与张数无关）；执行/产物模式胶囊、时长滑块与预设、比例/平台/语言选择器（后端 buildJobRequest 均已支持）、Provider 配置选择、风格模板横滑画廊（含适用场景与语气）、⌘Enter 快捷提交。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Sparkles, X } from "lucide-react";
import type { SkillCard, SummaryResponse } from "@aivideo/shared";
import { api } from "../api";
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
  "参考图片": "images"
};

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
  images: "参考图"
};

/**
 * @author zhangbaohong  @date 2026-10-08  @see https://github.com/1241751430/AIVideo.git
 * 功能：前端镜像解析 brief 的「键：值」分段，仅用于预览展示（最终以后端解析为准）。
 * @param text brief 原文
 */
function parseBriefPreview(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const seg of text.split(/[;\n；]+/)) {
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
  return out.slice(0, 8);
}

/** 参考图待选项：保留原始 File 用于分片上传，缩略预览走 object URL（不进内存里的 base64 大字符串）。 */
interface RefPick {
  name: string;
  file: File;
  previewUrl: string;
}

/** 与服务端 MAX_INPUT_IMAGES / MAX_INPUT_IMAGE_BYTES 对齐，用于选择阶段的快速预校验。 */
const MAX_REFS = 20;
const MAX_REF_BYTES = 10 * 1024 * 1024;

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
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // object URL 必须显式回收：卸载时把当时还在列表里的预览一并释放，否则已删/已提交的图会一直占着内存。
  const picksRef = useRef<RefPick[]>([]);
  useEffect(() => {
    picksRef.current = refPicks;
  }, [refPicks]);
  useEffect(
    () => () => {
      for (const pick of picksRef.current) {
        URL.revokeObjectURL(pick.previewUrl);
      }
    },
    []
  );

  const defaultDuration = summary?.defaults.durationSeconds ?? 30;
  const shownDuration = duration ?? defaultDuration;

  const parsed = useMemo(() => parseBriefPreview(brief), [brief]);

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
   * @author zhangbaohong  @date 2026-10-28  @see https://github.com/1241751430/AIVideo.git
   * 功能：提交创建：有参考图时先开上传会话并逐张 PUT（一次一张，单请求体积与张数无关），再把 uploadId 交给创建接口；
   * 任一步失败都销毁会话并解除 busy，避免留下半截临时文件或按钮卡死。
   */
  const submit = async (): Promise<void> => {
    if (!brief.trim()) {
      setError("请先输入一段创作描述");
      return;
    }
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    let uploadId: string | undefined;
    try {
      if (refPicks.length > 0) {
        const session = await api.createUploadSession();
        uploadId = session.uploadId;
        for (const [index, pick] of refPicks.entries()) {
          setUploadNote(`上传参考图 ${index + 1}/${refPicks.length}`);
          await api.uploadImage(uploadId, index, pick.file);
        }
        setUploadNote("创建任务…");
      }
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
        uploadId
      });
      toast.success("任务已创建，开始执行");
      onCreated(res.job.id);
    } catch (err) {
      if (uploadId) {
        // 尽力清理；失败也不该盖住真正的错误原因。
        await api.deleteUploadSession(uploadId).catch(() => undefined);
      }
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    } finally {
      setUploadNote(null);
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
          className={`ref-dropzone${dragOver ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addRefFiles(Array.from(e.dataTransfer.files));
          }}
        >
          <label className="ref-drop-label">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(e) => {
                if (e.target.files) {
                  addRefFiles(Array.from(e.target.files));
                }
                e.target.value = "";
              }}
            />
            <ImagePlus size={15} aria-hidden="true" />
            参考图（可选）：点击或拖入 png/jpeg/webp，单张 ≤10MB、最多 20 张
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
                    onClick={() => removeRef(index)}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
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
            视频 {summary.providers.video?.id ?? "无"} ｜ 配音 {summary.providers.speech?.id ?? "无"}
            {(summary.providers.image?.remote || summary.providers.video?.remote || summary.providers.speech?.remote) &&
              "（含远端提供者）"}
            {!summary.render.gpu && "（渲染未启用 GPU）"}
          </div>
        )}
        {error && <div className="error-line">{error}</div>}
        <div>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {uploadNote ?? (busy ? "创建中…" : execMode === "guided" ? "开始（分步确认）" : "生成（全自动）")}
          </button>
        </div>
      </div>
    </section>
  );
}
