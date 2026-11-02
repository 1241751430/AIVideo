# 剧本、台词、素材与 BGM：产品方案与技术设计

> 目标：用户只描述一个场景或剧本，产出一份含**场景 / 镜头类型 / 台词**的完整脚本，台词一字不改，缺素材自动补齐（并标注版权来源），BGM 可自定义、没有就自己生成。
>
> 本文档是实施方案，不含代码改动。所有「现状」结论都附了 `文件:行` 证据，可逐条核对。

---

## 一、先看结论：这个产品现在缺什么

用户描述的产品是对的。但按当前代码，这四条需求里有三条**完全断在链路上**，不是「做得不够好」，是「根本没有通路」。逐条摆证据：

| # | 需求 | 现状 | 断在哪 |
|---|---|---|---|
| 1 | BGM 自定义 / 自动生成 | 混音引擎**已经写好了**，但没有任何代码往里放文件 | `workers/media/render.py:965` 的 `find_bgm` 找 `audio/bgm.{mp3,wav,aac,m4a,ogg}`；`grep -rn "bgm\." apps packages workers` 只命中 `render.py` 自己（读方）和 `test_render.py`（测试），**没有任何写入方**。`bgmStyle` 只是一段写进 `script.json` 的文字，从未影响成片 |
| 2 | 台词直通 + 多角色音色 | 数据结构里**没有台词位**，音色参数**通了但没人传** | `ScriptScene`（`packages/core/src/types.ts:52`）只有单个 `narration`；`NarrationSpeechProvider`（`packages/core/src/narration.ts:23`）接口**连 `voice` 都没声明**，`synthesizeNarration` 调用处（`narration.ts:92`）只传 `{text, outputPath}`。而 provider 侧明明支持：`LocalSpeechProvider` 用 `request.voice ?? "Tingting"`（`packages/providers/src/index.ts:740`），`ArkTTSSpeechProvider` 用 `request.voice ?? this.config.model`（`:852`） |
| 3 | 无参考图时自动生成素材 | 默认配置下**一定返回标题卡**，且界面不说 | `prepareGeneratedAssets`（`packages/core/src/workflow.ts:290`）在 `:310-314` 先算 `useVideo/useImage = provider?.isRemote`，默认档的 image/video 都是 noop（`index.ts:965,967` ，`isRemote=false`），于是直接 `return result`——一帧都不生成。用户以为在「生成视频」，实际拿到的是标题卡轮播 |
| 4 | 素材版权标注 | **零字段** | `grep -rnE "license\|版权\|copyright\|attribution\|sourceUrl\|provenance"` 在 `apps packages workers` 只命中 `packages/core/src/editing.ts:269` 的一行注释——那里的 "provenance rule" 指的是「素材路径指向哪张图」的规则，**不是版权字段**。`StoryboardShot.assetSource`（`types.ts:82`）只有 `reference_image\|generated_image\|title_card` 三态来源，不带 provider、license、sourceUrl |

还有**三个会在实施时踩到的陷阱**，同样已核实：

1. **换 BGM 不会重渲**：`renderStageFingerprint`（`packages/core/src/fingerprints.ts:203`）只把 `manifest.bgmStyle`（第 214 行，一个字符串）算进指纹，**不含 `audio/bgm.*` 文件本身**。用户换了一首曲子，指纹不变，`runRender`（`apps/server/src/jobs/stages.ts`）判 `match` 直接跳过。
2. **换音色不会重配**：`audioShotFingerprint`（`fingerprints.ts:185`）只算 `narration + durationSeconds + language`，**不含 voice**。切角色音色，wav 被当成「已复用」。
3. **清理会删掉用户的 BGM**：`cleanupRenderWorkspace`（`workflow.ts:581`）递归删 `audio`、`captions`、`.render_tmp` 整个目录。`cleanupAfterRender` 打开时（`apps/cli/src/cli.ts:399`），用户上传的 BGM 一起没。

**另一处静默降级**：混音失败只 `warn("BGM mix failed; keeping video without BGM")`（`render.py:958`），成片照出，用户不知道 BGM 没进去。

---

## 二、BGM：接上已有的混音引擎

### 2.1 为什么这是第一条

`render.py` 已经实现了**侧链压缩闪避**（`build_bgm_mix_command`，`workers/media/render.py:330`）：BGM 走 `volume=0.22`，再经 `sidechaincompress` 被人声压下，最后 `amix` 合成，视频流 `-c:v copy` 不重编码。这套东西是成品级的，缺的只是**输入端**。

