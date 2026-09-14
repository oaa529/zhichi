/**
 * @file PromptBuilder.ts
 * 动态 Prompt 构造器。
 *
 * 职责：
 * - 根据 ICharacterProfile 构造 system prompt（角色设定 + 性格 + 当前状态）
 * - 动态注入 PresenceManager 状态（睡眠时 Prompt 变化）
 * - 组装消息历史 + 当前用户消息
 * - 调用 ContextTrimmer 截断/摘要
 *
 * 纯函数，无副作用（依赖注入 sleepDecision）。
 */

import type {
  ICharacterProfile,
  ILoreEntry,
  IMemory,
  IPromptTemplate,
  IReplyStyle,
  IUserProfile,
  MemoryKind,
  ReplyLength,
} from "@wechat-rp/shared-types";
import {
  DEFAULT_REPLY_STYLE,
  PROMPT_FIELD_GROUPS,
} from "@wechat-rp/shared-types";

import type { IContextUsage } from "@wechat-rp/shared-types";
import type { IPresenceDecision } from "../PresenceManager";
import { renderMoodStatePrompt, type IMoodState } from "../emotion/MoodTracker";
import { renderLoreSection } from "../lore/LoreKeeper";
import { renderTimeContext } from "../time/Clock";
import { collectRecentSaid, renderAntiRepeatPrompt } from "./AntiRepeat";
import type { ILLMMessage } from "./types";
import {
  estimateMessagesTokens,
  trimContext,
  type ITrimResult,
} from "./ContextTrimmer";

/** Prompt 构造选项。 */
export interface IPromptBuilderOptions {
  readonly profile: ICharacterProfile;
  readonly maxHistoryMessages?: number;
  /** 额外的注入内容（模板 / 记忆 / 剧情摘要）。 */
  readonly extras?: IPromptExtras;
}

/**
 * Prompt 额外注入内容。
 *
 * 分两处注入：
 * - 人设模板 → 开头 system（属于稳定人设）
 * - 记忆 / 剧情摘要 → 末尾 system，紧贴当前用户消息（动态上下文）
 */
export interface IPromptExtras {
  /** 提示词模板（结构化人设）。 */
  readonly promptTemplate?: IPromptTemplate;
  /** 检索后的长期记忆（已按相关度排序）。 */
  readonly memories?: ReadonlyArray<IMemory>;
  /** 命中的世界书条目（社区卡设定，按插入顺序）。 */
  readonly lore?: ReadonlyArray<ILoreEntry>;
  /** 剧情摘要段落（由 PlotKeeper.renderPlotSummary 渲染，已含标题）。 */
  readonly plotSummary?: string;
  /**
   * 角色当前的心情（由 MoodTracker.deriveMood 推导）。
   *
   * 与睡眠状态一样属于"角色此刻的状态"，所以跟人设一起放开头 system；
   * 平静或强度太低时 renderMoodStatePrompt 返回空串，不会产生空段落。
   */
  readonly mood?: IMoodState | null;
  /**
   * 用户人设（"关于你"）。
   *
   * 角色卡描述角色、记忆是聊出来的，而这块是用户自己写的稳定背景。
   * 它跟人设一起放在开头 system：每轮都在，不受检索与整理影响。
   */
  readonly userProfile?: IUserProfile | null;
  /**
   * 现在的时间戳（ms）。
   *
   * 缺省取 `Date.now()`；测试里注入固定值才能断言"现在几点"这段的字面内容。
   */
  readonly now?: number;
  /**
   * 对方上一条消息的时间戳（ms）。
   *
   * 用来告诉角色"你们上一次说话隔了多久"——隔三天和隔三秒，
   * 开口的方式完全不同。没有历史时不传。
   */
  readonly lastMessageAt?: number | null;
}

/** Prompt 构造结果。 */
export interface IPromptResult {
  /** 构造后的完整消息列表（system + history + user）。 */
  readonly messages: ReadonlyArray<ILLMMessage>;
  /** 上下文截断信息。 */
  readonly trimResult: ITrimResult;
  /** 是否注入了睡眠状态。 */
  readonly sleepStateInjected: boolean;
  /** 上下文占用快照（供界面展示）。 */
  readonly usage: IContextUsage;
}

