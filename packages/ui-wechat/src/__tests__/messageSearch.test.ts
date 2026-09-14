/**
 * @file messageSearch.test.ts
 * 跨会话消息搜索：可搜索类型、片段截取、排序与截断。
 */

import { describe, it, expect } from "vitest";
import type { IMessage, ISession } from "@wechat-rp/shared-types";
import {
  buildSnippet,
  extractSearchableText,
  searchMessages,
} from "../utils/messageSearch";

const NOW = 1_700_000_000_000;

function makeSession(id: string, name: string): ISession {
  return {
    id,
    type: "single",
    participantIds: ["char-1", "user"],
    displayName: name,
    avatarUrl: "",
    lastMessagePreview: "",
    lastMessageTime: NOW,
    unreadCount: 0,
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function baseMessage(id: string, timestamp: number): Omit<
  Extract<IMessage, { type: "text" }>,
  "type" | "text" | "sourceOffset"
> {
  return {
    id,
    senderId: "user",
    recipientId: "char-1",
    sessionId: "s1",
    timestamp,
    chunkSequence: 0,
    emotion: "neutral",
  };
}

function textMessage(id: string, text: string, timestamp: number): IMessage {
  return { ...baseMessage(id, timestamp), type: "text", text, sourceOffset: 0 };
}

function runtime(messages: ReadonlyArray<unknown>): { messages: unknown[] } {
  return { messages: [...messages] };
}

/** 包成运行时结构（备份与 store 里的实际形状）。 */
function wrap(message: IMessage): unknown {
  return { message, revealed: true, pending: false };
}

describe("extractSearchableText", () => {
  it("文本消息取正文", () => {
    expect(extractSearchableText(textMessage("m1", "晚上一起吃饭", NOW))).toBe(
      "晚上一起吃饭",
    );
  });

  it("语音消息取转写文本，没转写则不可搜", () => {
    const withText = {
      ...baseMessage("v1", NOW),
      type: "voice" as const,
      url: "",
      durationSec: 3,
      transcript: "我马上到",
    };
    const without = {
      ...baseMessage("v2", NOW),
      type: "voice" as const,
      url: "",
      durationSec: 3,
    };
    expect(extractSearchableText(withText)).toBe("我马上到");
    expect(extractSearchableText(without)).toBeNull();
  });

  it("贴图取内联文案；图片/系统/撤回不可搜", () => {
    const sticker = {
      ...baseMessage("k1", NOW),
      type: "sticker" as const,
      stickerPackId: "p",
      stickerId: "s",
      fallbackText: "[微笑]",
    };
    const image = {
      ...baseMessage("i1", NOW),
      type: "image" as const,
      url: "",
      width: 1,
      height: 1,
    };
    const system = {
      ...baseMessage("sy1", NOW),
      type: "system" as const,
      systemKind: "time-divider" as const,
      displayText: "昨天",
    };
    const recall = {
      ...baseMessage("r1", NOW),
      type: "recall" as const,
      targetMessageId: "m1",
      notice: "撤回了一条消息",
    };

    expect(extractSearchableText(sticker)).toBe("[微笑]");
    expect(extractSearchableText(image)).toBeNull();
    expect(extractSearchableText(system)).toBeNull();
    expect(extractSearchableText(recall)).toBeNull();
  });
});

describe("buildSnippet", () => {
  it("短文本原样返回，命中下标正确", () => {
    const { snippet, matchIndex } = buildSnippet("今天吃火锅", "火锅", 48);
    expect(snippet).toBe("今天吃火锅");
    expect(matchIndex).toBe(3);
  });

  it("长文本按命中点居中截断并补省略号", () => {
    const text = `${"前".repeat(100)}关键词${"后".repeat(100)}`;
    const { snippet, matchIndex } = buildSnippet(text, "关键词", 20);

    expect(snippet.length).toBeLessThanOrEqual(22);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    // 片段里真的包含关键词，且下标指向它
    expect(snippet.slice(matchIndex, matchIndex + 3)).toBe("关键词");
  });

  it("命中在开头时不加前省略号", () => {
    const text = `关键词${"后".repeat(100)}`;
    const { snippet, matchIndex } = buildSnippet(text, "关键词", 20);
    expect(snippet.startsWith("…")).toBe(false);
    expect(matchIndex).toBe(0);
  });

  it("没命中时退化为前 N 个字符", () => {
    const { snippet, matchIndex } = buildSnippet("一二三四五六", "找不到", 3);
    expect(snippet).toBe("一二三…");
    expect(matchIndex).toBe(-1);
  });
});

describe("searchMessages", () => {
  const sessions = {
    s1: makeSession("s1", "苏晚晴"),
    s2: makeSession("s2", "林笑笑"),
  };

  it("空查询返回空结果", () => {
    const runtimes = { s1: runtime([wrap(textMessage("m1", "你好", NOW))]) };
    expect(searchMessages("", sessions, runtimes).total).toBe(0);
    expect(searchMessages("   ", sessions, runtimes).total).toBe(0);
  });

  it("跨会话命中，按时间倒序，并带上会话名", () => {
    const runtimes = {
      s1: runtime([
        wrap(textMessage("m1", "明天去看电影", NOW - 1000)),
        wrap(textMessage("m2", "晚安", NOW)),
      ]),
      s2: runtime([wrap(textMessage("m3", "电影院见", NOW - 500))]),
    };

    const result = searchMessages("电影", sessions, runtimes);
    expect(result.total).toBe(2);
    expect(result.hits.map((h) => h.messageId)).toEqual(["m3", "m1"]);
    expect(result.hits[0]?.sessionName).toBe("林笑笑");
    expect(result.hits[1]?.sessionName).toBe("苏晚晴");
  });

  it("大小写不敏感，命中长度取原文长度", () => {
    const runtimes = {
      s1: runtime([wrap(textMessage("m1", "用 TypeScript 写", NOW))]),
    };
    const result = searchMessages("typescript", sessions, runtimes);
    expect(result.total).toBe(1);
    // 高亮区间按**原文**长度给（查询是小写，原文是 TypeScript）
    expect(result.hits[0]?.matches[0]?.length).toBe("typescript".length);
  });

  it("多个词是 AND：都要出现才算命中（此前带空格的查询永远是 0 条）", () => {
    const runtimes = {
      s1: runtime([
        wrap(textMessage("both", "团团明天要去医院复查", NOW)),
        wrap(textMessage("only-cat", "团团最近很粘人", NOW - 1000)),
        wrap(textMessage("only-hospital", "我明天要去医院", NOW - 2000)),
      ]),
    };

    const result = searchMessages("团团 医院", sessions, runtimes);

    expect(result.total).toBe(1);
    expect(result.hits[0]!.messageId).toBe("both");
    // 两个词各给一处高亮
    expect(result.hits[0]!.matches).toHaveLength(2);
    expect(
      result.hits[0]!.matches.map((span) =>
        result.hits[0]!.snippet.slice(span.index, span.index + span.length),
      ),
    ).toEqual(["团团", "医院"]);
  });

  it("同一个词出现在多处时，片段里每处都高亮", () => {
    const runtimes = {
      s1: runtime([wrap(textMessage("m1", "猫又来了，猫很困", NOW))]),
    };

    const result = searchMessages("猫", sessions, runtimes);

    expect(result.hits[0]!.matches).toHaveLength(2);
  });

  it("挨着的命中会并成一段（不画嵌套高亮）", () => {
    const runtimes = {
      s1: runtime([wrap(textMessage("m1", "猫猫猫", NOW))]),
    };

    const result = searchMessages("猫", sessions, runtimes);

    expect(result.hits[0]!.matches).toEqual([{ index: 0, length: 3 }]);
  });

  it("超过上限时截断，但 total 反映真实命中数", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      wrap(textMessage(`m${i}`, `第${i}条测试`, NOW + i)),
    );
    const runtimes = { s1: runtime(messages) };

    const result = searchMessages("测试", sessions, runtimes, { limit: 3 });
    expect(result.hits).toHaveLength(3);
    expect(result.total).toBe(10);
    // 截断保留的是最近的三条
    expect(result.hits.map((h) => h.messageId)).toEqual(["m9", "m8", "m7"]);
  });

  it("会话已删除时仍返回命中（会话名留空），不丢数据", () => {
    const runtimes = {
      "s-orphan": runtime([wrap(textMessage("m1", "孤儿消息", NOW))]),
    };
    const result = searchMessages("孤儿", sessions, runtimes);
    expect(result.total).toBe(1);
    expect(result.hits[0]?.sessionName).toBe("");
  });

  it("结构不对的运行时候选被安全跳过", () => {
    const runtimes = {
      s1: runtime([
        null,
        "字符串",
        { 没有message: true },
        wrap(textMessage("m1", "有效消息", NOW)),
      ]),
    };
    const result = searchMessages("有效", sessions, runtimes as never);
    expect(result.total).toBe(1);
  });
});
