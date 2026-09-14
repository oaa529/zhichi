/**
 * @file ForgetMessage.ts
 * 删掉一条消息时，把它在**长期记忆与剧情事件**里留下的痕迹一起抹掉。
 *
 * 由来：README 里承诺过"删除单条消息 = 让角色忘掉这一句"。但删掉的只是
 * 消息本身——后台整理早就把这句话提炼成了记忆条目与剧情事件，删完再聊，
 * 角色照样能"记得"那句你想让它忘掉的话。承诺与实现对不上。
 *
 * 为什么不能靠 `sourceMessageIds` 精确删：整理是**按窗口**记来源的
 * （一次整理窗口里所有消息的 ID 都记在同一批条目上），删一条就会连坐
 * 掉同批次的无关记忆。所以这里改用**文本比对**：只删那些内容确实来自
 * 这句话的条目。
 *
 * 判定规则（宁可少删，不可错删）：
 * 1. 长句（归一化后 ≥ 8 字）：满足任意一条即算——
 *    整段照搬（记忆里含这句话的连续原文）、
 *    字符 bigram 的 **Dice 系数 ≥ 0.5**（模型常改写主语与个别字，
 *    Jaccard 会把"用户说自己下周三要去拔智齿"这种判掉，Dice 不会）、
 *    或**记忆整段就是这句话的片段**；
 * 2. 短句（如"嗯""在吗"）：只认 Dice ≥ 0.85 的，否则一句"嗯"会把
 *    半本记忆库带走；
 * 3. 被删消息的 id 会从**保留下来**的条目的 `sourceMessageIds` 里摘掉，
 *    免得"来源 N 条消息"这个数字把已经删掉的消息也算进去。
 * 4. **用户自己维护的条目不动**（置顶、或 `origin: "manual"`）：
 *    相似匹配是启发式的，误伤一条用户刚手写/标星的东西比"少删一条"糟得多。
 *    这类条目要走"用户自己点删除"那条路。
 *
 * 纯函数，无副作用，可直接单测。
 */

import type { IMemory, IPlotEvent } from "@wechat-rp/shared-types";

/** 长句判定阈值：短于这个长度按"短句"从严处理。 */
export const FORGET_MIN_TEXT_CHARS = 8;
/** 长句的 Dice 系数阈值。 */
export const FORGET_SIMILARITY = 0.5;
/** 短句的 Dice 系数阈值（从严）。 */
export const FORGET_SHORT_SIMILARITY = 0.85;
/** "记忆整段就是这句话的片段"时的最短长度：太短的片段没说服力。 */
export const FORGET_MIN_FRAGMENT_CHARS = 6;

/** 归一化：去掉空白与常见标点，只留实义字符。 */
function normalize(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：""''（）《》【】,.!?;:()[\]{}"'-]/g, "")
    .toLowerCase();
}

/** 归一化文本的字符 bigram 集合（长度 1 时保留单字）。 */
function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  const normalized = text.replace(/\s+/g, "").toLowerCase();
  if (normalized.length === 0) return set;
  if (normalized.length === 1) {
    set.add(normalized);
    return set;
  }
  for (let i = 0; i + 1 < normalized.length; i += 1) {
    set.add(normalized.slice(i, i + 2));
  }
  return set;
}

/**
 * Dice 系数（2|交集| / (|A|+|B|)）。
 *
 * 不用 Jaccard：它把"候选更长"罚得很重，而记忆条目本来就比原话长
 * （"用户说自己下周三要去拔智齿" vs "我下周三要去拔智齿"）——
 * 那正是**该删**的情况。
 */
function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) {
    if (b.has(gram)) intersection += 1;
  }
  return (2 * intersection) / (a.size + b.size);
}

/**
 * 判断一份"提炼结果"（记忆内容 / 事件摘要）是否来自被删的那句话。
 *
 * @param deleted 被删消息的文本
 * @param candidate 记忆内容或事件摘要
 */