/** 记忆类别 → 中文标签（注入 Prompt 时使用）。 */
const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  fact: "事实",
  preference: "偏好",
  event: "经历",
  promise: "约定",
  relation: "关系",
  other: "其他",
};

/**
 * 渲染长期记忆段落。
 * 无记忆时返回空字符串（不注入，避免污染 Prompt）。
 *
 * 排序：按「重要度 → 置顶 → 更新时间」**升序**排列，让最重要的记忆落在
 * 整段的最后一行。依据是这类系统通行的经验：越靠近当前提问的内容影响越大
 * （社区里 World Info 的 Insertion Order、以及"lost in the middle"的结论）。
 */
function buildMemoryPrompt(memories?: ReadonlyArray<IMemory>): string {
  if (!memories || memories.length === 0) return "";
  const ordered = [...memories].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? 1 : -1;
    if (a.importance !== b.importance) return a.importance - b.importance;
    return a.updatedAt - b.updatedAt;
  });
  const lines = ordered.map((memory) => {
    const label = MEMORY_KIND_LABELS[memory.kind];
    return `- [${label}] ${memory.content}`;
  });
  return [
    "【你记得的事】",
    ...lines,
    // 护栏：真机复核里出现过"记忆只写了名字与品种，回复却补了『上次还拆家了』"
    // ——凭空补细节比"记不清"更像假。这句只约束**没有来源的补充**，
    // 不影响顺着记忆正常接话。
    "这些是你确实记得的事；没写到的细节别替对方补，想不起来就问一句。",
  ].join("\n");
}

/**
 * 从结构化提示词模板合成 system prompt 片段。
 * 按 PROMPT_FIELD_GROUPS 分组拼入，跳过空字段。
 */
function synthesizeTemplatePrompt(tpl: IPromptTemplate): string {
  const sections: string[] = [];

  for (const group of PROMPT_FIELD_GROUPS) {
    const lines: string[] = [];
    for (const f of group.fields) {
      // 示例对话单独成段（见下），不混在"字段: 值"的行里——
      // 多轮对话塞进一个列表项会读不清，模型也更容易照抄
      if (f.key === "speechExamples") continue;
      const v = tpl[f.key];
      if (typeof v === "string" && v.trim()) {
        lines.push(`- ${f.label}: ${v.trim()}`);
      }
    }
    if (lines.length > 0) {
      sections.push(`【${group.label}】\n${lines.join("\n")}`);
    }
  }

  // 示例对话：few-shot，对语气与节奏的塑形比形容词有效得多
  const examples = tpl.speechExamples?.trim();
  if (examples) {
    sections.push(
      [
        "【说话示例】",
        "下面是这个角色说话的样子。模仿它的语气、长度和节奏，",
        "但**不要照抄**其中的内容，也不要把示例当成刚发生过的事：",
        examples,
      ].join("\n"),
    );
  }

  // 额外补充
  if (tpl.content && tpl.content.trim()) {
    sections.push(`【补充】\n${tpl.content.trim()}`);
  }

  return sections.join("\n\n");
}

/**
 * 构造 system prompt 基础部分（角色设定 + 结构化模板）。
 *
 * 模板文本由调用方传入：它同时要用于上下文占用的分项统计，
 * 在这里就地合成会导致算两遍。
 */
/** 长度档位 → 给模型的具体要求。 */
const REPLY_LENGTH_HINTS: Record<ReplyLength, string> = {
  terse: "极简：一句话，10 字上下，像随手回的消息",
  short: "简短：1~2 句，总共不超过 30 字",
  medium: "适中：2~4 句，够说清一件事",
  detailed: "详细：可以多说几句，但仍要像聊天，不要写成整段",
};