所以第一条的工程量最小、产品感知最强：从「bgmStyle 只是文字」变成「真的有音乐」。

### 2.2 落点：`audio/bgm.<ext>`

不新增目录、不改 `render.py` 的查找逻辑，只需在 **audio 阶段**把文件写进 `audio/bgm.<ext>`。`find_bgm` 已支持 `mp3/wav/aac/m4a/ogg`。

单一事实来源放 `packages/core/src/shotFiles.ts`（该文件目前管 `assets/<id>.mp4`、`assets/<id>.png`、`audio/<id>.wav`，没有 BGM 助手）：

```ts
/** 项目内 BGM 的规范相对路径；扩展名取自实际文件。 */
export const PROJECT_BGM_BASENAME = "bgm";
export const PROJECT_BGM_EXTS = ["mp3", "wav", "aac", "m4a", "ogg"] as const;
export function findProjectBgm(projectDir: string): string | null;   // 返回相对路径或 null
export function projectBgmPath(projectDir: string, ext: string): string;
```

`shotFiles.ts` 里已有的 `manifestAssetPaths` 会排除越界路径，BGM 助手沿用同样的 `resolve` + 前缀校验写法。

### 2.3 四种来源，同一落点

| 来源 | 触发 | 行为 |
|---|---|---|
| `user_upload` | 用户在创建卡片或项目详情页上传音频 | 校验时长（≥ 成片时长的 1/2）与格式，落 `audio/bgm.<ext>`，`provenance.kind = "user_uploaded"` |
| `library` | `bgmStyle` 命中本地素材库标签 | 从 `assets/bgm-library/<style>.<ext>` 复制，零网络零成本，`provenance.kind = "library"` |
| `generated` | 以上都没有，且配置了音乐 provider | 调 `MusicProvider.synthesizeMusic({ prompt, durationSeconds, outputPath })`，`provenance.kind = "ai_generated"` |
| `none` | 三者皆不可用 | **不静默**：`bgmStyle` 原样保留，阶段日志与交付面板都明示「本片无 BGM（未配置音乐来源）」 |

### 2.4 新增能力面：`music`

当前 `Capability`（`packages/shared/src/index.ts:37`）是 `"text" | "image" | "video" | "speech"`，`ProviderProfileConfig`（`types.ts:186`）与 `ProviderSelection`（`types.ts:281`）同构。新增 `"music"`：

```ts
// packages/core/src/types.ts
export interface MusicGenerationRequest {
  prompt: string;
  outputPath: string;
  durationSeconds: number;
  /** 成片风格，来自 script.bgmStyle，供 provider 拼提示词 */
  style?: string;
}
export interface MusicProvider {
  readonly id: string;
  readonly capability: "music";
  readonly isRemote: boolean;
  test(options?: { live?: boolean }): Promise<ProviderHealth>;
  synthesizeMusic(request: MusicGenerationRequest): Promise<{ outputPath: string }>;
}
```

`ProviderSelection`、`ProviderProfileConfig`、`SummaryResponse.providers`（`shared`，前端据此渲染「音乐来源」一栏）同步加 `music`。

注册两个实现（`packages/providers/src/index.ts`，紧随现有 `speechProviderRegistry` 的写法）：

- `local-library-music`（`isRemote = false`）：按 `style` 关键词匹配 `assets/bgm-library/` 下的曲目，匹配不到返回 `null` 让上层跳过——**不抛错**，因为它只是「有就用」。
- `noop-music`（`isRemote = false`）：返回 `{ outputPath }` 但不产文件（与 `NoopImageProvider`，`index.ts:274` 同构），作为「已声明但未配置」的占位。

> 生成式音乐 API（Suno / 火山音乐等）不在第一版落地，但 `MusicProvider` 契约先定死，后续只是再加一个 `registry.set(...)`。**架构不欠债，实现可以晚到。**

### 2.5 指纹与清理的两处修正

**指纹**（`fingerprints.ts:203`）：把 BGM 文件纳入 render 指纹，用现成的 `describeRenderInput(projectDir, relativePath)`（它记录 `{ path, size, mtimeMs }`，文件缺失记 `null`）：

```ts
bgmStyle: manifest.bgmStyle,
bgm: describeRenderInput(input.projectDir, findProjectBgm(input.projectDir)),
```

