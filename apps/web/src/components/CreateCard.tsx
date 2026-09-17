/**
 * @file CreateCard.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 创建视图（Runway 式顶部输入 + 剪映式模板卡）：一段 brief 文本，配合执行/产物模式、风格模板卡、时长与 provider profile 选择，提交后回调进入任务详情。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useState } from "react";
import type { SkillCard, SummaryResponse } from "@aivideo/shared";
import { api } from "../api";

/** CreateCard 组件入参。 */
interface Props {
  summary: SummaryResponse | null;
  skills: SkillCard[];
  onCreated: (jobId: string) => void;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染 brief 输入与选项并创建任务。
 */
export default function CreateCard({ summary, skills, onCreated }: Props) {
  const [brief, setBrief] = useState("");
  const [execMode, setExecMode] = useState<"auto" | "guided">("auto");
  const [generationMode, setGenerationMode] = useState<"video" | "script">("video");
  const [skill, setSkill] = useState("auto");
  const [duration, setDuration] = useState<number | "">("");
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    if (!brief.trim()) {
      setError("请先输入一段创作描述");
      return;
    }
    setBusy(true);
    setError(null);
    api
      .createProject({
        briefText: brief.trim(),
        mode: execMode,
        generationMode,
        skill,
        durationSeconds: duration === "" ? undefined : Number(duration),
        providerProfile: profile || undefined
      })
      .then((res) => onCreated(res.job.id))
      .catch((err: Error) => {
        setError(err.message);
        setBusy(false);
      });
  };

  return (
    <section className="card">
      <h2>从一个想法开始</h2>
      <div className="create-form">
        <textarea
          placeholder="例如：主题：夏季防晒喷雾测评；时长：45s；平台：抖音。也可以直接写一段口播想法，结构化键会被自动解析。"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
        <div className="form-row">
          <label>
            执行模式
            <span className="radio-group">
              <label>
                <input type="radio" checked={execMode === "auto"} onChange={() => setExecMode("auto")} />
                全自动
              </label>
              <label>
                <input type="radio" checked={execMode === "guided"} onChange={() => setExecMode("guided")} />
                分步确认
              </label>
            </span>
          </label>
          <label>
            产物模式
            <span className="radio-group">
              <label>
                <input type="radio" checked={generationMode === "video"} onChange={() => setGenerationMode("video")} />
                完整视频
              </label>
              <label>
                <input type="radio" checked={generationMode === "script"} onChange={() => setGenerationMode("script")} />
                仅脚本分镜
              </label>
            </span>
          </label>
          <label>
            时长（秒）
            <input
              type="number"
              min={5}
              max={600}
              placeholder={summary ? String(summary.defaults.durationSeconds) : ""}
              value={duration}
              onChange={(e) => setDuration(e.target.value === "" ? "" : Number(e.target.value))}
            />
          </label>
          {summary && summary.profiles.length > 1 && (
            <label>
              Provider 配置
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
          <div className="skill-cards">
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
              >
                <div className="name">{item.name}</div>
                <div className="desc">{item.description}</div>
              </button>
            ))}
          </div>
        </div>
        {summary && (
          <div className="muted" style={{ fontSize: 12 }}>
            当前 provider：文本 {summary.providers.text?.id ?? "本地"} ｜ 图像 {summary.providers.image?.id ?? "无"} ｜
            视频 {summary.providers.video?.id ?? "无"} ｜ 配音 {summary.providers.speech?.id ?? "无"}
            {(summary.providers.image?.remote || summary.providers.video?.remote || summary.providers.speech?.remote) &&
              "（含远端计费能力）"}
            {!summary.render.gpu && "（渲染未启用 GPU）"}
          </div>
        )}
        {error && <div className="error-line">{error}</div>}
        <div>
          <button className="primary" disabled={busy} onClick={submit}>
            {busy ? "创建中…" : execMode === "guided" ? "开始（分步确认）" : "生成（全自动）"}
          </button>
        </div>
      </div>
    </section>
  );
}