/**
 * 渲染回复风格要求。
 *
 * 与拟真排程（分几条气泡、打字多快）无关——这里管的是**模型写什么**。
 * 默认禁止旁白：这是微信风格的聊天界面，真人不会在聊天框里写自己的动作。
 */
export function buildReplyStylePrompt(style?: IReplyStyle): string {
  const effective = style ?? DEFAULT_REPLY_STYLE;
  const formLine = effective.allowActions
    ? "可以少量穿插动作或神态描写，用（括号）标出"
    : "只写发出去的消息本身：不要写动作、神态、心理旁白，不要用 *星号* 或（括号）描述自己";

  return [
    "【回复风格】",
    `- 长度：${REPLY_LENGTH_HINTS[effective.length]}`,
    `- 形式：${formLine}`,
    "- 语言：日常口语，不用书面语",
  ].join("\n");
}

/**
 * 要求模型在**首行**自己标情绪。
 *
 * 为什么不用关键词猜：真机 38 条语料上关键词只能到 68%，
 * "去湖边野餐吧"这种建议句压根没有情绪词。
 *
 * 为什么是"首行独立成行"而不是行内 `[emotion:xxx]`：
 * 实测行内格式只有 50% 合规，还出现过 `[neutral:整句话]` 这种把正文
 * 包进括号的写法（照那个格式剥标签会误删整条消息）；
 * 而"首行情绪词"10/10 合规、0 残留，且解析足够保守——
 * 首行不匹配就完全不碰正文。
 */
export function buildEmotionTagPrompt(): string {
  return [
    "【情绪标记】每条回复的**第一行**只写一个情绪词，然后换行，从第二行开始才是你要说的话。",
    "情绪词只能取这 8 个之一：neutral、happy、sad、angry、shy、surprised、thinking、sleepy。",
    "第一行除了这个情绪词不要写任何别的内容；正文里也不要再出现这个情绪词。",
  ].join("\n");
}

/**
 * 允许模型"引用对方的话"。
 *
 * 微信里引用是把某一句摘出来顶在回复上，对方一眼就知道你在接哪句；
 * 长对话里这一下能省掉整段"你刚刚说的那个…"的铺垫。
 *
 * 为什么要求**自定界的方括号**而不是"另起一行写 > 引用：…"：
 * 回复是流式分片到达的，靠换行判定就得一直攒着等下一个换行；
 * 有闭括号，引擎见到 `】` 就能立刻决定，剩下的字照常往下走。
 *
 * 为什么反复强调"偶尔/最多一处"：模型一旦觉得这是必填格式，
 * 就会每条都带引用，读起来像论坛回帖而不是聊天。
 */
export function buildCharacterQuotePrompt(): string {
  return [
    "【引用对方的话】回应对方**之前**说过、已经翻上去的某一句时，可以在正文开头加一句引用：",
    "`【引用：那句原文里的一小段】`，紧随其后直接写你要说的话。",
    "片段不超过 20 字，必须**逐字照抄原文里连续的几个字**（不要改写、不要概括），系统要拿它去定位是哪条消息。",
    "对方用「我前面说的那个…」「你还记得吗」这类说法回头指某句时，就用引用明确接上；",
    "也可以引用你自己之前说过的话（比如要强调一个承诺），但很少见。",
    "例：`【引用：你今天怎么没来上课？】抱歉，我睡过头了……`",
    "只在确实需要指明「接的是哪句」时才用，一条回复里最多一处；一问一答紧挨着时不要引用。",
  ].join("\n");
}

/**
 * 教模型「怎么读」对方发来的引用块。
 *
 * 由来：用户点"引用"再提问时，消息里会带一段
 * `（引用消息 · 名字：「原话」）`。真机复核里出现过两种翻车：
 * - 直接把这段当成**别人**说的话，于是答得很飘；
 * - 更尴尬的一种：认出了内容，却**否认自己说过**
 *   （"团团？我没有说过这个呢"）——因为那句话可能早被上下文裁掉了，
 *   它眼前确实看不到。
 *
 * `formatQuote.ts` 里换过几种引用格式来降低误判（3 轮/组的对照实验），
 * 但格式只能影响"以为是别人说的"，**否认**这一层得靠明说：告诉它
 * "引用的可能是你很久以前说的、已经翻出视野的话，别否认"。
 */
