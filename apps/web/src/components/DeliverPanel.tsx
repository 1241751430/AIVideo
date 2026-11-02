/**
 * @file DeliverPanel.tsx
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 交付面板：影院式暗场框内在线播放成片（Range 流式）与下载；背景音乐一试听/下载口，无 BGM 时明示「本片无 BGM」而不是默不作声；产物被编辑置 videoStale 时展示琥珀警示条与「重新渲染」CTA（覆盖式重写成片，先经确认框）；重渲保留的上一版成片（final.prev.mp4）在盘时给出下载口，覆盖后可取回；字幕（captions.srt）与脚本（script.md）在盘时给出独立下载口——它们此前只能去项目目录里找；脚本模式给出产物清单（脚本/分镜/镜头计数）；「打开文件夹」调宿主文件管理器，容器降级时展示宿主路径；操作反馈走 toast。
 * @see https://github.com/1241751430/AIVideo.git
 */
import { useState } from "react";
import { CircleCheck, CirclePlay, Download, FileText, FolderOpen, History, Music, RotateCcw, ShieldCheck, Subtitles, TriangleAlert } from "lucide-react";
import type { ArtifactsSnapshot, JobDto, ShotArtifactEntry } from "@aivideo/shared";
import { api, fileUrl, videoUrl } from "../api";
import { useToast } from "../hooks/useToasts";
import { PROVENANCE_LABELS, PROVENANCE_TONES, parseProvenance, provenanceHint, provenanceSummary } from "../labels";
import type { ProvenanceView } from "../labels";
import Chip from "./Chip";
import ConfirmDialog from "./ConfirmDialog";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染成片区（播放/下载/重渲）与产物目录提示。
 */
