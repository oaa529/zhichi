/**
 * @file characterQuote.test.ts
 * 角色侧引用：标记扫描、片段匹配、候选构造。
 */

import { describe, it, expect } from "vitest";
import {
  buildQuoteCandidates,
  CHARACTER_QUOTE_MAX_CHARS,
  CHARACTER_QUOTE_SENDER_NAME,
  CharacterQuoteFilter,
  findQuoteTarget,
} from "../llm/characterQuote";
import type { IMessage, ITextMessage } from "@wechat-rp/shared-types";

function userText(id: string, text: string): ITextMessage {
  return {
    id,
    type: "text",
    senderId: "user",
    recipientId: "char-1",
    sessionId: "s1",
    timestamp: 1000,
    chunkSequence: 0,
    emotion: "neutral",
    text,
    sourceOffset: 0,
  };
}

/** 按给定分片喂进过滤器，返回"交付的正文"与摘到的片段。 */
function feed(
  chunks: ReadonlyArray<string>,
): { readonly out: string; readonly preview: string | null } {
  const filter = new CharacterQuoteFilter();
  let out = "";
  for (const chunk of chunks) out += filter.push(chunk);
  out += filter.flush();
  return { out, preview: filter.preview };
}

describe("CharacterQuoteFilter", () => {
  it("认出标记，剥掉它并留下正文", () => {
    const { out, preview } = feed(["【引用：你今天怎么没来上课？】抱歉，我睡过头了……"]);

    expect(preview).toBe("你今天怎么没来上课？");
    expect(out).toBe("抱歉，我睡过头了……");
  });

  it("标记前后的空白与换行都吃掉（模型常先吐一个换行）", () => {
    const { out, preview } = feed(["\n\n【引用：在吗】\n在的，怎么了？"]);

    expect(preview).toBe("在吗");
    // 标记前后的换行、标记后面的换行都不残留（否则会出现空气泡）
    expect(out.trim()).toBe("在的，怎么了？");
  });

  it("分片切在标记中间也能摘干净（不会漏出半截标记）", () => {
    const { out, preview } = feed([
      "happy\n【引",
      "用：你今天怎么没来上课？】",
      "抱歉抱歉，",
      "我睡过头了。",
    ]);

    expect(preview).toBe("你今天怎么没来上课？");
    expect(out).not.toContain("【");
    expect(out).not.toContain("】");
    expect(out).toContain("抱歉抱歉，");
    expect(out).toContain("我睡过头了。");
  });

  it("标记写在正文**末尾**也照样摘掉（真机遇到过的写法）", () => {
    const { out, preview } = feed([
      "吃了呢，刚吃晚饭。你呢？ ",
      "【引用：你吃饭了吗？】",
    ]);

    expect(preview).toBe("你吃饭了吗？");
    expect(out).toContain("吃了呢，刚吃晚饭。你呢？");
    expect(out).not.toContain("【引用");
  });

  it("标记夹在正文中间时，前后文字都保住", () => {
    const { out, preview } = feed(["前面的话。", "【引用：在吗】", "后面的话。"]);

    expect(preview).toBe("在吗");
    expect(out).toBe("前面的话。后面的话。");
  });

  it("没见到闭括号时不吞字：流结束时原样交付", () => {
    const partial = "【引用：你今天怎么没来上课？我到教室了。";
    const { out, preview } = feed([partial]);

    expect(preview).toBeNull();
    expect(out).toBe(partial);
  });

  it("写了很长也没有闭括号：判定它没在用这个格式，立刻原样交付（不无限攒字）", () => {
    const longNoSuffix = `【引用：${"没有闭括号的一大段话".repeat(8)}`;
    expect(longNoSuffix.length).toBeGreaterThan(CHARACTER_QUOTE_MAX_CHARS);

    const filter = new CharacterQuoteFilter();
    const out = filter.push(longNoSuffix);
    // 不用等 flush 就该放出来了——否则这段文字会一直卡在过滤器里
    expect(out).toBe(longNoSuffix);
    expect(filter.flush()).toBe("");
    expect(filter.preview).toBeNull();
  });

  it("片段为空或超长都按「没在用这个格式」处理，原样放行", () => {
    const empty = feed(["【引用：】抱歉"]);
    expect(empty.preview).toBeNull();
    expect(empty.out).toBe("【引用：】抱歉");

    const tooLong = `【引用：${"很长的一段话".repeat(12)}】正文`;
    expect(tooLong.length).toBeGreaterThan(CHARACTER_QUOTE_MAX_CHARS);
    const long = feed([tooLong]);
    expect(long.preview).toBeNull();
    expect(long.out).toBe(tooLong);
  });

  it("普通正文（哪怕以【开头）一点都不动", () => {
    const text = "【通知】明天停课";
    const { out, preview } = feed([text]);

    expect(preview).toBeNull();
    expect(out).toBe(text);
  });

  it("多个标记只取第一个当引用块，其余一并摘掉", () => {
    const { out, preview } = feed([
      "【引用：在吗】嗯，【引用：明天见】明天见。",
    ]);

    expect(preview).toBe("在吗");
    expect(out).toBe("嗯，明天见。");
  });

  it("整段文本被切成单字也不丢字（逐字推流的极端情况）", () => {
    const text = "【引用：你今天怎么没来上课？】抱歉，我睡过头了。";
    const { out, preview } = feed([...text]);

    expect(preview).toBe("你今天怎么没来上课？");
    expect(out).toBe("抱歉，我睡过头了。");
  });
});