export function buildReadingQuotePrompt(): string {
  return [
    "【对方引用的话】对方的消息前面可能带一段引用，长这样：`（引用消息 · 名字：「原话」）`。",
    "那**确实是**对话里出现过的一句话（常常是很久以前说的，已经翻出你能看到的记录）。",
    "顺着它回答就好：**不要否认自己说过**，也别说「你没说过这个」；",
    "真想不起来细节就含糊带过（「嗯…好像是这样」），但别把话题推回给对方。",
  ].join("\n");
}

/**
 * 「说人话」：压掉 AI 腔与客服腔。
 *
 * 由来：聊天里最露馅的不是记性，而是**腔调**。同一个模型在"求建议"的话题上
 * 会立刻切成助手模式：分点列举、"建议你如何如何"、"希望能帮到你"，
 * 甚至用 `**` 加粗——微信里没人这样打字。
 *
 * 和【回复风格】的分工：那一段管**长度与形式**（几句话、要不要动作描写），
 * 这一段只治**腔调**（列表、客服腔、书面语连接词、加粗），互不重复。
 * 刻意不写"不许给建议"——真人也会给建议，只是用自己的口气说一句，
 * 而不是写教程。
 */
export function buildHumanTonePrompt(): string {
  return [
    "【说人话】微信里没人那样打字，别把回复写成一份「正确答案」：",
    "- 不要分点列举（1. 2. 3.、「首先」「其次」「最后」），也不要说「建议你」「希望能帮到你」这类客服腔；",
    "- 不要用书面语连接词（然而、因此、此外、总之、综上所述），不要用 ** 加粗或写小标题；",
    "- 对方倒苦水时先接住情绪再说别的；想给建议就用你自己的口气讲一句，别写教程。",
  ].join("\n");
}

/**
 * 渲染"关于对方"段落（用户人设）。
 *
 * 默认值（称呼"我"、没有简介）时返回空串：没填就不占 Prompt。
 * 最后那句叮嘱是刻意的——模型很容易因为"知道名字"就每条都喊一遍名字，
 * 微信里没人这么聊天。
 */
export function buildUserProfilePrompt(
  userProfile?: IUserProfile | null,
): string {
  if (!userProfile) return "";
  const name = userProfile.displayName.trim();
  const bio = userProfile.bio.trim();
  const hasName = name.length > 0 && name !== "我";
  if (!hasName && !bio) return "";

  const lines = ["【关于对方】"];
  lines.push(
    hasName
      ? `- 对方希望被称呼为「${name}」。`
      : "- 对方没有特别说明称呼，用「你」称呼即可。",
  );
  if (bio) lines.push(`- 背景：${bio}`);
  lines.push(
    "- 这些是对方自己写的稳定信息，不用每句话都提；平时用「你」称呼就好，偶尔叫名字反而更亲近。",
  );
  return lines.join("\n");
}

/**
 * 预览"每轮都会发给模型的那段稳定前缀"（角色卡 + 人设模板 + 关于你 + 风格 + 情绪标记 + 引用规则）。
 *
 * 用在角色编辑器的"预览最终提示词"：模板字段是给用户填的，
 * 但拼出来到底长什么样、有没有互相打架，此前只能靠想象。
 *
 * 只包含**稳定前缀**：睡眠/忙碌/心情、长期记忆、剧情摘要这些是每轮动态变化的，
 * 不在这里展示。返回值保证是 `buildPrompt(...).messages[0].content` 的前缀
 * （有单测盯着这条一致性，免得预览与真实请求各说各话）。
 */
export function buildSystemPromptPreview(
  profile: ICharacterProfile,
  template?: IPromptTemplate | null,
  userProfile?: IUserProfile | null,
): string {
  const templateText = template ? synthesizeTemplatePrompt(template) : "";
  return [buildBaseSystemPrompt(profile, templateText), buildUserProfilePrompt(userProfile)]
    .filter(Boolean)
    .join("\n\n");
}

