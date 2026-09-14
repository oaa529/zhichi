/**
 * @file regenerate.test.ts
 * 重新生成的轮次定位：整轮识别、用户消息回溯、不可重发的情形。
 */

import { describe, it, expect } from "vitest";
import type { IMessage, IMessageQuote } from "@wechat-rp/shared-types";
import type { IMessageRuntime } from "../store/chatStore";
import {
  findLastEditableUserMessage,
  findLastReplyTurn,
} from "../utils/regenerate";

const CHAR = "char-su-wanqing";
const NOW = 1_700_000_000_000;

function wrap(message: Partial<IMessage> & { id: string; senderId: string }): IMessageRuntime {
  return {
    message: {
      recipientId: "user",
      sessionId: "s1",
      timestamp: NOW,
      chunkSequence: 0,
      emotion: "neutral",
      type: "text",
      text: "",
      sourceOffset: 0,
      ...message,
    } as IMessage,
    revealed: true,
    pending: false,
  };
}

function userText(id: string, text: string): IMessageRuntime {
  return wrap({ id, senderId: "user", type: "text", text } as never);
}

function charText(id: string, text: string): IMessageRuntime {
  return wrap({ id, senderId: CHAR, type: "text", text } as never);
}

/** 带引用的用户消息。 */
function userTextQuoted(
  id: string,
  text: string,
  quote: IMessageQuote,
): IMessageRuntime {
  return wrap({ id, senderId: "user", type: "text", text, quote } as never);
}

const CAT_QUOTE: IMessageQuote = {
  messageId: "a0",
  senderName: "苏晚晴",
  preview: "我家的猫叫团团",
};

describe("findLastReplyTurn", () => {
  it("带回引用：重新生成时引用不能丢", () => {
    const messages = [
      charText("a0", "我家的猫叫团团"),
      userTextQuoted("u1", "它叫什么名字来着？", CAT_QUOTE),
      charText("a1", "团团"),
    ];

    expect(findLastReplyTurn(messages, CHAR)).toEqual({
      fromMessageId: "a1",
      userText: "它叫什么名字来着？",
      quote: CAT_QUOTE,
    });
  });

  it("把末尾连续的 AI 气泡识别为同一轮，并找回触发它的用户消息", () => {
    const messages = [
      userText("u1", "在吗"),
      charText("a1", "在的"),
      charText("a2", "怎么啦"),
      userText("u2", "晚上吃什么"),
      charText("a3", "面条？"),
      charText("a4", "或者饺子"),
    ];

    const target = findLastReplyTurn(messages, CHAR);
    expect(target).toEqual({ fromMessageId: "a3", userText: "晚上吃什么" });
  });

  it("末尾不是角色消息时不提供重新生成（比如用户刚发完还没回）", () => {
    const messages = [charText("a1", "在的"), userText("u2", "在吗")];
    expect(findLastReplyTurn(messages, CHAR)).toBeNull();
  });

  it("会话以角色消息开头、找不到用户消息时为 null", () => {
    expect(findLastReplyTurn([charText("a1", "你好呀")], CHAR)).toBeNull();
  });

  it("空列表返回 null", () => {
    expect(findLastReplyTurn([], CHAR)).toBeNull();
  });

  it("用户发的是贴图时，用它的内联文案重发", () => {
    const sticker = wrap({
      id: "k1",
      senderId: "user",
      type: "sticker",
      stickerPackId: "p",
      stickerId: "s",
      fallbackText: "[微笑]",
    } as never);
    const target = findLastReplyTurn(
      [sticker, charText("a1", "哈哈")],
      CHAR,
    );
    expect(target).toEqual({ fromMessageId: "a1", userText: "[微笑]" });
  });

  it("用户发的是语音且有转写时，用转写文本重发", () => {
    const voice = wrap({
      id: "v1",
      senderId: "user",
      type: "voice",
      url: "",
      durationSec: 3,
      transcript: "我马上到",
    } as never);
    const target = findLastReplyTurn([voice, charText("a1", "好")], CHAR);
    expect(target).toEqual({ fromMessageId: "a1", userText: "我马上到" });
  });

  it("用户发的是图片（没有文本）时不给入口", () => {
    const image = wrap({
      id: "i1",
      senderId: "user",
      type: "image",
      url: "",
      width: 1,
      height: 1,
    } as never);
    expect(findLastReplyTurn([image, charText("a1", "好看")], CHAR)).toBeNull();
  });

  it("时间分割线夹在用户消息与回复之间时仍可重新生成", () => {
    const system = wrap({
      id: "sy1",
      senderId: "system",
      type: "system",
      systemKind: "time-divider",
      displayText: "昨天",
    } as never);
    const messages = [userText("u1", "早"), system, charText("a1", "早呀")];
    expect(findLastReplyTurn(messages, CHAR)).toEqual({
      fromMessageId: "a1",
      userText: "早",
    });
  });

  it("末尾是角色主动发的消息时不提供重新生成（没有可重发的内容）", () => {
    const system = wrap({
      id: "sy1",
      senderId: "system",
      type: "system",
      systemKind: "time-divider",
      displayText: "昨天",
    } as never);
    const messages = [
      userText("u1", "早"),
      charText("a1", "早呀"),
      system,
      charText("a2", "今天有课吗"),
    ];
    // a2 前面是 a1（角色），说明这是主动消息 → 不能拿"早"去重发
    expect(findLastReplyTurn(messages, CHAR)).toBeNull();
  });
});

describe("findLastEditableUserMessage", () => {
  it("定位到会话里最后一条用户消息", () => {
    const messages = [
      userText("u1", "在吗"),
      charText("a1", "在的"),
      userText("u2", "晚上吃什么"),
      charText("a2", "面条？"),
    ];
    expect(findLastEditableUserMessage(messages)).toEqual({
      messageId: "u2",
      text: "晚上吃什么",
    });
  });

  it("带引用的用户消息：编辑重发时引用一起带回", () => {
    const messages = [
      charText("a0", "我家的猫叫团团"),
      userTextQuoted("u1", "它叫什么名字来着？", CAT_QUOTE),
      charText("a1", "团团"),
    ];

    expect(findLastEditableUserMessage(messages)).toEqual({
      messageId: "u1",
      text: "它叫什么名字来着？",
      quote: CAT_QUOTE,
    });
  });

  it("用户刚发完、还没回复时也能编辑", () => {
    const messages = [charText("a1", "在的"), userText("u2", "在吗")];
    expect(findLastEditableUserMessage(messages)).toEqual({
      messageId: "u2",
      text: "在吗",
    });
  });

  it("没有任何用户消息时为 null（会话以角色开场）", () => {
    expect(findLastEditableUserMessage([charText("a1", "你好呀")])).toBeNull();
    expect(findLastEditableUserMessage([])).toBeNull();
  });

  it("最后一条用户消息是图片（没有文本）时不提供编辑", () => {
    const image = wrap({
      id: "i1",
      senderId: "user",
      type: "image",
      url: "",
      width: 1,
      height: 1,
    } as never);
    expect(findLastEditableUserMessage([userText("u1", "早"), image])).toBeNull();
  });

  it("贴图消息用内联文案作为可编辑文本", () => {
    const sticker = wrap({
      id: "k1",
      senderId: "user",
      type: "sticker",
      stickerPackId: "p",
      stickerId: "s",
      fallbackText: "[微笑]",
    } as never);
    expect(findLastEditableUserMessage([sticker, charText("a1", "哈哈")])).toEqual({
      messageId: "k1",
      text: "[微笑]",
    });
  });
});