export function looksDerivedFrom(deleted: string, candidate: string): boolean {
  const source = normalize(deleted);
  const target = normalize(candidate);
  if (source.length === 0 || target.length === 0) return false;

  const dice = diceCoefficient(bigrams(deleted), bigrams(candidate));

  if (source.length < FORGET_MIN_TEXT_CHARS) {
    // 短句从严：一句"嗯"不该带走半本记忆库
    return dice >= FORGET_SHORT_SIMILARITY;
  }

  if (dice >= FORGET_SIMILARITY) return true;
  // 整段照搬：记忆里含这句话的连续原文
  if (target.includes(source)) return true;
  // 反向：记忆整段就是这句话的一小段（提炼成了短条目）
  return (
    target.length >= FORGET_MIN_FRAGMENT_CHARS && source.includes(target)
  );
}

/** 记忆的遗忘结果。 */
export interface IForgetMemoriesResult {
  /** 应当保留的记忆（已从 `sourceMessageIds` 里摘掉被删消息）。 */
  readonly kept: ReadonlyArray<IMemory>;
  /** 因为来自被删消息而移除的记忆。 */
  readonly forgotten: ReadonlyArray<IMemory>;
}

/**
 * 计算"删掉这些消息之后"的记忆列表。
 *
 * @param memories 该角色的全部记忆
 * @param texts 被删消息的文本（可能多条：撤回 + 删除一起处理）
 * @param messageIds 被删消息的 ID（从保留条目的来源里摘掉）
 */
export function forgetMemoriesFromTexts(
  memories: ReadonlyArray<IMemory>,
  texts: ReadonlyArray<string>,
  messageIds: ReadonlyArray<string> = [],
): IForgetMemoriesResult {
  const idSet = new Set(messageIds);
  const kept: IMemory[] = [];
  const forgotten: IMemory[] = [];

  for (const memory of memories) {
    /**
     * 用户维护的（置顶 / 手动新增改写的）不参与相似度匹配：
     * 匹配是启发式的，而"我刚改完就被抹掉"最伤信任。
     * 想删它们，去记忆面板点删除。
     */
    const protectedMemory = memory.pinned || memory.origin === "manual";
    const derived = texts.some((text) =>
      looksDerivedFrom(text, memory.content),
    );
    if (derived && !protectedMemory) {
      forgotten.push(memory);
      continue;
    }
    if (idSet.size === 0) {
      kept.push(memory);
      continue;
    }
    const sources = memory.sourceMessageIds.filter((id) => !idSet.has(id));
    kept.push(
      sources.length === memory.sourceMessageIds.length
        ? memory
        : { ...memory, sourceMessageIds: sources },
    );
  }

  return { kept, forgotten };
}

/** 事件的遗忘结果。 */
export interface IForgetEventsResult {
  /** 应当保留的事件。 */
  readonly kept: ReadonlyArray<IPlotEvent>;
  /** 因为来自被删消息而移除的事件。 */
  readonly forgotten: ReadonlyArray<IPlotEvent>;
}

/**
 * 计算"删掉这些消息之后"的剧情事件列表。
 *
 * 只动事件：状态卡（地点、线索、概要）是人写的整体描述，
 * 为一条消息去改整张卡风险更大——那部分交给用户手动维护。
 */
export function forgetEventsFromTexts(
  events: ReadonlyArray<IPlotEvent>,
  texts: ReadonlyArray<string>,
): IForgetEventsResult {
  const kept: IPlotEvent[] = [];
  const forgotten: IPlotEvent[] = [];

  for (const event of events) {
    // 手写的事件同样不参与相似度匹配（理由见上：误伤比少删更糟）
    if (event.manual) {
      kept.push(event);
      continue;
    }
    const derived = texts.some((text) =>
      looksDerivedFrom(text, event.summary),
    );
    if (derived) forgotten.push(event);
    else kept.push(event);
  }

  return { kept, forgotten };
}
