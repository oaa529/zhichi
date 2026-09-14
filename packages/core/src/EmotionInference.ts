/**
 * @file EmotionInference.ts
 * 从回复文本推断情绪（纯函数，可单测）。
 *
 * 由来：`SemanticBuffer.setEmotion()` 全仓没有调用点——也就是说每条消息的
 * 情绪永远停在 `neutral`，按情绪准备好的立绘永远不会切换。
 * 这里补上"情绪从哪来"：用关键词线索从文本里推断，不额外调用 LLM
 * （每轮多一次请求不划算，而且要等它返回会拖慢出字）。
 */

import type { CharacterEmotion } from "@wechat-rp/shared-types";

/**
 * 强线索：这些词是"对对方处境的情绪反应"，最能代表角色此刻的表情，
 * 优先于末尾随口带的一句。
 *
 * 例："辛苦了。早点休息，别熬太晚。"——只看最近命中会落到"别熬"（困倦），
 * 但角色此刻明明是关切；先判"辛苦"才对。
 */
const STRONG_HINTS: ReadonlyArray<
  readonly [CharacterEmotion, ReadonlyArray<string>]
> = [
  ["sad", ["对不起", "抱歉", "抱抱", "心疼", "别难过", "辛苦", "陪你", "注意身体"]],
];

/**
 * 关键词表。顺序只在"命中位置相同时"作为优先级（越靠前的越强）。
 *
 * 只放指向明确、日常聊天里真的会出现的线索；
 * 宁可判成 neutral 也不要乱猜——立绘切错比不切更出戏。
 */
const EMOTION_HINTS: ReadonlyArray<
  readonly [CharacterEmotion, ReadonlyArray<string>]
> = [
  // 注意别把"！"当惊讶线索：日常回复里到处都是感叹号
  ["surprised", ["啊？", "诶？", "欸？", "真的吗", "居然", "竟然", "没想到", "天哪", "震惊", "谁呀"]],
  ["angry", ["生气", "讨厌", "烦死", "气死", "哼", "别闹", "过分", "不像话"]],
  // "安慰"类线索也算 sad：抱抱/心疼/没事 传递的关心，最接近"难过"这一档
  ["sad", ["难过", "伤心", "哭", "唉", "失落", "委屈", "对不起", "抱歉", "遗憾", "没办法", "抱抱", "心疼", "别难过", "辛苦", "陪你", "没事", "没关系", "注意身体"]],
  ["shy", ["害羞", "脸红", "不好意思", "别说了", "别乱说", "别瞎说", "那个…", "讨厌啦", "少来", "羞"]],
  ["happy", ["哈哈", "嘿嘿", "嘻嘻", "开心", "高兴", "太好了", "好呀", "好啊", "喜欢", "笑", "棒", "谢谢", "么么", "恭喜", "庆祝", "厉害", "真棒"]],
  ["sleepy", ["困", "睡", "晚安", "哈欠", "好累", "撑不住", "别熬", "熬夜"]],
  ["thinking", ["嗯…", "让我想想", "想想", "大概", "也许", "可能", "好像", "不确定", "怎么办", "要不"]],
];

/** 单次推断只看最近这么多字符（情绪跟着"眼下这句"走）。 */
export const EMOTION_WINDOW_CHARS = 40;

/** 全部合法情绪词（用于识别模型自己打的标签）。 */
const EMOTION_WORDS: ReadonlySet<string> = new Set([
  "neutral",
  "happy",
  "sad",
  "angry",
  "shy",
  "surprised",
  "thinking",
  "sleepy",
]);

/**
 * 解析"首行情绪词"格式的回复。
 *
 * 让模型自己在第一行写情绪词（`happy\n哈哈太好了`），比关键词猜准得多——
 * 实测真机上"行内 [emotion:xxx]"只有 50% 合规、还有把整句话包进括号的写法，
 * 而"首行情绪词"10/10 合规、0 残留。
 *
 * **只有首行恰好是那 8 个词之一才动正文**：不匹配就原样返回，
 * 最坏情况是"没拿到标签"，绝不会吃掉用户该看到的内容。
 */
export function parseEmotionTagHead(text: string): {
  readonly emotion: CharacterEmotion | null;
  readonly body: string;
} {
  // 真机上模型常在标签前先吐一个换行，所以先把开头的空白吃掉再找标签
  const head = text.replace(/^[\s\uFEFF]+/, "");

  // 标签后面允许跟标点/空白/换行——都算"标签独占开头"
  const match = head.match(/^([A-Za-z]+)[.。,，:：!！?？]*[ \t]*\n?/);
  const candidate =
    match?.[1]?.toLowerCase().replace(/[.。,，:：!！?？]/g, "") ?? "";
  if (!match || !EMOTION_WORDS.has(candidate)) {
    return { emotion: null, body: text };
  }

  return {
    emotion: candidate as CharacterEmotion,
    body: head.slice(match[0].length).replace(/^\s+/, ""),
  };
}

/**
 * 推断一段文本的情绪。
 *
 * @param text 文本（调用方通常只传最近几十个字符）
 * @returns 命中的第一种情绪；都不命中时返回 neutral
 */
export function inferEmotion(text: string): CharacterEmotion {
  if (!text) return "neutral";
  const sample = text.slice(-EMOTION_WINDOW_CHARS);

  // 1) 先看强线索
  for (const [emotion, hints] of STRONG_HINTS) {
    for (const hint of hints) {
      if (sample.includes(hint)) return emotion;
    }
  }

  // 2) 其余线索取**最后出现**的那条
  //    情绪跟着"眼下这句话"走："唉，你开心就好" 的当前情绪是欣慰而不是难过；
  //    命中位置相同时才比优先级（表里越靠前越强）。
  let bestPosition = -1;
  let bestEmotion: CharacterEmotion = "neutral";
  for (const [emotion, hints] of EMOTION_HINTS) {
    for (const hint of hints) {
      const position = sample.lastIndexOf(hint);
      if (position > bestPosition) {
        bestPosition = position;
        bestEmotion = emotion;
      }
    }
  }
  return bestEmotion;
}