function buildBaseSystemPrompt(
  profile: ICharacterProfile,
  templateText: string,
): string {
  const traits = profile.personalityTraits;
  const parts: string[] = [];

  // 角色卡基础信息
  parts.push(
    `你是${profile.displayName}。${profile.bio}`,
    `性格原型：${traits.archetype}。`,
    `说话风格：打字速度倍率 ${traits.typingSpeedMultiplier}，碎片化倾向 ${traits.fragmentationBias}，犹豫概率 ${traits.hesitationProbability}。`,
  );

  // 结构化模板（如果存在）
  if (templateText) parts.push(templateText);

  // 回复风格（长度档位 + 是否允许旁白）
  parts.push(buildReplyStylePrompt(profile.replyStyle));

  // 腔调：别写成助手/客服（求建议类话题最容易露馅）
  parts.push(buildHumanTonePrompt());

  // 情绪标记（首行情绪词，引擎据此切换立绘）
  parts.push(buildEmotionTagPrompt());

  // 引用对方的话（可选格式，引擎解析后挂成引用块）
  parts.push(buildCharacterQuotePrompt());

  // 读对方发来的引用块（用户点"引用"提问时）
  parts.push(buildReadingQuotePrompt());

  return parts.join("\n");
}

/**
 * 构造睡眠状态注入的 system 补充 prompt。
 */
function buildSleepStatePrompt(sleepDecision: IPresenceDecision): string {
  if (!sleepDecision.isSleeping) return "";

  if (sleepDecision.policy === "silent") {
    // silent 策略下不会走到 LLM 调用，这里返回空即可
    return "";
  }

  if (sleepDecision.policy === "drowsy-burst") {
    return [
      `【当前状态】你刚被消息吵醒，半梦半醒。`,
      `回复要求：极短（2-8字），语气迷糊，可以不完整。`,
      `示例："嗯…"、"唔…怎么了"、"先睡了…"`,
    ].join("\n");
  }

  // next-day-queue 不应该走到这里，但以防万一
  return `【当前状态】你正在睡觉，明天才会回复。`;
}

/**
 * 构造"忙碌"状态注入的 system 补充 prompt。
 *
 * 与睡眠的区别：睡着时角色**看不到**消息（那套策略管的是要不要回、回多短），
 * 而忙的时候看得到、只是没空细说——所以这里不拦回复，只要求"忙里偷闲"的写法：
 * 短、可以晚点再说、别写小作文。（效果由 work/agnes_busy_probe.mts 真机验证）
 */
function buildBusyStatePrompt(decision: IPresenceDecision): string {
  if (!decision.isBusy) return "";
  const what = decision.busyLabel ?? "在忙";
  return [
    `【当前状态】你正在${what}，手机只是抽空瞄一眼。`,
    "回复要求：**很短**（一到两句、十几个字以内），像是忙里偷闲打的字；",
    "可以直说待会儿再聊，但别敷衍到让人以为你不想理对方。",
    "不要写长段落，也不要在这个状态里展开新话题。",
  ].join("\n");
}

/**
 * 构造完整 Prompt。
 *
 * 消息结构：
 * ```
 * [system]  角色卡 + 人设模板 + 关于你 + 【现在】 + 在场/心情  ← 稳定前缀
 * [历史…]   最近若干轮对话
 * [system]  【世界设定】+【你记得的事】+【当前剧情】+【别重复】 ← 动态注入（无内容时省略）
 * [user]    当前用户消息
 * ```
 *
 * @param profile 角色档案
 * @param history 历史消息（user/assistant 交替）
 * @param userMessage 当前用户消息
 * @param sleepDecision 睡眠决策（可选，来自 PresenceManager.evaluate()）
 * @param extras 额外注入内容（模板 / 记忆 / 剧情摘要，均可选）
 */