这样换曲、删曲、改曲都会触发重渲。`STAGE_FINGERPRINTS_VERSION`（`fingerprints.ts:31`）**不必升**——载荷变了，老指纹自然失配，效果正是我们要的一次重渲。

**清理**（`workflow.ts:581`）：`audio/` 目录里现在混放着「可再生的中间产物」与「用户资产」。改为逐项清理、保留 BGM：

```ts
export function cleanupRenderWorkspace(projectDir: string): void {
  // 删 captions/ 与 .render_tmp/ 整个目录
  // 删 audio/ 下除 bgm.* 与 .segments/ 以外的全部内容，并删 .segments/
}
```

语义上要写进注释：**`audio/bgm.*` 是用户资产或外部产物，不是可再生的中间物**，清理阶段无权删除。

### 2.6 上传入口

`POST /api/projects/:id/bgm`（`apps/server/src/routes/projects.ts`，与现有 `media` 组并列）：

- 请求体即音频二进制，沿用分片上传链已经验证过的**魔数嗅探 + 短写循环 + `renameSync` 落定**（`apps/server/src/jobs/upload-store.ts`），只是嗅探表换成音频（`ID3`/`fLaC`/`OggS`/`RIFF…WAVE`/`ftyp`）。
- 大小上限独立配置，建议 20MB；时长用 `ffprobe` 校验，失败明确回 400 而不是静默接受。

创建卡片（`apps/web/src/components/CreateCard.tsx`）增加一个可选「背景音乐」块，复用 `apps/web/src/upload.ts` 的进度与取消能力——单文件，那套并发池自然退化成 1 路。

---

## 三、台词直通 + 多音色

### 3.1 数据模型

`ScriptScene`（`types.ts:52`）加**可选**字段（沿用 `StoryboardShot.inputImageIndex?`，`types.ts:83-87` 的「缺字段由读取方回退」先例，老项目 `script.json` 不用迁移）：

```ts
export interface ScriptRole {
  id: string;
  name: string;
  /** 音色标识，透传给 SpeechProvider.voice；缺省用项目默认音色 */
  voice?: string;
  /** 角色外观，供图像提示词做一致性锚点 */
  appearance?: string;
}

export interface ScriptLine {
  speaker?: string;          // 对应 ScriptRole.id；旁白/独白留空
  text: string;
  /** user = 用户原文，逐字使用，任何环节不得改写；generated = 模型生成 */
  src: "user" | "generated";
}

export interface ScriptScene {
  id: string;
  heading: string;
  narration: string;
  visualPrompt: string;
  shotType: string;
  durationSeconds: number;
  caption: string;
  lines?: ScriptLine[];      // 新增
}
```

`ScriptPackage` 加 `roles?: ScriptRole[]`。

**`narration` 与 `lines` 的关系要说清**：`lines` 存在时，`narration` 是「本镜的旁白/画外音」，`lines` 是「镜内对白」。两者都进配音，顺序为 `lines` 在前、`narration` 在后。`lines` 为空时行为与今天完全一致——这是兼容的关键。

### 3.2 提示词与归一化

**提示词**（`workflow.ts:708` `buildScriptSystemPrompt`，当前 `:717-718` 只要求 `title, summary, openingHook, voiceover, scenes, bgmStyle, cta, hashtags` 与 `id, heading, narration, visualPrompt, shotType, durationSeconds, caption`）：

新增要求：
- 顶层加 `roles`（不超过 4 个角色，每个含 `id/name/voice/appearance`）。
- 每镜加 `lines`（可为空数组）；台词要短，单条不超过 30 字；一个镜头内不超过 3 条。
- **若用户在 `brief` 里给了台词，必须原样放进对应的 `lines`，且 `src` 标 `"user"`，禁止润色、缩写、改写**。

`BRIEF_KEY_MAP`（`packages/core/src/brief.ts:14`）新增键：`dialogue` / `台词` / `对白` / `脚本台词` → `dialogue`；`bgm` / `音乐` / `背景音乐` → `bgm`。台词不经 `parseStructuredBrief` 的句子切分（它按 `[;\n；]` 切，会把多句台词切碎），需要一条**独立的整段摄取路径**。

**归一化**（`workflow.ts:793` `normalizeScriptPackage`）：这是「台词一字不改」的守门人。