describe("findQuoteTarget", () => {
  const candidates = [
    { messageId: "m1", text: "明天下午有空吗？", senderName: "你" },
    { messageId: "m2", text: "我今天去图书馆了", senderName: "你" },
    { messageId: "m3", text: "你今天怎么没来上课？", senderName: "你" },
  ];

  it("原句（含标点差异）能匹配到对应消息", () => {
    const quote = findQuoteTarget("你今天怎么没来上课", candidates);

    expect(quote).toMatchObject({
      messageId: "m3",
      senderName: CHARACTER_QUOTE_SENDER_NAME,
      preview: "你今天怎么没来上课？",
    });
  });

  it("只抄了原句里的一小段也能匹配", () => {
    const quote = findQuoteTarget("图书馆", candidates);
    expect(quote?.messageId).toBe("m2");
  });

  it("摘要用原消息的文本，而不是模型抄回来的片段", () => {
    const quote = findQuoteTarget("没来上课", candidates);
    expect(quote?.preview).toBe("你今天怎么没来上课？");
  });

  it("毫无关系的话不硬凑（宁可不挂引用块）", () => {
    expect(findQuoteTarget("海边的那家唱片店", candidates)).toBeNull();
  });

  it("候选里没有用户消息时返回 null", () => {
    expect(findQuoteTarget("在吗", [])).toBeNull();
  });

  it("同分时取最近的那条（角色接的通常是刚说不久的话）", () => {
    const repeated = [
      { messageId: "old", text: "在吗", senderName: "你" },
      { messageId: "new", text: "在吗", senderName: "你" },
    ];

    expect(findQuoteTarget("在吗", repeated)?.messageId).toBe("new");
  });

  it("引用角色自己说过的话时，署名用它自己的名字", () => {
    const quote = findQuoteTarget("那本挺厚的", [
      { messageId: "c1", text: "那本挺厚的，慢慢看", senderName: "苏晚晴" },
    ]);

    expect(quote).toMatchObject({ messageId: "c1", senderName: "苏晚晴" });
  });

  it("片段比你原话还长（模型顺手带上上下文）时也能命中", () => {
    const quote = findQuoteTarget("我昨天说的明天下午有空吗", [
      { messageId: "m1", text: "明天下午有空吗？", senderName: "你" },
    ]);

    expect(quote?.messageId).toBe("m1");
  });
});

describe("buildQuoteCandidates", () => {
  it("两侧的话都收（署名各自不同），跳过系统提示与撤回提示", () => {
    const messages: IMessage[] = [
      userText("u1", "第一句"),
      { ...userText("c1", "角色说的"), senderId: "char-1" },
      userText("u2", "第二句"),
      {
        id: "sys",
        type: "system",
        senderId: "user",
        recipientId: "char-1",
        sessionId: "s1",
        timestamp: 1000,
        chunkSequence: 0,
        emotion: "neutral",
        systemKind: "time-divider",
        displayText: "昨天 20:00",
      },
      {
        id: "st",
        type: "sticker",
        senderId: "user",
        recipientId: "char-1",
        sessionId: "s1",
        timestamp: 1000,
        chunkSequence: 0,
        emotion: "happy",
        stickerPackId: "basic",
        stickerId: "smile",
        fallbackText: "[微笑]",
      },
    ];

    expect(buildQuoteCandidates(messages, { characterName: "苏晚晴" })).toEqual([
      { messageId: "u1", text: "第一句", senderName: "你" },
      { messageId: "c1", text: "角色说的", senderName: "苏晚晴" },
      { messageId: "u2", text: "第二句", senderName: "你" },
      { messageId: "st", text: "[微笑]", senderName: "你" },
    ]);
  });

  it("没给角色名时只收用户说过的话（免得署名空着）", () => {
    const messages: IMessage[] = [
      userText("u1", "第一句"),
      { ...userText("c1", "角色说的"), senderId: "char-1" },
    ];

    expect(buildQuoteCandidates(messages)).toEqual([
      { messageId: "u1", text: "第一句", senderName: "你" },
    ]);
  });

  it("只看最近的若干条（候选表不该无限增长）", () => {
    const messages = Array.from({ length: 30 }, (_, i) =>
      userText(`m${i}`, `第 ${i} 句`),
    );

    const candidates = buildQuoteCandidates(messages, { limit: 5 });
    expect(candidates).toHaveLength(5);
    expect(candidates[candidates.length - 1]!.messageId).toBe("m29");
    expect(candidates[0]!.messageId).toBe("m25");
  });
});
