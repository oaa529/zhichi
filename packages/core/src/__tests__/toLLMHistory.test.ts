/**
 * @file toLLMHistory.test.ts
 * 会话消息 → LLM 消息历史转换的边界测试。
 */

import { describe, it, expect } from "vitest";
import type {
  IImageMessage,
  IRecallMessage,
  IStickerMessage,
  ISystemMessage,
  ITextMessage,
  IVoiceMessage,
} from "@wechat-rp/shared-types";
import { toLLMHistory } from "../llm/toLLMHistory";

const base = {
  recipientId: "user",
  sessionId: "s1",
  timestamp: 1000,
  chunkSequence: 0,
  emotion: "neutral",
} as const;

const userText: ITextMessage = {
  ...base,
  id: "m1",
  senderId: "user",
  type: "text",
  text: "你好呀",
  sourceOffset: 0,
};

const characterText: ITextMessage = {
  ...base,
  id: "m2",
  senderId: "char-1",
  type: "text",
  text: "晚上好",
  sourceOffset: 3,
};

describe("toLLMHistory", () => {
  it("文本消息按发送者映射为 user / assistant", () => {
    const history = toLLMHistory([userText, characterText]);
    expect(history).toEqual([
      { role: "user", content: "你好呀" },
      { role: "assistant", content: "晚上好" },
    ]);
  });

  it("贴图消息取 fallbackText", () => {
    const sticker: IStickerMessage = {
      ...base,
      id: "m3",
      senderId: "char-1",
      type: "sticker",
      stickerPackId: "pack",
      stickerId: "smile",
      fallbackText: "[微笑]",
    };
    expect(toLLMHistory([sticker])).toEqual([
      { role: "assistant", content: "[微笑]" },
    ]);
  });

  it("语音消息优先转录文本，缺失时降级为时长占位", () => {
    const withTranscript: IVoiceMessage = {
      ...base,
      id: "m4",
      senderId: "char-1",
      type: "voice",
      url: "blob:voice",
      durationSec: 12,
      transcript: "我马上到",
    };
    const withoutTranscript: IVoiceMessage = {
      ...withTranscript,
      id: "m5",
      transcript: undefined,
    };
    const history = toLLMHistory([withTranscript, withoutTranscript]);
    expect(history[0]!.content).toBe("我马上到");
    expect(history[1]!.content).toBe("[语音 12 秒]");
  });

  it("图片消息转为 [图片] 占位", () => {
    const image: IImageMessage = {
      ...base,
      id: "m6",
      senderId: "user",
      type: "image",
      url: "blob:image",
      width: 100,
      height: 100,
    };
    expect(toLLMHistory([image])).toEqual([
      { role: "user", content: "[图片]" },
    ]);
  });

  it("系统消息与撤回消息不进入历史", () => {
    const systemMessage: ISystemMessage = {
      ...base,
      id: "m7",
      senderId: "system",
      type: "system",
      systemKind: "time-divider",
      displayText: "以下消息已加密",
    };
    const recall: IRecallMessage = {
      ...base,
      id: "m8",
      senderId: "char-1",
      type: "recall",
      targetMessageId: "m2",
      notice: "撤回了一条消息",
    };
    expect(toLLMHistory([systemMessage, recall])).toEqual([]);
  });

  it("带引用的消息：正文前补一行「引用了谁说的什么」", () => {
    const quoted: ITextMessage = {
      ...userText,
      id: "m11",
      text: "我睡过头了……",
      quote: {
        messageId: "m2",
        senderName: "苏晚晴",
        preview: "你今天怎么没来上课？",
      },
    };

    expect(toLLMHistory([quoted])).toEqual([
      {
        role: "user",
        content:
          "（引用消息 · 苏晚晴：「你今天怎么没来上课？」）\n我睡过头了……",
      },
    ]);
  });

  it("带引用的贴图消息：引用行排在占位文本之前", () => {
    const sticker: IStickerMessage = {
      ...base,
      id: "m13",
      senderId: "char-1",
      type: "sticker",
      stickerPackId: "pack",
      stickerId: "smile",
      fallbackText: "[微笑]",
      quote: { messageId: "m1", senderName: "我", preview: "早点睡" },
    };

    expect(toLLMHistory([sticker])).toEqual([
      { role: "assistant", content: "（引用消息 · 我：「早点睡」）\n[微笑]" },
    ]);
  });

  it("空文本消息被跳过", () => {
    const empty: ITextMessage = { ...userText, id: "m9", text: "   " };
    expect(toLLMHistory([empty])).toEqual([]);
  });

  it("按时间戳 + chunkSequence 排序后转换", () => {
    const later: ITextMessage = {
      ...userText,
      id: "m10",
      timestamp: 2000,
      text: "第二条",
    };
    const history = toLLMHistory([later, userText]);
    expect(history.map((m) => m.content)).toEqual(["你好呀", "第二条"]);
  });
});