export default function DeliverPanel({
  job,
  artifacts,
  onChanged
}: {
  job: JobDto;
  artifacts: ArtifactsSnapshot | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [folderHint, setFolderHint] = useState<string | null>(null);
  const videoReady = artifacts?.videoReady ?? false;
  const videoStale = job.result?.videoStale === true;
  // 本片 BGM 的来源声明：audio 阶段写进 script.json，由服务端抬到快照顶层（bgmProvenance）。
  // BgmRow 与 CreditsBlock 两处都要用同一份收窄结果，抽出来避免各收窄一遍。
  const bgmProvenance = parseProvenance(artifacts?.bgmProvenance);

  // 重渲只跑 ffmpeg、不调用任何远端提供者，所以很快；
  // 但它是覆盖式操作：会重写现有成片，仍要人确认一次。
  const rerender = (): void => {
    setConfirming(false);
    setBusy(true);
    api
      .rerender(job.id)
      .then(() => {
        toast.success("已重新排队渲染");
        onChanged();
      })
      .catch((err: Error) => toast.error(`重渲排队失败：${err.message}`))
      .finally(() => setBusy(false));
  };

  const openFolder = (): void => {
    setFolderHint(null);
    api
      .openFolder(job.projectId)
      .then((res) => {
        if (!res.ok) {
          setFolderHint(`${res.hint ?? "未能打开文件管理器"}（路径：${res.path}）`);
        }
      })
      .catch((err: Error) => setFolderHint(err.message));
  };

  const storyboardCount = artifacts?.storyboard?.shots?.length ?? 0;
  const hasScript = artifacts?.script != null;
  const readyShots = (artifacts?.shots ?? []).filter(
    (entry) => entry.files.video || entry.files.image || entry.files.manifestAsset
  ).length;
  // 字幕/脚本一直在磁盘上，但此前只有成片一个下载口——文案工作者拿不到自己的东西。
  // 路径以服务端给的为准（字幕文件名来自 manifest），md 固定落在项目根。
  const captionsPath = artifacts?.manifest?.captionsFile ?? "captions/captions.srt";
  // 重渲是覆盖式写入，服务端在渲染前会把旧成片挪到 .prev 槽位；这里给出取回入口，
  // 否则用户点了「重新渲染」就等于把上一版永久丢掉。
  const previousVideoPath = artifacts?.previousVideoFile ?? null;
  const deliverables: Array<{ key: string; label: string; icon: typeof Download; href: string; file: string }> = [
    ...(artifacts?.captionsReady
      ? [{ key: "srt", label: "下载字幕", icon: Subtitles, href: fileUrl(job.id, captionsPath), file: "captions.srt" }]
      : []),
    ...(artifacts?.scriptMdReady
      ? [{ key: "md", label: "下载脚本", icon: FileText, href: fileUrl(job.id, "script.md"), file: "script.md" }]
      : []),
    ...(previousVideoPath
      ? [{ key: "prev", label: "下载上一版成片", icon: History, href: fileUrl(job.id, previousVideoPath), file: "上一版.mp4" }]
      : [])
  ];

  return (
    <section className="card deliver">
      <h2>
        交付{" "}
        {videoStale && <span className="badge stale">成片未反映最新编辑，需重新渲染</span>}
        {videoReady && !videoStale && <span className="badge done">可下载</span>}
      </h2>
      {videoStale && videoReady && (
        <div className="stale-bar" role="status">
          <TriangleAlert size={14} aria-hidden="true" />
          编辑已改动画面/旁白/字幕，当前在线播放的仍是旧版成片。
          <button className="primary" disabled={busy} onClick={() => setConfirming(true)}>
            <RotateCcw size={13} aria-hidden="true" />
            {busy ? "排队中…" : "重新渲染"}
          </button>
        </div>
      )}
      {videoReady ? (
        <>
          <div className="deliver-frame">
            <video controls preload="metadata" src={videoUrl(job.id)} />
          </div>
          <div className="actions">
            <a className="download-btn" href={videoUrl(job.id)} download={`${job.request.theme || job.id}.mp4`}>
              <Download size={14} aria-hidden="true" /> 下载成片
            </a>
            <span className="muted deliver-file" title={job.projectId}>
              <CirclePlay size={13} aria-hidden="true" /> {artifacts?.manifest?.outputFile ?? "final.mp4"}
            </span>
          </div>
        </>
      ) : job.request.generationMode === "script" ? (
        <div className="deliver-list">
          <div className={`deliver-row${hasScript ? " ok" : ""}`}>
            <CircleCheck size={14} aria-hidden="true" /> 脚本（script.json）{hasScript ? "已生成" : "待生成"}
          </div>
          <div className={`deliver-row${storyboardCount > 0 ? " ok" : ""}`}>
            <CircleCheck size={14} aria-hidden="true" /> 分镜 {storyboardCount > 0 ? `${storyboardCount} 个镜头` : "待生成"}（见上方镜头墙）
          </div>
          <div className="deliver-row muted">脚本模式不渲染视频，可在镜头墙审阅编辑后拿文案与分镜自行剪辑。</div>
        </div>
      ) : (
        <div className="deliver-list">
          <div className={`deliver-row${readyShots > 0 ? " ok" : ""}`}>
            <CircleCheck size={14} aria-hidden="true" /> 镜头画面 {readyShots}/{artifacts?.shots.length ?? 0} 已生成
          </div>
          <div className="deliver-row muted">渲染完成后，成片会出现在这里（播放 / 下载）。</div>
        </div>
      )}
      {deliverables.length > 0 && (
        <div className="actions">
          {deliverables.map((item) => (
            <a
              key={item.key}
              className="download-btn"
              href={item.href}
              download={`${job.request.theme || job.id}-${item.file}`}
            >
              <item.icon size={14} aria-hidden="true" /> {item.label}
            </a>
          ))}
        </div>
      )}
      <BgmRow job={job} bgm={artifacts?.bgm ?? null} provenance={bgmProvenance} ready={artifacts !== null} />
      <CreditsBlock shots={artifacts?.shots ?? []} bgm={bgmProvenance} />
      <div className="actions" style={{ marginTop: 8, alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12 }}>
          项目目录：project/{job.projectId}
        </span>
        <button onClick={openFolder}>
          <FolderOpen size={14} aria-hidden="true" /> 打开文件夹
        </button>
      </div>
      {folderHint && <div className="error-line" style={{ fontSize: 12 }}>{folderHint}</div>}
      <ConfirmDialog
        open={confirming}
        title="重新渲染成片"
        message="将强制重跑渲染阶段并覆盖当前成片。素材与配音不会重新生成；当前成片会保留一份为 final.prev.mp4，覆盖后仍可在此下载。确认继续？"
        confirmLabel="重新渲染"
        danger={false}
        busy={busy}
        onConfirm={rerender}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：背景音乐的试听/下载口与来源标注；成片已就绪却没有 BGM 时明示「本片无 BGM」，不默不作声。
 * 试听与下载都走 /api/projects/:id/file?path=…，与成片/素材共用一条读取通道（后端只回路径不回字节）。
 * 快照还没取到（ready=false）时整行不渲染：否则刷新瞬间会先闪一句「无 BGM」，把「还没拉到」说成「没有」。
 * 来源声明缺失时明说「来源未登记」而不是留白——曲子在盘上却不说它哪来的，等于把版权问题藏起来。
 * @param job 任务实体（id 即项目目录名，也是文件读取通道的路径段）
 * @param bgm 项目内相对路径（如 audio/bgm.mp3），由 artifacts 快照给出；无事则为 null
 * @param provenance 本片 BGM 的来源声明（script.bgmProvenance），未声明时为 null
 * @param ready 产物快照是否已取到
 */
function BgmRow({
  job,
  bgm,
  provenance,
  ready
}: {
  job: JobDto;
  bgm: string | null;
  provenance: ProvenanceView | null;
  ready: boolean;
}) {
  if (!ready) {
    return null;
  }
  if (!bgm) {
    return (
      <div className="bgm-row" role="status">
        <Music size={14} aria-hidden="true" />
        <span className="muted">本片无 BGM（未选曲，且未按脚本 BGM 风格从曲库匹配到曲目）</span>
      </div>
    );
  }
  // 下载名沿用背景音乐自身的扩展名：曲库素材可能是 wav/ogg，写死 .mp3 会存成打不开的文件。
  const ext = bgm.includes(".") ? bgm.slice(bgm.lastIndexOf(".") + 1) : "mp3";
  const href = fileUrl(job.id, bgm);
  return (
    <div className="bgm-row">
      <Music size={14} aria-hidden="true" />
      <span className="muted bgm-file" title={bgm}>
        背景音乐：{bgm}
      </span>
      {provenance ? (
        <Chip
          label={PROVENANCE_LABELS[provenance.kind]}
          title={provenanceHint(provenance)}
          tone={PROVENANCE_TONES[provenance.kind]}
        />
      ) : (
        <Chip label="来源未登记" title="脚本里没有这首曲子的来源声明（旧项目或历史运行）" tone="neutral" />
      )}
      <audio controls preload="none" src={href} />
      <a className="download-btn" href={href} download={`${job.request.theme || job.id}-bgm.${ext}`}>
        <Download size={14} aria-hidden="true" /> 下载 BGM
      </a>
    </div>
  );
}

/**
 * @author zhangbaohong  @date 2026-10-30  @see https://github.com/1241751430/AIVideo.git
 * 功能：交付面板的「素材来源」一栏：逐镜列出画面来源声明，末尾附 BGM。
 * 这是对外交付物的一部分——片子发出去之后，观众与平台有权利知道每个画面从哪来，因此不能只藏在悬停提示里。
 * 一条声明都没有时整块不渲染：旧项目不该凭空多出一栏空白，界面要与升级前一致。
 * @param shots 镜头条目（服务端已把 manifest 条目与对应分镜合并）
 * @param bgm 本片 BGM 的来源声明，未声明时为 null
 */
function CreditsBlock({ shots, bgm }: { shots: ShotArtifactEntry[]; bgm: ProvenanceView | null }) {
  const rows = shots
    .map((entry, index) => {
      const provenance =
        parseProvenance(entry.storyboard?.provenance) ?? parseProvenance(entry.provenance);
      if (!provenance) {
        return null;
      }
      const title = entry.storyboard?.title;
      const label = `镜头 ${index + 1}${typeof title === "string" && title.trim() ? `（${title}）` : ""}`;
      return { key: String(entry.shotId ?? index), label, provenance };
    })
    .filter((row): row is { key: string; label: string; provenance: ProvenanceView } => row !== null);
  if (rows.length === 0 && !bgm) {
    return null;
  }
  const credits = [
    ...rows,
    ...(bgm ? [{ key: "bgm", label: "全片 BGM", provenance: bgm }] : [])
  ];
  return (
    <div className="credits-block">
      <h3>
        <ShieldCheck size={14} aria-hidden="true" /> 素材来源与版权
      </h3>
      <ul>
        {credits.map((row) => (
          <li key={row.key}>
            <span className="credits-where">{row.label}</span>
            <Chip
              label={PROVENANCE_LABELS[row.provenance.kind]}
              tone={PROVENANCE_TONES[row.provenance.kind]}
              title={provenanceHint(row.provenance)}
            />
            <span className="muted credits-what">{provenanceSummary(row.provenance)}</span>
            {row.provenance.license && <span className="muted credits-license">许可 {row.provenance.license}</span>}
          </li>
        ))}
      </ul>
      <div className="credits-note">
        以上信息同时写在导出的 script.md「素材与版权清单」一节，随成片一起对外交付。
      </div>
    </div>
  );
}
