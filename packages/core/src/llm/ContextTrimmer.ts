/**
 * @file ContextTrimmer.ts
 * 上下文截断与摘要策略。
 *
 * 职责：
 * - 估算消息列表的 token 数（中文近似：chars × 1.3）
 * - 超过阈值时截断旧消息，保留最近 N 轮对话
 * - 超过硬上限时生成"前情提要"摘要替代最旧消息
 *
 * 纯函数，无副作用，可直接 vitest 边界测试。
 */

import type { ILLMMessage } from "./types";

/** token 估算系数（中文 1 char ≈ 1.3 token）。 */
const TOKEN_RATIO = 1.3;

/** 默认保留最近对话轮数（1 轮 = 1 user + 1 assistant）。 */
const DEFAULT_KEEP_ROUNDS = 8;

/** 默认软阈值（chars），超过则触发截断。 */
const DEFAULT_SOFT_LIMIT_CHARS = 4000;

/** 默认硬上限（chars），永不超 model context window 的 80%。 */
const DEFAULT_HARD_LIMIT_CHARS = 8000;

/** 前情提要的总长上限（chars）。 */
const SUMMARY_MAX_CHARS = 360;

/**
 * "具体信息"的加权识别。
 *
 * 只用来决定**前情提要里先保哪几句**，命中与否都不影响别处逻辑。
 * 为什么要加权而不是一个正则：第一版用"命中即算"，结果它挑中的是
 * "别又拖到下午两三点才想起来"这种顺口提到时间的闲聊，
 * 而真正该留的"我下周三下午三点要去医院复查"仍然丢了。
 * 现在按信号强度排名（数字 / 明确日期 / 地点事件 / 约定 各算一档），
 * 分高的先留，同分则取离窗口更近的。
 */
const CONCRETE_SIGNAL_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly weight: number;
}> = [
  { pattern: /\d/, weight: 2 },
  {
    pattern: /[一二三四五六七八九十两]{1,3}\s*(点|月|日|号|岁|元|块|分钟|小时)/,
    weight: 2,
  },
  { pattern: /下周|本周|这周|上周|明天|后天|周末/, weight: 2 },
  {
    pattern:
      /医院|诊所|面试|考试|补考|预约|挂号|复查|报告|机票|车票|航班|高铁|会议/,
    weight: 2,
  },
  { pattern: /约好|说好|答应|截止|记得|别忘了/, weight: 1 },
  { pattern: /上午|下午|晚上|凌晨|早上|中午/, weight: 1 },
];

/** 打分：分越高越"值得留在前情提要里"。 */
function concreteScore(text: string): number {
  let score = 0;
  for (const rule of CONCRETE_SIGNAL_RULES) {
    if (rule.pattern.test(text)) score += rule.weight;
  }
  return score;
}

/** 截断结果。 */
export interface ITrimResult {
  /** 截断后的消息列表（含 system + 摘要 + 最近 N 轮）。 */
  readonly messages: ReadonlyArray<ILLMMessage>;
  /** 是否触发了截断。 */
  readonly trimmed: boolean;
  /** 截断掉的字符数。 */
  readonly removedChars: number;
  /** 是否生成了摘要。 */
  readonly summarized: boolean;
}

/**
 * 估算字符串的 token 数。
 * 中文 1 char ≈ 1.3 token，英文 1 word ≈ 1.3 token（此处用 char 估算简化）。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * TOKEN_RATIO);
}

/**
 * 估算消息列表的总 token 数。
 */
export function estimateMessagesTokens(messages: ReadonlyArray<ILLMMessage>): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    // 每条消息的 role + 格式开销约 4 token
    total += 4;
  }
  return total;
}

/**
 * 截断消息历史，保留 system + 最近 N 轮对话。
 *
 * 策略：
 * 1. 总 chars ≤ softLimit → 不截断
 * 2. 超过 softLimit → 保留 system + 最近 keepRounds*2 条 user/assistant
 * 3. 只要砍掉了消息 → 补一段"前情提要"替代被砍掉的那段
 *    （有后台提炼的要点就用它，没有就退回到机械摘要）
 *
 * 关于第 3 条：此前只有"截断后**仍**超 hardLimit"才生成摘要，
 * 而保留窗口本身要超过 8000 字才满足——微信式短消息（每条几十字）
 * 永远达不到，于是长对话里旧消息被**静默丢掉、没有任何替代品**，
 * 角色自然就"忘了中间那一段"。现在只要发生裁剪就给替代品：
 * 这正是长对话里的标准做法（要点 + 最近窗口）。
 *
 * 位置语义：system 消息分两类，截断后必须各自归位——
 * - 开头的人设/角色卡：留在最前
 * - 末尾的动态注入（长期记忆、剧情摘要）：留在对话之后、当前用户消息之前。
 *   这类内容"越靠近末尾影响越大"，如果被提到最前面，长上下文下等于白注入。
 *
 * @param messages 原始消息列表（system 在最前）
 * @param options 可选配置
 */