```ts
// 台词不走 sanitizeText 的 trim + 空串回退
function normalizeLines(raw: unknown): ScriptLine[] {
  // 非数组 → []
  // 每条：text 必须是非空字符串，保留原样（不 trim 内部空白、不折叠换行）
  // src 缺失或无法识别 → "generated"；显式 "user" 一律保留
  // speaker 必须是已知角色 id，否则丢弃 speaker（不伪造）
  // 超长（> 30 字）的 user 台词照原样保留，只告警不改写
}
```

同时 `roles` 去重、`id` 只允许 `[\p{L}\p{N}_-]`（与 `shotFiles.ts:34` 的 `SHOT_ID_PATTERN` 同口径）、最多 4 个。

> **红线**：`src === "user"` 的台词，从进入系统到写进 `script.json` 到合成语音，**每一个环节都只能原样搬运**。任何 `sanitizeText` 式的规范化都要在 `src === "user"` 时短路。这条要写进测试。

### 3.3 音色传递链（四处改动，一条直线）

```
SpeechGenerationRequest.voice?   ← types.ts:270 已有，闲置
        ↓
NarrationSpeechProvider.synthesizeSpeech({ text, outputPath, voice? })   ← narration.ts:24 当前没有 voice
        ↓
synthesizeNarration 逐镜解析 voice                                     ← narration.ts:92
        ↓
LocalSpeechProvider / ArkTTSSpeechProvider                              ← 已支持，无需改
```

`voice` 的解析优先级（写在 `narration.ts`，单一事实来源）：

1. `line.speaker` → `roles[]` 里该角色的 `voice`
2. `shot.voice`（`StoryboardShot` 新增可选字段，允许逐镜覆盖）
3. profile 里 `speech` 提供者的默认音色（provider 自己兜底）

**Role → voice 的默认映射**要给出建议值，否则 4 个角色听起来是一把嗓子（`say` 只有 `Tingting` 默认）：

```ts
const DEFAULT_ROLE_VOICES = ["Tingting", "Meijia", "Sinji", "Li-mu"];  // macOS say 中文音色
```

Ark 侧 `voice_type` 是另一套 id，由 `config.model` 或 profile 配置提供；映射表放 provider 层，不放 core——**core 不该知道某个厂商的音色名字**。

### 3.4 一镜多角色如何合成（关键设计决策）

`RenderShot.audioPath` 是**单文件契约**，`render.py` 的 `build_clip_command` 只吃一个音频输入。要支持一镜多角色，有两条路：

| 方案 | 改动面 | 评价 |
|---|---|---|
| A. 渲染层多音频输入，`audioPath` 变数组 | `render.py` 的 `build_clip_command`/`prepare_shot_audio`/manifest 契约全改 | 收益是保留分段，但成片里根本听不出分段，**不值得** |
| B. 在 narration 阶段拼好，仍产出 `audio/<shotId>.wav` | 只改 `packages/core/src/narration.ts` | ✅ **选 B** |

B 的具体做法：

1. 每镜按顺序把 `lines` + `narration` 展开成 `[{text, voice}]` 序列。
2. 逐条合到 `audio/.segments/<shotId>.<i>.wav`（临时目录，`audio/` 下，随清理一并删除）。
3. 角色之间插入 200–300ms 静音（`anullsrc`），用 ffmpeg `concat` demuxer 拼成 `audio/<shotId>.wav`。
4. 删掉 `.segments/`。

好处：**`render.py` 零改动、`RenderShot` 契约零改动、指纹只需把 lines+voice 纳入载荷**。代价是丢了分段信息——但对成片无影响，且 `script.json` 里台词原文仍在。

> 若后续要做「单独重配某一句台词」，再引入分段保留（方案 A）。**第一版不预支这个复杂度。**

### 3.5 指纹修正（否则换音色不生效）

`audioShotFingerprint`（`fingerprints.ts:185`）：

```ts
export function audioShotFingerprint(input: {
  shot: { narration: string; durationSeconds?: number; lines?: ScriptLine[]; voice?: string };
  roles?: ScriptRole[];
  language?: string;
}): string {
  return fingerprintOf({
    stage: "audio",
    narration: input.shot.narration,
    durationSeconds: input.shot.durationSeconds ?? null,
    language: input.language ?? "",
    voice: input.shot.voice ?? "",
    lines: (input.shot.lines ?? []).map((line) => ({
      text: line.text,
      speaker: line.speaker ?? "",
      src: line.src,
      // 角色音色是解析链的一环，角色定义变了也必须重配
      voice: resolveVoice(line, input.roles) ?? ""
    }))
  });
}
```

