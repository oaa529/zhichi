/**
 * @file characterQuote.ts
 * 「角色也会引用你的话」的解析与匹配。
 *
 * 引用此前是**单向**的：你能引用角色说过的话（菜单里的"引用"），
 * 角色却永远只能干巴巴地回应。长对话里角色想针对你**之前**某句具体的话
 * 作答时（"你刚才说的那句"），没有引用块读者就得自己往上翻。
 *
 * 做法：让模型在正文最前面写一行自定界的标记
 * `【引用：你今天怎么没来上课？】`，引擎把它剥掉、匹配到具体的那条消息、
 * 挂成气泡上的引用块（UI 早就会渲染 `message.quote`，点击还能跳回去）。
 *
 * 为什么用自定界的方括号而不是"另起一行写 > 引用：…"：
 * 流式分片会把一行切成好几段，靠换行判定就得一直攒着等下一个换行；
 * 有闭括号就不必等，见到 `】` 立刻能决定。
 *
 * 纯函数，无副作用，可直接单测。
 */

import type { IMessage, IMessageQuote } from "@wechat-rp/shared-types";
import { bigramSimilarity } from "../memory/MemoryRetriever";
import { buildQuotePreview } from "./formatQuote";
import { getMessagePlainText } from "./toLLMHistory";

/** 标记开头。 */
export const CHARACTER_QUOTE_PREFIX = "【引用：";

/** 标记结尾（自定界）。 */
export const CHARACTER_QUOTE_SUFFIX = "】";

/**
 * 引用片段的最大长度。
 *
 * 超长的只有两种可能：模型把整段话抄了进来（那是复读不是引用），
 * 或者它压根没在用这个格式。两种都按"不认这个标记"处理，原样放行。
 */
export const CHARACTER_QUOTE_MAX_CHARS = 60;

/**
 * 引用块里的署名。
 *
 * 角色引用的是"你"说过的话——嵌在角色的气泡里，
 * 写"我"会被读成角色在引自己。给 Prompt 用的 `formatQuotedText`
 * 只作用于用户发的消息，不会跟这里打架。
 */
export const CHARACTER_QUOTE_SENDER_NAME = "你";

/**
 * 流式引用标记过滤器。
 *
 * 分片是逐段到达的，标记可能被切在中间（`【引` / `用：你好】`），
 * 也可能**不在开头**——真机实测就遇到过模型把它写在正文末尾：
 * 回复是「吃了呢，刚吃晚饭。你呢？ 【引用：你吃饭了吗？】」。
 * 只在开头扫的话，这串格式就原样漏进气泡了。
 *
 * 做法：每次 push 进来的文本先攒着，能确定的部分才放出去；
 * 尾部可能只是标记的一小半（`【引用：` 的前缀），就留到下一片再判。
 * 流结束时 flush() 把留着的都吐干净——一个字都不会因为"等标记"而丢掉。
 */
export class CharacterQuoteFilter {
  /** 还没法判定、暂时扣住的尾巴。 */
  private pending = "";
  /** 摘下来的片段（多个标记时取第一个用于挂引用块）。 */
  private capturedPreview: string | null = null;

  /** 摘到的片段（给 findQuoteTarget 用）；没有标记时为 null。 */
  public get preview(): string | null {
    return this.capturedPreview;
  }

  /**
   * 喂入一段文本，返回"可以安全交付"的正文。
   *
   * 返回值可能比输入短（摘掉了标记），也可能暂时为空
   * （整段都还无法判定，比如只收到了 `【引`）。
   */
  public push(text: string): string {
    if (!text) return "";
    this.pending += text;

    let out = "";
    for (;;) {
      const start = this.pending.indexOf(CHARACTER_QUOTE_PREFIX);
      if (start < 0) {
        // 没有完整的前缀：尾巴可能只是前缀的一半，留几个字符等一下
        const keep = Math.min(CHARACTER_QUOTE_PREFIX.length - 1, this.pending.length);
        out += this.pending.slice(0, this.pending.length - keep);
        this.pending = this.pending.slice(this.pending.length - keep);
        return out;
      }

      const end = this.pending.indexOf(
        CHARACTER_QUOTE_SUFFIX,
        start + CHARACTER_QUOTE_PREFIX.length,
      );
      if (end < 0) {
        const tail = this.pending.slice(start);
        if (tail.length <= CHARACTER_QUOTE_MAX_CHARS + CHARACTER_QUOTE_PREFIX.length) {
          // 可能还没吐完：前缀之前的先交付，尾巴留着
          out += this.pending.slice(0, start);
          this.pending = tail;
          return out;
        }
        // 写了一大段也没闭括号：它没在用这个格式，原样放行
        out += this.pending;
        this.pending = "";
        return out;
      }

      const preview = this.pending
        .slice(start + CHARACTER_QUOTE_PREFIX.length, end)
        .trim();
      out += this.pending.slice(0, start);
      const rawMarker = this.pending.slice(start, end + CHARACTER_QUOTE_SUFFIX.length);
      this.pending = this.pending.slice(end + CHARACTER_QUOTE_SUFFIX.length);

      // 空片段 / 超长片段：格式写坏了，原样放行（宁可没引用，也不能吃掉正文）
      if (preview.length === 0 || preview.length > CHARACTER_QUOTE_MAX_CHARS) {
        out += rawMarker;
      } else if (this.capturedPreview === null) {
        this.capturedPreview = preview;
      }
    }
  }