export function trimContext(
  messages: ReadonlyArray<ILLMMessage>,
  options?: {
    readonly keepRounds?: number;
    readonly softLimitChars?: number;
    readonly hardLimitChars?: number;
  },
): ITrimResult {
  const keepRounds = options?.keepRounds ?? DEFAULT_KEEP_ROUNDS;
  const softLimit = options?.softLimitChars ?? DEFAULT_SOFT_LIMIT_CHARS;
  const hardLimit = options?.hardLimitChars ?? DEFAULT_HARD_LIMIT_CHARS;

  // 分离 system 消息和对话消息
  const dialogMsgs = messages.filter((m) => m.role !== "system");

  // system 按位置分两段：
  // - 开头连续的 system → 稳定人设，截断后仍放最前
  // - 夹在对话里/末尾的 system（记忆、剧情、前情提要）→ 动态注入，要留在尾部
  const firstDialogIdx = (() => {
    const index = messages.findIndex((m) => m.role !== "system");
    return index === -1 ? messages.length : index;
  })();

  const prefixSystem: ILLMMessage[] = [];
  const tailSystem: ILLMMessage[] = [];
  /** 每条 tail system 后面原本还跟着几条对话消息（用于还原插入位置）。 */
  const tailDialogAfter: number[] = [];
  messages.forEach((m, index) => {
    if (m.role !== "system") return;
    if (index < firstDialogIdx) {
      prefixSystem.push(m);
      return;
    }
    tailSystem.push(m);
    tailDialogAfter.push(
      messages.slice(index + 1).filter((x) => x.role !== "system").length,
    );
  });

  /**
   * 把尾部 system 放回"距离对话末尾第 N 条"的位置。
   * 例：动态记忆原本紧贴当前用户消息，其后还有 1 条对话 →
   * 截断后仍插在最后一条对话之前，而不是被甩到消息末尾。
   */
  const withTailSystem = (dialog: ReadonlyArray<ILLMMessage>): ILLMMessage[] => {
    const out: ILLMMessage[] = [];
    dialog.forEach((message, index) => {
      const dialogAfterHere = dialog.length - index;
      tailSystem.forEach((sys, t) => {
        if (tailDialogAfter[t] === dialogAfterHere) out.push(sys);
      });
      out.push(message);
    });
    tailSystem.forEach((sys, t) => {
      if (tailDialogAfter[t] === 0) out.push(sys);
    });
    return out;
  };

  // 计算总 chars
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);

  if (totalChars <= softLimit) {
    return { messages, trimmed: false, removedChars: 0, summarized: false };
  }

  // 截断：保留最近 keepRounds*2 条对话消息
  const keepCount = Math.min(keepRounds * 2, dialogMsgs.length);
  let recentDialog = dialogMsgs.slice(-keepCount);
  let removedDialog = dialogMsgs.slice(0, dialogMsgs.length - keepCount);

  /**
   * 硬上限：保留窗口 + 两头的 system 还超，就继续往前砍（至少留 2 条）。
   *
   * 这条此前形同虚设——旧代码只在"裁剪后仍超"时去生成摘要，
   * 而那并不会让请求变小。现在它是真的上限：长对话不会撑爆模型窗口，
   * 多砍掉的部分交给下面的"前情提要"接管。
   */
  const prefixChars = prefixSystem.reduce((sum, m) => sum + m.content.length, 0);
  const tailChars = tailSystem.reduce((sum, m) => sum + m.content.length, 0);
  while (
    recentDialog.length > 2 &&
    prefixChars +
      tailChars +
      recentDialog.reduce((sum, m) => sum + m.content.length, 0) >
      hardLimit
  ) {
    // 一次砍一轮（user + assistant）
    removedDialog = [...removedDialog, ...recentDialog.slice(0, 2)];
    recentDialog = recentDialog.slice(2);
  }

  const removedChars = removedDialog.reduce((sum, m) => sum + m.content.length, 0);

  // 合并：开头 system + 最近对话（尾部注入按原位插入其中）
  let result: ILLMMessage[] = [
    ...prefixSystem,
    ...withTailSystem(recentDialog),
  ];

  /**
   * 只要砍掉了消息，就补一段替代品。
   *
   * 这里有取舍：会给每次请求多加 200~400 字。但被砍掉的那段模型是真看不见了，
   * 而"要点 + 最近窗口"是长对话里的标准做法——比起"角色忘了中间那段"，
   * 这点 token 花得值。硬上限只用来决定"要不要再压缩"（后续可扩展）。
   */
  let summarized = false;
  if (removedDialog.length > 0) {
    const summary = summarizeMessages(removedDialog);
    // 摘要紧跟在人设之后、被保留的对话之前——它是"被截掉那部分的替身"
    result = [
      ...prefixSystem,
      { role: "system" as const, content: `【前情提要】${summary}` },
      ...withTailSystem(recentDialog),
    ];
    summarized = true;
  }

  return {
    messages: result,
    trimmed: true,
    removedChars,
    summarized,
  };
}

