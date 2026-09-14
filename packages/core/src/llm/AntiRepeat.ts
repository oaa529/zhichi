/**
 * @file AntiRepeat.ts
 * 「别把刚说过的话再说一遍」——把角色最近几轮说过的话整理成一段 system 约束。
 *
 * 由来：闲聊里模型最容易露馅的地方不是记性，而是**复读**：
 * 用户发一句没什么信息量的话（"嗯""在吗"），角色就开始套公式，
 * 上一轮"那你早点休息呀"，这一轮还是"那你早点休息呀"。
 * 拟真引擎管了节奏、错别字、心情，却没有任何一处提醒模型"这句话你刚说过"——
 * 主动消息的提示词里有这一句，普通回复里没有。
 *
 * 做法：从**已有的对话历史**里把这些句子捞出来（不新增任何存储），
 * 拼成一段动态 system 放进 Prompt 最尾部——离当前提问最近的地方，
 * 约束类内容放这里最容易被遵守。
 *
 * 纯函数，无副作用，可直接单测。
 */

import type { ILLMMessage } from "./types";
import { bigramSimilarity } from "../memory/MemoryRetriever";

/** 往回看几轮角色发言（连续的气泡算同一轮）。 */
export const ANTI_REPEAT_MAX_TURNS = 3;
/** 最多列几句。再多就变成"作文题目"了，模型反而被带偏。 */
export const ANTI_REPEAT_MAX_ITEMS = 6;
/** 单句最长字符数（超出截断）。 */
export const ANTI_REPEAT_ITEM_CHARS = 40;
/** 与已列出的句子相似到这个程度就当作同一句，不重复列。 */
export const ANTI_REPEAT_SIMILARITY = 0.75;
/**
 * 短于这个长度的片段不算"说过的话"。
 *
 * "嗯""在的"这类本来就是口头禅，禁掉反而不像人；而且它们几乎每轮都出现，
 * 列进提示词只会白白占地方。
 */
export const ANTI_REPEAT_MIN_CHARS = 5;

/** 语音/贴图的占位文本不是"说过的话"。 */
const PLACEHOLDER_PATTERN = /^\[(图片|贴图|语音[^\]]*)\]$/;

/** `collectRecentSaid` 的可调项（主要给测试用）。 */
export interface ICollectRecentSaidOptions {
  readonly maxTurns?: number;
  readonly maxItems?: number;
  readonly minChars?: number;
  readonly maxChars?: number;
}

/**
 * 切句：按句末标点与换行切，逗号不算（切得太碎反而读不懂）。
 *
 * 句末标点会去掉，方便直接拼进提示词列表。
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?；;\n]+|…+|~+/)
    .map((part) => part.trim().replace(/[，,、：:]+$/, "").trim())
    .filter((part) => part.length > 0);
}

/** 把历史里连续的多条 assistant 消息合并成「一轮发言」。 */
function groupAssistantTurns(history: ReadonlyArray<ILLMMessage>): string[] {
  const turns: string[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    /**
     * 气泡之间用换行拼——换行在 `splitSentences` 里就是句子边界。
     *
     * 直接首尾相接会拼出"辛苦啦晚上早点休息"这种连体句（浏览器端到端
     * 实测撞到过：前一截正好切在逗号后、没有句末标点），列给模型看很怪。
     */
    turns.push(buffer.join("\n"));
    buffer = [];
  };

  for (const message of history) {
    if (message.role === "assistant") {
      // 贴图/语音的占位文本不是"说过的话"，先滤掉再拼——
      // 连续两条占位拼在一起（"[贴图][语音 3 秒]"）就不再是单独一条了，
      // 所以过滤必须发生在拼接**之前**。
      if (!PLACEHOLDER_PATTERN.test(message.content.trim())) {
        buffer.push(message.content);
      }
      continue;
    }
    // 用户插话 = 上一轮结束（历史里 user / assistant 交替出现）
    flush();
  }
  flush();
  return turns;
}

/**
 * 收集「角色最近说过的话」。
 *
 * 每轮只取**开头一句与结尾一句**：复读几乎都发生在这两个位置
 * （开头是口头禅式的接话，结尾是"早点休息呀"这类收尾），
 * 中间那几句是一次性的内容，列出来只会挤占提示词。
 *
 * @param history 对话历史（`toLLMHistory` 的输出即可）
 * @returns 由旧到新的句子列表；没有可用的返回空数组
 */
export function collectRecentSaid(
  history: ReadonlyArray<ILLMMessage>,
  options: ICollectRecentSaidOptions = {},
): string[] {
  const maxTurns = options.maxTurns ?? ANTI_REPEAT_MAX_TURNS;
  const maxItems = options.maxItems ?? ANTI_REPEAT_MAX_ITEMS;
  const minChars = options.minChars ?? ANTI_REPEAT_MIN_CHARS;
  const maxChars = options.maxChars ?? ANTI_REPEAT_ITEM_CHARS;

  if (maxTurns <= 0 || maxItems <= 0) return [];

  const turns = groupAssistantTurns(history).slice(-maxTurns);
  const collected: string[] = [];

  for (const turn of turns) {
    const sentences = splitSentences(turn)
      .filter((sentence) => sentence.length >= minChars)
      .filter((sentence) => !PLACEHOLDER_PATTERN.test(sentence));
    if (sentences.length === 0) continue;

    const first = sentences[0]!;
    const last = sentences[sentences.length - 1]!;
    collected.push(clip(first, maxChars));
    if (sentences.length > 1 && last !== first) {
      collected.push(clip(last, maxChars));
    }
  }

  // 同一句/近似句只留一次（保留先出现的，也就是更早说的那句）
  const deduped: string[] = [];
  for (const item of collected) {
    const duplicated = deduped.some(
      (kept) => bigramSimilarity(kept, item) >= ANTI_REPEAT_SIMILARITY,
    );
    if (!duplicated) deduped.push(item);
  }

  // 只保留最新的几句
  return deduped.slice(-maxItems);
}

/** 截断过长的句子。 */
function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * 渲染成 system 段落；没有内容时返回空串（调用方据此整段省略）。
 *
 * 结尾那句"接着说新的话"是刻意的：只说"别重复"，模型有时会僵住或者
 * 干脆换话题——这里给的是**替代动作**，不是单纯的禁令。
 */
export function renderAntiRepeatPrompt(said: ReadonlyArray<string>): string {
  if (said.length === 0) return "";
  return [
    "【别重复】下面这些是你最近几轮已经说过的话：",
    ...said.map((sentence) => `- ${sentence}`),
    "别再说同样的句子，也别换个说法把同一个意思再讲一遍；接着说新的话，或者顺着对方最新那句往下聊。",
  ].join("\n");
}

/**
 * 找出 `reply` 里跟「说过的话」高度重合的句子（诊断与测试用）。
 *
 * 产品链路上不做拦截——拦下来重写要再花一次 API、还可能把自然的呼应掐掉；
 * 这里只用于探针量化"复读到底有多频繁"。
 */
export function findRepeatedSentences(
  reply: string,
  said: ReadonlyArray<string>,
  threshold: number = ANTI_REPEAT_SIMILARITY,
): string[] {
  const sentences = splitSentences(reply);
  return sentences.filter((sentence) =>
    said.some((kept) => bigramSimilarity(kept, sentence) >= threshold),
  );
}
