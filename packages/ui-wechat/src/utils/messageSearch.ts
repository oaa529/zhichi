/**
 * @file messageSearch.ts
 * 跨会话消息搜索（纯函数，可直接单测）。
 *
 * 数据来源：sessionStore.sessionRuntimes —— 全量会话消息的单一来源，
 * 活跃会话的运行时快照也会随消息变化实时写入，因此不需要额外索引。
 *
 * 可搜索的内容：
 * - 文本消息：正文
 * - 语音消息：ASR 转写文本（没有转写则跳过——搜不到"没转写的语音"是合理的）
 * - 贴图消息：内联表情回退文本（如 `[微笑]`）
 *
 * 不参与搜索：图片（无文本）、系统消息（时间分割线等噪声）、撤回提示。
 */

import type { IMessage, ISession } from "@wechat-rp/shared-types";

/** 单条搜索结果。 */
export interface IMessageSearchHit {
  readonly sessionId: string;
  /** 会话显示名（用于结果分组）。 */
  readonly sessionName: string;
  readonly messageId: string;
  readonly senderId: string;
  /** 截断后的上下文片段。 */
  readonly snippet: string;
  /**
   * 片段里所有命中区间（多词查询会有多处）。
   *
   * 之前只有 `matchIndex/matchLength` 一对：整串查询当一个词匹配，
   * 于是"团团 医院"这种**带空格的查询永远 0 条**——用户会以为记录里没有。
   * 现在按空白拆词、**全部命中才算命中**，每处都给区间用于高亮。
   */
  readonly matches: ReadonlyArray<{
    readonly index: number;
    readonly length: number;
  }>;
  readonly timestamp: number;
}

/** 搜索结果集合。 */
export interface IMessageSearchResult {
  /** 按时间倒序、已按 limit 截断的结果。 */
  readonly hits: ReadonlyArray<IMessageSearchHit>;
  /** 命中总数（可能大于 hits.length）。 */
  readonly total: number;
}

/** 搜索选项。 */
export interface IMessageSearchOptions {
  /** 最多返回多少条（默认 60）。 */
  readonly limit?: number;
  /** 片段最大字符数（默认 48）。 */
  readonly snippetChars?: number;
}

const DEFAULT_LIMIT = 60;
const DEFAULT_SNIPPET_CHARS = 48;

/**
 * 小写化后的文本缓存。
 *
 * 搜索是"每次按键扫全部消息"：实测 6000 条时一次常见词查询要 198ms，
 * 大头是反复 `toLowerCase()`。消息对象一旦创建就不再变动，
 * 所以用 WeakMap 缓存住，重复搜索只剩字符串 `includes`。
 */
const lowerTextCache = new WeakMap<object, string>();

/** 取消息文本的小写形式（带缓存）。 */
function lowerTextOf(messageKey: object, text: string): string {
  const cached = lowerTextCache.get(messageKey);
  if (cached !== undefined) return cached;
  const lower = text.toLowerCase();
  lowerTextCache.set(messageKey, lower);
  return lower;
}

/** 取出消息里可被搜索的文本；不可搜索的类型返回 null。 */
export function extractSearchableText(message: IMessage): string | null {
  switch (message.type) {
    case "text":
      return message.text || null;
    case "voice":
      return message.transcript?.trim() || null;
    case "sticker":
      return message.fallbackText?.trim() || null;
    case "image":
    case "system":
    case "recall":
      return null;
    default:
      return null;
  }
}

/**
 * 把查询拆成词：空白分隔、全部小写。
 *
 * 多词是 **AND** 语义（"团团 医院"＝两个词都要出现）——
 * 这是搜索框的通行预期；此前整串当一个词匹配，带空格就等于搜不到。
 */