  /**
   * 流结束：把扣着的尾巴交出来。
   *
   * 这里直接原样放行——push 的结束状态保证 pending 里不会留着完整的标记
   * （完整标记在 push 里就摘掉了），剩下的只可能是"开了头没写闭括号"的
   * 半截文本。那种情况按正文交付，用户至少能看到模型到底写了什么。
   */
  public flush(): string {
    const rest = this.pending;
    this.pending = "";
    return rest;
  }
}

/** 可以被引用的候选消息（角色只能引"对方"说过的话）。 */
export interface IQuoteCandidate {
  readonly messageId: string;
  readonly text: string;
  /** 引用块里显示的署名（用户那边是"你"，角色自己那条是角色名）。 */
  readonly senderName: string;
}

/** 匹配的默认及格线。 */
export const QUOTE_MATCH_MIN_SCORE = 0.55;

/**
 * 归一化：去掉空白与标点，只留字面内容。
 *
 * 模型抄回来时经常把标点换掉、少一个问号，或者把你那句话里的逗号吃掉；
 * 这些都不该影响"这是同一句"的判断。
 */
function normalizeQuoteText(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[。，、！？…～~,.!?;；:：""''（）()【】《》〈〉\-—]/g, "")
    .toLowerCase();
}

/**
 * 把模型引用的片段匹配到具体的一条消息。
 *
 * 评分优先级：完全相同 > 你的话包含片段 > 片段包含你的话 > 字符 bigram 相似度。
 * 从后往前找，同分时**取最近的那条**——角色回应的通常是刚说不久的话。
 *
 * @returns 匹配不上时返回 null（调用方只把标记剥掉，不挂引用块）
 */
export function findQuoteTarget(
  preview: string,
  candidates: ReadonlyArray<IQuoteCandidate>,
  minScore: number = QUOTE_MATCH_MIN_SCORE,
): IMessageQuote | null {
  const target = normalizeQuoteText(preview);
  if (!target) return null;

  let best: IQuoteCandidate | null = null;
  let bestScore = 0;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i]!;
    const text = normalizeQuoteText(candidate.text);
    if (!text) continue;

    let score: number;
    if (text === target) {
      score = 1;
    } else if (text.includes(target)) {
      // 引的是你那句话里的一小段——最常见的情况
      score = 0.95;
    } else if (target.includes(text)) {
      // 引的比你说的还长（模型顺手带了上下文）
      score = 0.9;
    } else {
      score = bigramSimilarity(target, text);
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (!best || bestScore < minScore) return null;
  return {
    messageId: best.messageId,
    senderName: best.senderName,
    // 摘要用**原消息**的文本而不是模型抄回来的片段：跳转目标与引用块必须一致
    preview: buildQuotePreview(best.text),
  };
}

/**
 * 从会话消息里挑出"角色可以引用"的候选。
 *
 * 两侧都收：主战场是"引对方刚说的话"，但角色引用**自己**之前说过的
 * 那句（比如强调一个承诺）同样成立，微信里也没限制只能引别人。
 * 系统提示与撤回提示不参与——它们不是"谁说过的话"。
 *
 * 真机实测踩到的点：只收用户消息时，模型回头引了自己上一轮那句话，
 * 引擎匹配不到候选、只能把标记剥掉了事。两侧都收就把这种情况接住了。
 */
export function buildQuoteCandidates(
  messages: ReadonlyArray<IMessage>,
  options: {
    /** 角色的显示名（引用角色自己那条消息时用作署名）。 */
    readonly characterName?: string;
    readonly limit?: number;
  } = {},
): ReadonlyArray<IQuoteCandidate> {
  const limit = options.limit ?? 20;
  const candidates: IQuoteCandidate[] = [];
  for (const message of messages) {
    if (message.type !== "text" && message.type !== "sticker") continue;
    const text = getMessagePlainText(message);
    if (text === null || text.trim().length === 0) continue;
    const fromUser = message.senderId === "user";
    // 角色的名字拿不到时（老调用方）就不收角色自己那条，避免署名空着
    if (!fromUser && !options.characterName) continue;
    candidates.push({
      messageId: message.id,
      text,
      senderName: fromUser ? CHARACTER_QUOTE_SENDER_NAME : options.characterName!,
    });
  }
  return candidates.slice(-Math.max(0, limit));
}
