import { SkillDefinition } from "./types.js";

export const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    id: "marketing",
    name: "通用营销",
    description: "适合新品传播、活动推广和品牌曝光。",
    suitableFor: ["品牌曝光", "新品发布", "活动促销"],
    tone: "节奏快、利益点明确、口吻利落",
    copyRules: ["前三秒抛出痛点", "每段只强调一个卖点", "结尾给明确行动指令"],
    shotRules: ["多用特写和局部细节", "卖点镜头切换快", "字幕突出核心关键词"],
    hooks: ["你还在用老办法解决这个问题吗？", "这件事做对了，效率直接翻倍。"],
    ctas: ["现在就试试", "马上了解详情", "评论区告诉我你的场景"],
    platformRules: {
      douyin: ["口语化", "短句高密度"],
      xiaohongshu: ["种草语气", "强调真实体验"],
      youtube: ["信息密度更高", "段落过渡清楚"]
    }
  },
  {
    id: "ecommerce",
    name: "带货种草",
    description: "适合电商转化、商品展示和种草安利。",
    suitableFor: ["直播切片", "商品种草", "优惠促销"],
    tone: "强转化、强调前后对比和购买理由",
    copyRules: ["快速给出使用场景", "说明差异化卖点", "结尾抛福利或购买理由"],
    shotRules: ["开头上效果图", "中段展示细节和使用方法", "结尾强调价格或福利"],
    hooks: ["这类产品我已经帮你筛过了。", "如果你只买一件，就看这个。"],
    ctas: ["点进来直接下单", "先领券再买", "收藏起来别错过"],
    platformRules: {
      douyin: ["突出转化", "弱化长解释"],
      xiaohongshu: ["突出体验", "强调使用前后"],
      kuaishou: ["接地气", "福利表达更直接"]
    }
  },
  {
    id: "knowledge",
    name: "知识口播",
    description: "适合知识分享、方法论总结和专业建议。",
    suitableFor: ["干货科普", "经验分享", "行业观点"],
    tone: "专业但不端着，强调结构清晰",
    copyRules: ["先抛结论再解释", "内容分点", "保留可执行建议"],
    shotRules: ["口播主画面稳定", "插入关键词卡片", "信息点适合字幕强化"],
    hooks: ["这件事其实大多数人都理解反了。", "三句话讲清楚这个核心问题。"],
    ctas: ["需要我继续拆下一部分就留言", "关注我，后面继续展开"],
    platformRules: {
      bilibili: ["可以更完整", "逻辑递进更强"],
      douyin: ["结论前置", "减少铺垫"],
      youtube: ["信息组织分段明显", "保留复盘总结"]
    }
  },
  {
    id: "drama",
    name: "短剧情绪",
    description: "适合情绪冲突、故事反转和强代入表达。",
    suitableFor: ["情绪表达", "人物冲突", "剧情化叙事"],
    tone: "情绪浓、画面感强、带悬念",
    copyRules: ["开头制造冲突", "中段推进矛盾", "结尾反转或留钩子"],
    shotRules: ["多用中近景和情绪特写", "画面切换跟随情绪", "字幕保留关键对白"],
    hooks: ["我以为这只是一次普通对话。", "直到那一刻，我才知道自己想错了。"],
    ctas: ["如果是你会怎么选", "下一集我继续讲后面发生的事"],
    platformRules: {
      douyin: ["冲突要更早", "留悬念"],
      xiaohongshu: ["更偏情绪感受", "真实细节"],
      youtube: ["可适当增加铺垫", "更完整的人物动机"]
    }
  },
  {
    id: "brand",
    name: "企业宣传",
    description: "适合公司介绍、产品定位和品牌形象内容。",
    suitableFor: ["企业宣传", "品牌介绍", "产品亮点"],
    tone: "专业、可信、有节奏感",
    copyRules: ["先讲价值再讲能力", "避免空泛口号", "结尾给合作或了解入口"],
    shotRules: ["展示场景、团队、产品细节", "使用稳重转场", "字幕偏简洁"],
    hooks: ["把复杂问题做简单，是我们的核心能力。", "一支团队，持续把这件事做到更好。"],
    ctas: ["欢迎进一步了解", "联系我们获取方案", "查看更多案例"],
    platformRules: {
      youtube: ["叙事完整", "品牌信息更系统"],
      bilibili: ["适当增加案例", "更具体"],
      wechat: ["表述稳重", "信息可信"]
    }
  },
  {
    id: "tutorial",
    name: "教程演示",
    description: "适合操作步骤、教学流程和产品演示。",
    suitableFor: ["软件教程", "工具演示", "操作指南"],
    tone: "清楚、可执行、避免废话",
    copyRules: ["开头说明结果", "中段分步骤", "结尾补充注意事项"],
    shotRules: ["一镜一重点", "镜头跟随步骤变化", "字幕保留序号和动作"],
    hooks: ["一分钟教你直接上手。", "别再浪费时间试错了，按这个顺序来。"],
    ctas: ["照着做一遍就会", "需要模板我可以继续给你"],
    platformRules: {
      douyin: ["步骤更短", "结果优先"],
      bilibili: ["可以更完整", "补充注意事项"],
      youtube: ["结构更完整", "增加前后总结"]
    }
  }
];

const KEYWORD_MAP: Record<string, string[]> = {
  ecommerce: ["下单", "优惠", "种草", "商品", "爆款", "价格", "购买", "带货"],
  knowledge: ["方法", "教程", "知识", "经验", "思路", "复盘", "分析", "技巧"],
  drama: ["情绪", "故事", "反转", "关系", "冲突", "遗憾", "爱", "吵架"],
  brand: ["公司", "品牌", "企业", "团队", "服务", "解决方案", "案例"],
  tutorial: ["操作", "步骤", "演示", "安装", "配置", "上手"],
  marketing: ["推广", "营销", "宣传", "活动", "转化", "增长", "曝光"]
};

export function getSkillById(skillId: string): SkillDefinition | undefined {
  return BUILTIN_SKILLS.find((skill) => skill.id === skillId);
}

export function autoSelectSkill(input: {
  theme?: string;
  content?: string;
}): SkillDefinition {
  const corpus = `${input.theme ?? ""}\n${input.content ?? ""}`.toLowerCase();
  const scores = new Map<string, number>();

  for (const skill of BUILTIN_SKILLS) {
    let score = 0;
    for (const keyword of KEYWORD_MAP[skill.id] ?? []) {
      if (corpus.includes(keyword)) {
        score += 2;
      }
    }
    for (const phrase of skill.suitableFor) {
      if (corpus.includes(phrase.toLowerCase())) {
        score += 3;
      }
    }
    scores.set(skill.id, score);
  }

  const [best] = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  if (!best || best[1] === 0) {
    return BUILTIN_SKILLS[0]!;
  }
  return getSkillById(best[0]) ?? BUILTIN_SKILLS[0]!;
}
