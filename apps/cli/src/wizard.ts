/**
 * @file wizard.ts
 * @author zhangbaohong
 * @date 2026-09-17
 * @description 交互式 create 向导（@clack TUI）：快速/高级两条流程收集生成选项并做计费确认
 * @see https://github.com/1241751430/AIVideo.git
 */
import * as p from "@clack/prompts";
import {
  AppConfig,
  BUILTIN_SKILLS,
  SUPPORTED_ASPECT_RATIOS,
  ProviderSelection
} from "@aivideo/core";
import { createProviderSelection } from "@aivideo/providers";
import { parseDuration, parseImages, parseStructuredBrief } from "./options.js";

type WizardOptions = Record<string, string | boolean>;

/** Sentinel returned by a step to jump back to the previous question. */
const BACK_SYMBOL = Symbol("wizard-back");
const BACK_SENTINEL = "__clack_back__";

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：驱动整个交互式创建向导，返回 runGenerate 所需选项；取消或非 TTY 时返回 undefined
 * @param cwd 工作目录
 * @param config 全局应用配置（提供默认值与模型展示）
 */
/**
 * Interactive "create" wizard (@clack TUI). Returns the option map for
 * `runGenerate`, or `undefined` when the user cancelled or the session is not
 * attached to a TTY.
 */
export async function runCreateWizard(cwd: string, config: AppConfig): Promise<WizardOptions | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(
      "交互式 create 需要终端环境。请改用非交互命令：./aivideo generate --brief \"主题：...；视频时长：30s\""
    );
    return undefined;
  }

  p.intro("AI Video 快速创建");
  try {
    const brief = await askText("描述你想做的视频（支持结构化 brief；留空进入高级模式）", {
      placeholder: "主题：夏季防晒喷雾；视频时长：30s"
    });
    if (brief === undefined) {
      return cancelWizard();
    }
    // "/back" on the opening question just means "start over" -> advanced mode.
    const hasBrief = typeof brief === "string" && brief.length > 0;

    let options: WizardOptions | undefined;
    if (hasBrief) {
      options = await quickFlow(config, cwd, parseStructuredBrief(brief));
    } else {
      options = await advancedFlow(config, cwd);
    }
    if (!options) {
      return cancelWizard();
    }

    if (!(await confirmBilling(config, options))) {
      return cancelWizard();
    }
    p.outro("开始生成视频...");
    return options;
  } catch (error) {
    p.cancel(`创建向导中断：${(error as Error).message}`);
    return undefined;
  }
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：打印取消提示并返回 undefined，作为向导各步骤取消的统一出口
 */
function cancelWizard(): undefined {
  p.cancel("已取消，未生成任何内容。");
  return undefined;
}

// ---------------------------------------------------------------------------
// Quick flow: structured brief -> optional duration -> reference images
// ---------------------------------------------------------------------------

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：快速流程——在 brief 基础上补问时长并收集参考图，取消返回 undefined
 * @param config 全局应用配置（提供默认时长）
 * @param cwd 工作目录
 * @param options 已由 brief 解析出的初始选项（就地修改并返回）
 */
async function quickFlow(
  config: AppConfig,
  cwd: string,
  options: WizardOptions
): Promise<WizardOptions | undefined> {
  if (!options.duration) {
    while (true) {
      const duration = await askText("视频时长", {
        placeholder: `${config.defaults.durationSeconds}s（留空使用默认）`,
        validate: (value) =>
          !value || parseDuration(value) ? undefined : "时长格式不正确，例如 15s、30s"
      });
      if (duration === undefined) {
        return undefined;
      }
      if (duration === BACK_SYMBOL) {
        continue;
      }
      if (duration && parseDuration(duration)) {
        options.duration = duration;
      }
      break;
    }
  }

  const images = await collectImages(cwd);
  if (!images) {
    return undefined;
  }
  if (images.length > 0) {
    options.images = images.join(",");
  }
  options.mode = "video";
  return options;
}

// ---------------------------------------------------------------------------
// Advanced flow: step-by-step with /back navigation
// ---------------------------------------------------------------------------