### 3.6 编辑失效矩阵

`packages/core/src/editing.ts` 的 `updateShot` 现在算 `audioInvalidated = narrationChanged || durationChanged`。加台词后：

```ts
const audioInvalidated = narrationChanged || durationChanged || linesChanged || voiceChanged;
const assetInvalidated = visualPromptChanged;   // 台词不影响画面
```

`ShotEditBody`（`packages/shared/src/index.ts`）加 `lines?: ScriptLine[]`、`voice?: string`。编辑端（`apps/web/src/components/ShotWall.tsx`）在台词区按 `src` 区分展示：`user` 的台词**只读并标「用户原文」**，`generated` 的可编辑。

---

## 四、素材自动补齐 + 版权

### 4.1 先修「期待与产出不符」

`prepareGeneratedAssets` 的 early-return（`workflow.ts:310-314`）本身是对的——noop provider 不该被调用。**真正的问题是它静默**：用户点「生成视频」，拿到标题卡轮播，全程没有任何地方说「本片未使用 AI 素材」。

改法不是删掉 early-return，而是**把事实显式化**——扩展已有的 `AssetPrepResult`（`workflow.ts:236` 定义、`:300` 构造，字段为 `attempted/succeeded/failed/reused/videoSucceeded/imageSucceeded`）：

```ts
export interface AssetPrepResult {
  attempted: number;
  succeeded: number;
  failed: number;
  reused: number;
  videoSucceeded: number;
  imageSucceeded: number;
  /** 新增：本次为何没有生成素材（三处 return 各自的理由，不再共用同一个空结果） */
  skippedReason?: "no-remote-provider" | "all-shots-bound-to-reference" | "no-shots";
}
```

`runAssets`（`stages.ts`，当前空转时只打「本地提供者可出片：素材阶段无需调用远端」）改成明确措辞：

> 「未配置图片/视频模型，本片将由标题卡构成。要生成画面请在配置档中启用 image 或 video 提供者。」

并在 `JobDto` 或 artifacts 快照里带 `assetMode: "generated" | "mixed" | "title-card"`，工作台顶部据此渲染一条常驻提示。**让用户知道自己在看什么，比多生成几张图更重要。**

### 4.2 补齐策略

`buildStoryboard`（`workflow.ts:850`）当前 `ownsImage = Boolean(request.images && index < request.images.length)`，其余镜 `assetSource` 落到 `generated_image`（video 模式）或 `title_card`。补齐逻辑第一版只做一件事：

- 有远端 image/video 能力时，`generated_image` 的镜头**全部**尝试生成（今天已经是这样）。
- 无远端能力时，**不再叫 `generated_image`**——`assetSource` 应该诚实地是 `title_card`。当前 `buildStoryboard` 在 video 模式下无条件标 `generated_image`，这是一个**语义谎言**，会导致 UI 显示「AI 生成」而实际是卡片。

> 这条要单独立项修，它比「自动补齐」更急：**误导比缺失更伤信任。**

### 4.3 版权来源字段

```ts
export interface AssetProvenance {
  kind: "user_uploaded" | "ai_generated" | "stock" | "library";
  /** 生成方/来源方 id，如 "openai-compatible-image"、"pexels" */
  provider?: string;
  /** 许可证标识，如 "CC0-1.0"、"CC-BY-4.0"、"provider-terms" */
  license?: string;
  /** 原始出处链接（网页素材必填） */
  sourceUrl?: string;
  /** 展示用署名文本，如 "Photo by Jane Doe / Pexels" */
  attribution?: string;
  /** 获取时间（ISO 8601），用于许可证版本追溯 */
  retrievedAt?: string;
}
```

挂载点：

- `StoryboardShot.provenance?: AssetProvenance`
- `RenderShot.provenance?: AssetProvenance`（渲染清单里也要有，否则交付面板读不到）
- `ScriptPackage` 级 BGM：`bgmProvenance?: AssetProvenance`

**校验规则**（在 `normalizeScriptPackage` 与 `buildRenderManifest` 里强制）：

