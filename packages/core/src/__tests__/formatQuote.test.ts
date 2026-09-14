/**
 * @file formatQuote.test.ts
 * 引用摘要与 Prompt 文本化的边界测试。
 */

import { describe, it, expect } from "vitest";
import type { ITextMessage } from "@wechat-rp/shared-types";
import {
  buildQuotePreview,
  formatQuotedText,
  QUOTE_PREVIEW_MAX_CHARS,
} from "../llm/formatQuote";
import { getMessagePlainText } from "../llm/toLLMHistory";

describe("buildQuotePreview", () => {
  it("压平换行与多余空白", () => {
    expect(buildQuotePreview("  第一行\n\n第二行   后面  ")).toBe(
      "第一行 第二行 后面",
    );
  });

  it("超长文本截断并加省略号", () => {
    const long = "啊".repeat(200);
    const preview = buildQuotePreview(long);
    expect(preview.length).toBe(QUOTE_PREVIEW_MAX_CHARS);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("刚好等于上限时不截断（不加省略号）", () => {
    const exact = "字".repeat(QUOTE_PREVIEW_MAX_CHARS);
    expect(buildQuotePreview(exact)).toBe(exact);
  });

  it("尊重自定义上限", () => {
    expect(buildQuotePreview("abcdef", 4)).toBe("abc…");
  });
});

describe("formatQuotedText", () => {
  it("引用信息与正文之间保留换行，模型能分清引用与回答", () => {
    expect(
      formatQuotedText("我睡过头了", {
        messageId: "m1",
        senderName: "苏晚晴",
        preview: "你今天怎么没来上课？",
      }),
    ).toBe("（引用消息 · 苏晚晴：「你今天怎么没来上课？」）\n我睡过头了");
  });
});

describe("getMessagePlainText", () => {
  const base = {
    recipientId: "user",
    sessionId: "s1",
    timestamp: 1000,
    chunkSequence: 0,
    emotion: "neutral",
  } as const;

  it("文本消息返回原文", () => {
    const message: ITextMessage = {
      ...base,
      id: "m1",
      senderId: "user",
      type: "text",
      text: "你好",
      sourceOffset: 0,
    };
    expect(getMessagePlainText(message)).toBe("你好");
  });

  it("空文本与系统消息返回 null（不提供复制与引用）", () => {
    expect(
      getMessagePlainText({
        ...base,
        id: "m2",
        senderId: "user",
        type: "text",
        text: "   ",
        sourceOffset: 0,
      }),
    ).toBeNull();
    expect(
      getMessagePlainText({
        ...base,
        id: "m3",
        senderId: "system",
        type: "system",
        systemKind: "time-divider",
        displayText: "昨天",
      }),
    ).toBeNull();
  });
});