interface AdvancedStep {
  key: string;
  run: () => Promise<string | undefined | typeof BACK_SYMBOL>;
  /** Value used when the user submits an empty answer. */
  emptyValue?: string;
  required?: boolean;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：高级流程——逐项提问、支持 /back 回退，最后收集参考图并汇总为选项
 * @param config 全局应用配置（提供各项默认值）
 * @param cwd 工作目录
 */
async function advancedFlow(config: AppConfig, cwd: string): Promise<WizardOptions | undefined> {
  const steps: AdvancedStep[] = [
    {
      key: "theme",
      required: true,
      run: () =>
        askText("请输入视频主题", {
          validate: (value) => (value ? undefined : "主题不能为空")
        })
    },
    {
      key: "content",
      run: () => askText("请描述你想重点表达的内容（留空跳过）")
    },
    {
      key: "skill",
      run: () =>
        askSelect(
          "内容风格 Skill",
          [
            { value: "auto", label: "自动选择（推荐）" },
            ...BUILTIN_SKILLS.map((skill) => ({ value: skill.id, label: `${skill.name}（${skill.id}）` }))
          ],
          "auto"
        )
    },
    {
      key: "aspect",
      run: () =>
        askSelect(
          "视频比例",
          SUPPORTED_ASPECT_RATIOS.map((ratio) => ({ value: ratio })),
          config.defaults.aspectRatio
        )
    },
    {
      key: "duration",
      emptyValue: `${config.defaults.durationSeconds}s`,
      run: () =>
        askText("视频时长（例如 15s、30s）", {
          placeholder: `${config.defaults.durationSeconds}s（留空使用默认）`,
          validate: (value) =>
            !value || parseDuration(value) ? undefined : "时长格式不正确，例如 15s、30s"
        })
    },
    {
      key: "language",
      run: () =>
        askText("内容语言（留空自动识别）", { placeholder: "zh-CN / en-US / ja-JP" })
    },
    {
      key: "platform",
      emptyValue: config.defaults.platform,
      run: () =>
        askText("目标平台（留空使用默认）", { placeholder: `${config.defaults.platform}（默认）` })
    }
  ];

  const answers: Record<string, string> = {};
  let index = 0;
  while (index < steps.length) {
    const step = steps[index]!;
    const value = await step.run();
    if (value === BACK_SYMBOL) {
      index = Math.max(0, index - 1);
      continue;
    }
    if (value === undefined) {
      return undefined; // cancelled
    }
    const resolved = value || step.emptyValue || "";
    if (resolved) {
      answers[step.key] = resolved;
    } else if (step.required) {
      continue; // required step got nothing: re-ask
    }
    index += 1;
  }

  const images = await collectImages(cwd);
  if (!images) {
    return undefined;
  }

  const options: WizardOptions = { mode: "video" };
  for (const key of ["theme", "content", "skill", "aspect", "duration", "language", "platform"]) {
    const value = answers[key];
    if (value) {
      options[key] = value;
    }
  }
  if (images.length > 0) {
    options.images = images.join(",");
  }
  return options;
}

// ---------------------------------------------------------------------------
// Reference images (shared by both flows)
// ---------------------------------------------------------------------------

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：询问是否上传参考图并循环收集经校验的本地图片路径，取消返回 undefined
 * @param cwd 工作目录（解析相对图片路径）
 */
async function collectImages(cwd: string): Promise<string[] | undefined> {
  const wants = await p.confirm({
    message: "是否需要上传参考图片？",
    initialValue: false,
    active: "是",
    inactive: "否"
  });
  if (p.isCancel(wants)) {
    return undefined;
  }
  if (!wants) {
    return [];
  }

  const images: string[] = [];
  while (true) {
    const input = await askText(
      images.length === 0
        ? "输入本地图片路径（png/jpg/jpeg/webp），留空完成"
        : `已添加 ${images.length} 张，输入下一张路径，留空完成`,
      {
        validate: (value) => {
          if (!value) {
            return undefined;
          }
          try {
            parseImages(value, cwd);
            return undefined;
          } catch (error) {
            return (error as Error).message;
          }
        }
      }
    );
    if (input === undefined) {
      return undefined;
    }
    if (input === BACK_SYMBOL) {
      continue;
    }
    if (!input) {
      return images;
    }
    const [imagePath] = parseImages(input, cwd) ?? [];
    if (imagePath) {
      images.push(imagePath);
      p.log.info(`已添加图片：${imagePath}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Billing confirmation page
// ---------------------------------------------------------------------------

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：渲染配置与计费确认页，仅当用户明确确认时返回 true
 * @param config 全局应用配置（用于装配提供者展示计费项）
 * @param options 向导收集到的生成选项
 */
async function confirmBilling(config: AppConfig, options: WizardOptions): Promise<boolean> {
  const providers = createProviderSelection(config);
  const lines: string[] = [];
  const push = (label: string, value: string | undefined) => {
    if (value) {
      lines.push(`${label}：${value}`);
    }
  };

  push("主题", asString(options.theme));
  push("主要内容", asString(options.content));
  push("风格", asString(options.skill) ?? "auto");
  push("比例", asString(options.aspect) ?? config.defaults.aspectRatio);
  push(
    "时长",
    asString(options.duration)
      ? `${asString(options.duration)}`
      : `${config.defaults.durationSeconds}s`
  );
  push("语言", asString(options.language) ?? "自动识别");
  push("平台", asString(options.platform) ?? config.defaults.platform);
  const imageCount = asString(options.images) ? asString(options.images)!.split(",").filter(Boolean).length : 0;
  if (imageCount > 0) {
    lines.push(`参考图片：${imageCount} 张`);
  }
  const entries = providerEntries(providers);
  for (const [capability, provider, remote] of entries) {
    lines.push(`${capability} 模型：${provider.id}${remote ? "（远程调用，按量计费）" : "（本地免费）"}`);
  }

  p.note(lines.join("\n"), "即将生成视频（请确认配置与计费）");
  const anyRemote = entries.some((entry) => entry[2]);
  const confirmed = await p.confirm({
    message: anyRemote ? "图像/视频生成会调用远程计费接口，确认开始？" : "确认开始生成？",
    initialValue: true,
    active: "开始生成",
    inactive: "取消"
  });
  if (p.isCancel(confirmed)) {
    return false;
  }
  return confirmed === true;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：把四类已选提供者整理为 [能力名, 提供者, 是否远程计费] 列表供确认页展示
 */
function providerEntries(
  providers: ProviderSelection
): Array<[string, { id: string }, boolean]> {
  const entries: Array<[string, { id: string }, boolean]> = [];
  for (const capability of ["text", "image", "video", "speech"] as const) {
    const provider = providers[capability];
    if (provider) {
      const remote = (provider as { isRemote?: boolean }).isRemote === true;
      entries.push([capability, provider, remote]);
    }
  }
  return entries;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：仅当选项值为字符串时原样返回，否则返回 undefined
 */
function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Prompt helpers: unified cancel / /cancel / /back handling
// ---------------------------------------------------------------------------

interface TextConfig {
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：封装文本提问，统一处理取消（Ctrl+C 或 "/cancel"）与 "/back" 回退
 * @param message 提问文案
 * @param config 占位符与校验器配置
 * @returns 去空白后的答案；取消返回 undefined，回退返回 BACK_SYMBOL
 */
/**
 * Asks a text question. Returns the trimmed answer ("" when the user just
 * pressed Enter), `undefined` on cancel (Ctrl+C or "/cancel"), or
 * `BACK_SYMBOL` on "/back".
 */
async function askText(message: string, config: TextConfig = {}): Promise<string | undefined | typeof BACK_SYMBOL> {
  const value = await p.text({
    message,
    placeholder: config.placeholder,
    validate: config.validate ? (raw: string | undefined) => config.validate!(raw ?? "") : undefined
  });
  if (p.isCancel(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "/cancel") {
    return undefined;
  }
  if (trimmed === "/back") {
    return BACK_SYMBOL;
  }
  return trimmed;
}

/**
 * @author zhangbaohong  @date 2026-09-17  @see https://github.com/1241751430/AIVideo.git
 * 功能：封装选择提问，自动附加「返回上一步」选项并归一化取消/回退
 * @param message 提问文案
 * @param options 候选项列表
 * @param initialValue 初始选中值
 * @returns 选中值；取消返回 undefined，回退返回 BACK_SYMBOL
 */
async function askSelect(
  message: string,
  options: Array<{ value: string; label?: string }>,
  initialValue?: string
): Promise<string | undefined | typeof BACK_SYMBOL> {
  const value = await p.select({
    message,
    options: [...options, { value: BACK_SENTINEL, label: "« 返回上一步（/back）" }],
    initialValue
  });
  if (p.isCancel(value)) {
    return undefined;
  }
  if (value === BACK_SENTINEL) {
    return BACK_SYMBOL;
  }
  return String(value);
}