- `kind === "stock"` 时 `sourceUrl` 与 `license` **必填**，缺一个就拒绝落到分镜（抛明确错误，不静默丢弃）。
- `kind === "ai_generated"` 时 `provider` 必填。
- `kind === "user_uploaded"` 时 `license` 缺省为 `"user-provided"`。

**呈现**：

- 工作台镜头墙每镜来源徽标（`ShotWall.tsx` 已在 `:339` 附近展示 `assetSource`），改为展示 `provenance.kind` + 悬停显示 `license / attribution / sourceUrl`。
- 交付面板增加「素材来源」一栏，`attribution` 为空时显示「AI 生成（provider）」而非空白。
- `script.md`（导出文稿）末尾附「素材与版权清单」表格——**这是对外交付物，版权标注必须跟着走**。

### 4.4 网络素材：第一版只留接口

用户提到「可以从网络上进行查找，但需要备注版权问题」。这里要克制：

- 自动抓取网络图并重分发**有法律风险**（多数搜索引擎结果的许可不允许商用，且平台 ToS 禁止抓取）。
- 第一版不做自动网络检索。但 `provenance.kind = "stock"` + `sourceUrl` + `license` 的字段先落地，**为将来接 Pexels / Unsplash / Pixabay 这类明确 CC0/自有许可的 API 留好位置**。
- 接入时的硬约束：**无 license 的素材一律不进分镜**。宁可出标题卡，不要出侵权片。

---

## 五、跨切面：线协议与迁移

### 5.1 需要改的类型清单

| 文件 | 改动 |
|---|---|
| `packages/core/src/types.ts` | `ScriptRole`/`ScriptLine`/`AssetProvenance` 新增；`ScriptScene.lines?`、`ScriptPackage.roles?`/`bgmProvenance?`、`StoryboardShot.lines?`/`voice?`/`provenance?`、`RenderShot.provenance?`；`MusicProvider`/`MusicGenerationRequest`；`Capability` 加 `"music"`；`ProviderProfileConfig.music?`、`ProviderSelection.music?` |
| `packages/shared/src/index.ts` | `Capability` 加 `"music"`；`ShotEditBody` 加 `lines?`/`voice?`；新增 `BgmUploadResponse`、`UpdateBgmBody`；`ShotArtifactEntry` 带 `provenance` |
| `packages/providers/src/index.ts` | 注册 `local-library-music`、`noop-music`；`createProviderSelection`（`:1038`）与 `testProviders`（`:1056`）各加一路 `music` |
| `packages/core/src/workflow.ts` | 提示词、`normalizeScriptPackage`、`buildStoryboard` 的 `assetSource` 诚实化、`buildRenderManifest` 带 `provenance`、`prepareGeneratedAssets` 返回 `skippedReason`、`cleanupRenderWorkspace` 保留 BGM |
| `packages/core/src/narration.ts` | voice 解析、逐条合成与拼接、指纹载荷 |
| `packages/core/src/fingerprints.ts` | `audioShotFingerprint` 加 voice/lines；`renderStageFingerprint` 加 bgm 文件 |
| `packages/core/src/shotFiles.ts` | `findProjectBgm`/`projectBgmPath`（BGM 路径的单一事实来源） |
| `packages/core/src/config.ts` | 各内置 profile 加 `music`（默认档给 `local-library-music`，其余档可留空）；`validateConfig`（`:410`）的 profile 引用检查是 `Object.entries` 泛型的，加字段无需改，但 provider 定义里的 `capability: "music"` 要一并补 |
| `packages/core/src/brief.ts` | `BRIEF_KEY_MAP` 加台词/BGM 键；整段台词摄取 |
| `packages/core/src/editing.ts` | 失效矩阵加 lines/voice |
| `apps/server/src/jobs/stages.ts` | `runAudio` 传 roles、新增 `runBgm`（或在 audio 阶段末尾）、`runAssets` 明确空转措辞 |
| `apps/server/src/routes/projects.ts` | `POST /:id/bgm`、`DELETE /:id/bgm` |
| `apps/server/src/routes/system.ts` | `GET /api/summary` 的 `providers` 补 `music`（当前 `:48` 只列四项，而 `SummaryResponse.providers` 是 `Record<Capability, …>`，加 `music` 后**不加这里会编译不过**） |
| `apps/server/src/routes/create-request.ts` | 接受 `bgmUploadId`（可选） |
| `apps/web/src/components/{CreateCard,ScriptEditor,ShotWall,DeliveryPanel}.tsx` | BGM 上传块、角色音色编辑、台词分区展示、素材来源栏、标题卡模式提示 |