/**
 * 将一批消息合并为简短摘要。
 *
 * 这是**没有提炼结果时的兜底**（自动整理还没跑过、或整段都是新消息）：
 * 每条留长一点，尽量保持是"完整的一句话"，而不是把二十条各切 30 字
 * 拼成一团碎片——那样读起来毫无信息量。
 *
 * 两段内容：
 * 1. **较早提到的具体信息**：数字、时间、地点、约好的事（见
 *    `CONCRETE_INFO_PATTERN`）。长对话里真正会被追问的就是这些
 *    （"我下周三下午三点要去医院复查"），而它们往往正好落在被砍掉的
 *    中段——实测 120 条对话里，第 40 条那句具体信息**完全不在 Prompt 里**，
 *    因为旧实现只带最后 4 条被砍消息，而那 4 条全是闲聊。
 * 2. **最近几条**：贴着窗口边界，保持话题连续性。
 *
 * 顺序上"具体信息"放前面：万一总长要截，先保住的应该是它。
 */
function summarizeMessages(msgs: ReadonlyArray<ILLMMessage>): string {
  const recent = msgs.slice(-4);
  const earlier = msgs.slice(0, Math.max(0, msgs.length - recent.length));
  /**
   * 先按"具体程度"排名取前二，再按时间顺序摆回原样。
   *
   * 阈值 3 = 至少两条信号（比如"下周"+"三点"），只有一句"下午"这种
   * 顺口提到时间的闲聊不占名额。
   */
  const concrete = earlier
    .map((message, index) => ({
      message,
      index,
      score: concreteScore(message.content),
    }))
    .filter((item) => item.score >= 3)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.message);

  const render = (m: ILLMMessage): string => {
    const prefix = m.role === "user" ? "用户" : "角色";
    const flat = m.content.replace(/\s+/g, " ").trim();
    const snippet = flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
    return `${prefix}：${snippet}`;
  };

  const groups: string[] = [];
  const omitted = msgs.length - recent.length - concrete.length;
  const head = omitted > 0 ? `（更早的 ${omitted} 条已省略）` : "";

  /**
   * 这里曾经加过一句护栏："更早的对话你已经记不太清了，别断言对方没提过"。
   *
   * **验证后撤掉了**：`work/agnes_consistency_probe.mts` 两轮共 13 次回答里，
   * 带护栏的那组照样说"你之前好像没跟我提过""没跟你提过我家有猫"——
   * 与不带护栏的那组没有可辨差异（命中率也都是 0，因为两组都没记忆注入）。
   * 按项目纪律：没有证据的提示词不加，改由下面这段说明保留结论。
   *
   * 这个失败模式本身仍然存在，真正管用的是**长期记忆**：同一探针里带记忆的
   * 那组 7/8 答对，且一次"你没提过"都没有。所以遇到它别去调提示词，
   * 先看整理有没有跑、记忆检索有没有命中。
   */

  /**
   * 按**整条**塞，而不是最后 `slice` 一刀切。
   *
   * 旧写法是拼完再 `slice(0, 360)`：超长时最后一条会被从中间切断
   * （"用户：晚上准备看部电影放松一下，最近攒了…"——半句话没有省略号，
   * 读起来像是自己没说完）。现在一条塞不下就整条不要，并在末尾补"…"。
   */
  let used = head.length;
  const appendGroup = (
    label: string,
    lines: ReadonlyArray<string>,
  ): void => {
    if (lines.length === 0) return;
    const pieces: string[] = [];
    // 组内的"；"与组间的"｜"都要算进预算
    let groupChars = label.length + (groups.length > 0 ? 1 : 0);
    let dropped = false;
    for (const line of lines) {
      const extra = line.length + (pieces.length > 0 ? 1 : 0);
      if (used + groupChars + extra > SUMMARY_MAX_CHARS) {
        dropped = true;
        break;
      }
      pieces.push(line);
      groupChars += extra;
    }
    if (pieces.length === 0) return;
    const joined = `${label}${pieces.join("；")}`;
    // 上一条自己已经以"…"结尾时就不再加一个，免得出现"……"
    const text =
      dropped && !joined.endsWith("…") ? `${joined}…` : joined;
    groups.push(text);
    used += text.length;
  };

  appendGroup("较早：", concrete.map(render));
  appendGroup("最近：", recent.map(render));

  return `${head}${groups.join("｜")}`;
}
