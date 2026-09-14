/**
 * @file EmotionInference.test.ts
 * 文本 → 情绪的推断规则。
 */

import { describe, it, expect } from "vitest";
import {
  EMOTION_WINDOW_CHARS,
  inferEmotion,
  parseEmotionTagHead,
} from "../EmotionInference";

describe("parseEmotionTagHead", () => {
  it("首行是情绪词时识别出来并剥掉整行", () => {
    expect(parseEmotionTagHead("happy\n哈哈，太好了")).toEqual({
      emotion: "happy",
      body: "哈哈，太好了",
    });
  });

  it("容忍大小写、句点与多余空白", () => {
    expect(parseEmotionTagHead("  Happy. \n 好呀")).toEqual({
      emotion: "happy",
      body: "好呀",
    });
  });

  it("首行不是情绪词时原样返回（绝不吃掉正文）", () => {
    const text = "面条？\n我随便问问";
    expect(parseEmotionTagHead(text)).toEqual({ emotion: null, body: text });
  });

  it("没有换行时不做任何处理（宁可没标签，也不能误删）", () => {
    // 只有情绪词、没有正文：仍然识别出来（正文为空）
    expect(parseEmotionTagHead("happy")).toEqual({ emotion: "happy", body: "" });
  });

  it("情绪词出现在正文里不会被当成标签", () => {
    const text = "在吗\n我今天有点 happy 但也说不上来";
    expect(parseEmotionTagHead(text)).toEqual({ emotion: null, body: text });
  });

  it("八种情绪词都能识别", () => {
    for (const word of [
      "neutral",
      "happy",
      "sad",
      "angry",
      "shy",
      "surprised",
      "thinking",
      "sleepy",
    ]) {
      expect(parseEmotionTagHead(`${word}\n内容`).emotion).toBe(word);
    }
  });

  it("标签前有换行/空格也能认（真机上模型常这么写）", () => {
    // 这是真机实测踩到的坑：模型先吐一个换行，导致标签漏进消息正文
    expect(parseEmotionTagHead("\nhappy\n真的呀！恭喜你")).toEqual({
      emotion: "happy",
      body: "真的呀！恭喜你",
    });
    expect(parseEmotionTagHead("  sad 抱歉听到这个消息")).toEqual({
      emotion: "sad",
      body: "抱歉听到这个消息",
    });
  });

  it("正文以英文单词开头但不在情绪词表里时不动它", () => {
    const text = "hello\n在的";
    expect(parseEmotionTagHead(text)).toEqual({ emotion: null, body: text });
  });
});

describe("inferEmotion", () => {
  it("各情绪的典型句子能识别出来", () => {
    expect(inferEmotion("哈哈，那太好了")).toBe("happy");
    expect(inferEmotion("唉，我今天好难过")).toBe("sad");
    expect(inferEmotion("哼，你太过分了")).toBe("angry");
    expect(inferEmotion("诶？真的吗")).toBe("surprised");
    expect(inferEmotion("别说了，好害羞")).toBe("shy");
    expect(inferEmotion("好困，眼睛睁不开了")).toBe("sleepy");
    expect(inferEmotion("让我想想…大概是这样")).toBe("thinking");
  });

  it("没有线索时返回 neutral（不乱猜）", () => {
    expect(inferEmotion("面条？")).toBe("neutral");
    expect(inferEmotion("我刚下班 你呢")).toBe("neutral");
    expect(inferEmotion("")).toBe("neutral");
  });

  it("真机抽样里学到的常见说法（回归保护）", () => {
    // 这些句子来自 Agnes 的真实回复，最初那版词表全部漏判
    expect(inferEmotion("恭喜你呀，真棒")).toBe("happy");
    expect(inferEmotion("多少呀？恭喜啦。")).toBe("happy");
    expect(inferEmotion("抱抱你，它不痛了。")).toBe("sad");
    expect(inferEmotion("没关系的，人没伤到就好。")).toBe("sad");
    expect(inferEmotion("辛苦了。早点休息，别熬太晚。")).toBe("sad");
    expect(inferEmotion("没呢，看会儿书。你也别熬太晚")).toBe("sleepy");
    expect(inferEmotion("想什么呢，别瞎说。")).toBe("shy");
    expect(inferEmotion("谁呀？")).toBe("surprised");
  });

  it("感叹号本身不算情绪线索（日常回复里到处都是）", () => {
    expect(inferEmotion("好的！")).toBe("neutral");
    expect(inferEmotion("就这样吧！")).toBe("neutral");
  });

  it("同一句里多种线索时，以最后出现的为准（当前情绪）", () => {
    // "唉"在前、"开心"在后 → 当下的情绪是欣慰
    expect(inferEmotion("唉，你开心就好")).toBe("happy");
    // 反过来，"哈哈"在前、"难过"在后 → 情绪转低落
    expect(inferEmotion("哈哈…其实我有点难过")).toBe("sad");
  });

  it("只看最近一小段：前面聊过别的不会污染当前情绪", () => {
    const long = `${"哈哈".repeat(40)} 唉，有点难过`;
    expect(inferEmotion(long)).toBe("sad");
    // 反过来，久远的难过不该盖住眼前的开心
    const long2 = `${"唉".repeat(40)} 哈哈太好了`;
    expect(inferEmotion(long2)).toBe("happy");
  });

  it("窗口长度是有限值（避免整段长文参与匹配）", () => {
    expect(EMOTION_WINDOW_CHARS).toBeGreaterThan(0);
    expect(EMOTION_WINDOW_CHARS).toBeLessThanOrEqual(80);
  });
});