export function splitSearchTerms(query: string): ReadonlyArray<string> {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/**
 * 在片段里找出所有词的命中区间（重叠的合并、按下标排序）。
 *
 * 片段可能被截断，落在片段外的词自然找不到——这没关系，
 * 它只是不高亮而已，命中判定早在原文上做过了。
 */
export function findMatchSpans(
  snippet: string,
  terms: ReadonlyArray<string>,
): ReadonlyArray<{ readonly index: number; readonly length: number }> {
  const lower = snippet.toLowerCase();
  const spans: Array<{ index: number; length: number }> = [];

  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      spans.push({ index: at, length: term.length });
      from = at + term.length;
    }
  }

  spans.sort((a, b) => a.index - b.index);
  const merged: Array<{ index: number; length: number }> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.index <= last.index + last.length) {
      // 两段挨着/重叠：并成一段，避免画出嵌套的 <mark>
      last.length = Math.max(
        last.length,
        span.index + span.length - last.index,
      );
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

/**
 * 截取关键词附近的上下文片段。
 *
 * 命中点靠近开头/结尾时只向另一侧扩展，保证片段尽量凑满 maxChars
 * 又不会越界；被截断的一侧补省略号。
 */
export function buildSnippet(
  text: string,
  keyword: string,
  maxChars: number = DEFAULT_SNIPPET_CHARS,
): { snippet: string; matchIndex: number } {
  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const matchAt = lowerText.indexOf(lowerKeyword);

  if (matchAt === -1) {
    const snippet =
      text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
    return { snippet, matchIndex: -1 };
  }

  if (text.length <= maxChars) {
    return { snippet: text, matchIndex: matchAt };
  }

  // 让命中点大致居中：两侧各留一半，再按边界夹取
  const half = Math.floor((maxChars - keyword.length) / 2);
  let start = Math.max(0, matchAt - half);
  let end = Math.min(text.length, start + maxChars);
  start = Math.max(0, end - maxChars);

  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const snippet = `${prefix}${text.slice(start, end)}${suffix}`;
  return { snippet, matchIndex: start > 0 ? matchAt - start + 1 : matchAt };
}

/** 从运行时快照里取出消息本体（结构读取，兼容 unknown 元素）。 */
function messageOf(value: unknown): IMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = (value as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  return message as IMessage;
}

/**
 * 在全部会话的历史消息里搜索关键词（大小写不敏感的子串匹配）。
 *
 * @param query 关键词（空白则返回空结果）
 * @param sessions 会话表（取显示名）
 * @param runtimes 会话运行时快照表（取消息）
 */
export function searchMessages(
  query: string,
  sessions: Record<string, ISession>,
  runtimes: Record<string, { messages?: ReadonlyArray<unknown> }>,
  options?: IMessageSearchOptions,
): IMessageSearchResult {
  const terms = splitSearchTerms(query);
  if (terms.length === 0) return { hits: [], total: 0 };

  const limit = options?.limit ?? DEFAULT_LIMIT;
  const snippetChars = options?.snippetChars ?? DEFAULT_SNIPPET_CHARS;

  const matched: IMessageSearchHit[] = [];

  for (const [sessionId, runtime] of Object.entries(runtimes)) {
    const sessionName = sessions[sessionId]?.displayName ?? "";
    for (const raw of runtime.messages ?? []) {
      const message = messageOf(raw);
      if (!message) continue;

      const text = extractSearchableText(message);
      if (!text) continue;
      const lowerText = lowerTextOf(message, text);
      // 多词 AND：有一个词没出现就跳过
      if (!terms.every((term) => lowerText.includes(term))) continue;

      // 片段围绕"最早出现的那个词"居中，保证至少有一处命中看得见
      const anchor = terms.reduce<string>((best, term) => {
        const at = lowerText.indexOf(term);
        if (at < 0) return best;
        if (best === "") return term;
        return at < lowerText.indexOf(best) ? term : best;
      }, "");
      const { snippet } = buildSnippet(text, anchor, snippetChars);
      matched.push({
        sessionId,
        sessionName,
        messageId: message.id,
        senderId: message.senderId,
        snippet,
        matches: findMatchSpans(snippet, terms),
        timestamp: message.timestamp,
      });
    }
  }

  // 最近的聊天排前面：找旧记录时通常也更关心最近说过的
  matched.sort((a, b) => b.timestamp - a.timestamp);

  return {
    hits: matched.slice(0, limit),
    total: matched.length,
  };
}