### 5.2 迁移代价（老项目）

- `script.json` / `storyboard.json` / `render-manifest.json` **不需要脚本迁移**：全部新字段可选，读取方回退到 `narration` / 无 provenance。
- 首次运行新版本会触发**一次** `audio` + `render` 阶段重跑（指纹载荷变了）。这是预期行为，`runAudio` 日志会显示「合成 N / 复用 0」。
- **不做** `STAGE_FINGERPRINTS_VERSION` 升版：载荷变化已足够让旧指纹失配，升版会让 `script` 阶段也无谓重跑。
- `cleanupRenderWorkspace` 语义变化对老项目无副作用（老项目本来就没有 `audio/bgm.*`）。

### 5.3 兼容性红线

- **`lines` 为空时，一切行为与今天逐字节相同。** 这是判据：老项目重跑产物应完全一致。
- **`src === "user"` 的台词逐字不改**，包括标点、空格、换行。
- **`provenance.kind === "stock"` 缺 `license`** → 拒绝，不降级。

---

## 六、实施顺序与验收

按依赖与风险排序，每步独立可交付、可回滚：

| 步骤 | 内容 | 验收 |
|---|---|---|
| **S1** | 指纹修正（bgm 文件 + voice 入载）+ `cleanupRenderWorkspace` 保留 BGM | 单测：改 bgm 文件 → `renderStageFingerprint` 变化；cleanup 后 `audio/bgm.mp3` 仍在 |
| **S2** | `shotFiles` 的 BGM 助手 + `POST/DELETE /:id/bgm` + 创建卡片上传块 | 上传 mp3 后成片确实混入 BGM（人声处 BGM 被压）；混音失败时**日志与界面明确报错**而非静默 |
| **S3** | `music` 能力面 + `local-library-music` provider + `runBgm` 阶段 | 未上传 BGM 时按 `bgmStyle` 从素材库取；取不到时界面明示「无 BGM」 |
| **S4** | 台词模型（types + 提示词 + `normalizeScriptPackage`）+ 台词直通测试 | `src="user"` 台词在 `script.json` 中**逐字节等于用户输入**；非空 `lines` 时 `narration` 兼容 |
| **S5** | voice 传递链 + 逐条合成拼接 + 编辑失效矩阵 | 两角色对话音色不同；换音色触发重配；`audio/<id>.wav` 仍为单文件 |
| **S6** | `provenance` 字段 + 校验 + 界面/导出呈现 | stock 缺 license 被拒；交付面板与 `script.md` 都能看到来源 |
| **S7** | `prepareGeneratedAssets` 显式化 + `assetSource` 诚实化 | 默认配置下界面明示「标题卡模式」，不再出现「AI 生成」字样而实际是卡片 |

每步完成后跑：`pnpm build && pnpm test && bash scripts/check-headers.sh`。

> `check-headers.sh` 要求每个 `.ts` 文件 `@author zhangbaohong` + 仓库 URL，且 `authors` 注释数**严格大于** `funcs` 数。新增函数时要同步补头部注释，否则 CI 会挂。

---

## 七、这一版刻意不做的事

写清楚边界，比许愿更有价值：

1. **生成式音乐 API 接入**——契约先定，实现后置。真正可用的第一版是「用户上传 + 本地素材库」，这两条已经能覆盖大部分场景。
2. **网络素材自动检索**——法律风险高于收益，只留字段与接口。
3. **一镜内分段音频保留**——成片听不出分段，不值得破坏 `audioPath` 单文件契约。
4. **角色外观一致性（同一个人在每镜长得一样）**——这是图像模型侧的难题，需要 reference image / LoRA / IP-Adapter，不是产品层能解决的。第一版只把 `roles[].appearance` 拼进 `visualPrompt`，效果取决于模型。
5. **BGM 智能卡点（对拍剪辑）**——需要节拍检测 + 镜头时长回写，属于后期能力。

---

## 八、一句话总结

`render.py` 早就写好了侧链闪避混音，`providers` 早就支持了 `voice`，`ScriptScene` 只差一个 `lines` 字段。真正要做的是**把已经存在的能力接上**，外加三件新东西：`provenance` 版权字段、`music` 能力面、以及把「静默降级」全部改成「明说」。

按 S1→S7 推进，每一步都能独立上线。