export function buildPrompt(
  profile: ICharacterProfile,
  history: ReadonlyArray<ILLMMessage>,
  userMessage: string,
  sleepDecision?: IPresenceDecision,
  extras?: IPromptExtras,
): IPromptResult {
  // 各块先分别算出来：既用于拼装，也用于上下文占用的分项统计
  const templateText = extras?.promptTemplate
    ? synthesizeTemplatePrompt(extras.promptTemplate)
    : "";
  const memoryText = buildMemoryPrompt(extras?.memories);
  const loreText = renderLoreSection(extras?.lore ?? []);
  const plotText = extras?.plotSummary?.trim() ?? "";
  /**
   * 防复读：从历史里现算"角色最近说过的话"（不新增存储）。
   *
   * 放在动态段的**最后**：它是一条"别做什么 + 该做什么"的行为约束，
   * 紧贴当前提问时最容易被遵守。
   */
  const antiRepeatText = renderAntiRepeatPrompt(collectRecentSaid(history));

  // 构造 system prompt
  const basePrompt = buildBaseSystemPrompt(profile, templateText);
  const sleepPrompt = sleepDecision ? buildSleepStatePrompt(sleepDecision) : "";
  const busyPrompt = sleepDecision ? buildBusyStatePrompt(sleepDecision) : "";
  const moodPrompt = renderMoodStatePrompt(extras?.mood ?? null);
  // 关于对方（用户人设）属于稳定前缀，紧跟角色人设
  const userPrompt = buildUserProfilePrompt(extras?.userProfile);
  /**
   * "现在几点"：时间是最基本的场景事实，缺了它角色会在晚上说"早上好"、
   * 被问时间只能瞎猜、隔了三天没聊也像刚接上。属于"此刻的外部事实"，
   * 所以跟在场状态一起放开头 system（详见 time/Clock.ts）。
   */
  const timePrompt = renderTimeContext({
    now: extras?.now ?? Date.now(),
    timeZone: profile.schedule.timezone,
    lastMessageAt: extras?.lastMessageAt ?? null,
  });
  // 角色此刻的状态（时间 / 睡眠 / 忙碌 / 心情）跟在后面，同属开头 system
  const systemContent = [
    basePrompt,
    userPrompt,
    timePrompt,
    sleepPrompt,
    busyPrompt,
    moodPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  // 动态上下文（世界设定 / 记忆 / 剧情 / 别重复）：贴近当前提问，
  // 无内容时不产生空消息。顺序：设定 → 记忆 → 剧情 → 别重复。
  // 世界设定是背景铺垫；记忆次之；剧情是"此刻正在发生什么"，离提问最近；
  // 而"别重复"是唯一一条行为约束，压在最尾部。
  const dynamicPrompt = [loreText, memoryText, plotText, antiRepeatText]
    .filter(Boolean)
    .join("\n\n");

  // 组装完整消息列表
  const allMessages: ILLMMessage[] = [
    { role: "system", content: systemContent },
    ...history,
    ...(dynamicPrompt ? [{ role: "system" as const, content: dynamicPrompt }] : []),
    { role: "user", content: userMessage },
  ];

  // 截断
  const trimResult = trimContext(allMessages);

  // 上下文占用快照：system 项要扣掉模板，否则模板会被算两次
  const usedMessages = trimResult.messages;
  const usage: IContextUsage = {
    estimatedTokens: estimateMessagesTokens(usedMessages),
    messageCount: usedMessages.length,
    chars: {
      system: Math.max(0, systemContent.length - templateText.length),
      template: templateText.length,
      lore: loreText.length,
      memory: memoryText.length,
      plot: plotText.length,
      antiRepeat: antiRepeatText.length,
      history: history.reduce((sum, m) => sum + m.content.length, 0),
    },
    trimmed: trimResult.trimmed,
    summarized: trimResult.summarized,
    removedChars: trimResult.removedChars,
  };

  return {
    messages: usedMessages,
    trimResult,
    sleepStateInjected: sleepPrompt.length > 0,
    usage,
  };
}
