/**
 * @file TranscriptExport.test.ts
 * 聊天记录导出：人读格式、跳过噪声、引用与跨天处理。
 */

import { describe, it, expect } from "vitest";
import type { IMessage, ITextMessage } from "@wechat-rp/shared-types";
import { buildTranscript } from "../export/TranscriptExport";

/** 2026-09-13 15:20 本地时间（测试里用固定时间，避免时区漂移）。 */
const BASE = new Date(2026, 8, 13, 15, 20, 0).getTime();

const base = {
  recipientId: "user",
  sessionId: "s1",
  chunkSequence: 0,
  emotion: "neutral",
} as const;

function text(
  id: string,
  senderId: string,
  content: string,
  offsetMs = 0,
  extra: Partial<ITextMessage> = {},
): ITextMessage {
  return {
    ...base,
    ...extra,
    id,
    senderId,
    type: "text",
    text: content,
    timestamp: BASE + offsetMs,
    sourceOffset: 0,
  };
}

describe("buildTranscript", () => {
  it("标题、导出信息、日期与逐条署名都在", () => {
    const markdown = buildTranscript(
      [text("m1", "user", "在吗"), text("m2", "char-1", "在的", 60_000)],
      { characterName: "林笑笑", now: BASE },
    );

    expect(markdown).toContain("# 与 林笑笑 的聊天记录");
    expect(markdown).toContain("共 2 条消息");
    expect(markdown).toContain("## 2026/9/13");
    expect(markdown).toContain("**我** 15:20");
    expect(markdown).toContain("在吗");
    expect(markdown).toContain("**林笑笑** 15:21");
  });

  it("系统消息与撤回提示不导出（那是噪声，不是对话内容）", () => {
    const system: IMessage = {
      ...base,
      id: "sys",
      senderId: "system",
      type: "system",
      systemKind: "time-divider",
      displayText: "昨天",
      timestamp: BASE,
    };
    const recall: IMessage = {
      ...base,
      id: "rc",
      senderId: "char-1",
      type: "recall",
      targetMessageId: "m1",
      notice: "林笑笑撤回了一条消息",
      timestamp: BASE + 1000,
    };

    const markdown = buildTranscript([system, recall, text("m1", "user", "留下的内容")], {
      characterName: "林笑笑",
      now: BASE,
    });

    expect(markdown).toContain("留下的内容");
    expect(markdown).not.toContain("昨天");
    expect(markdown).not.toContain("撤回");
    expect(markdown).toContain("共 1 条消息");
  });

  it("引用渲染成引用块（人读时能看出回应的是哪句）", () => {
    const quoted = text("m2", "user", "我也这么觉得", 60_000, {
      quote: {
        messageId: "m1",
        senderName: "林笑笑",
        preview: "明天要下雨",
      },
    });
    const markdown = buildTranscript([quoted], {
      characterName: "林笑笑",
      now: BASE,
    });

    expect(markdown).toContain("> 引用 林笑笑：明天要下雨");
    expect(markdown).toContain("我也这么觉得");
  });

  it("跨天时插入新的日期标题", () => {
    const nextDay = text("m2", "char-1", "第二天好", 24 * 60 * 60 * 1000);
    const markdown = buildTranscript([text("m1", "user", "第一天"), nextDay], {
      characterName: "林笑笑",
      now: BASE,
    });

    expect(markdown).toContain("## 2026/9/13");
    expect(markdown).toContain("## 2026/9/14");
  });

  it("贴图、语音、图片都有可读占位", () => {
    const sticker: IMessage = {
      ...base,
      id: "s1",
      senderId: "char-1",
      type: "sticker",
      stickerPackId: "zhichi-basic",
      stickerId: "grin",
      fallbackText: "[开心]",
      timestamp: BASE,
    };
    const voice: IMessage = {
      ...base,
      id: "v1",
      senderId: "char-1",
      type: "voice",
      url: "",
      durationSec: 8,
      timestamp: BASE + 1000,
    };
    const image: IMessage = {
      ...base,
      id: "i1",
      senderId: "user",
      type: "image",
      url: "",
      width: 1,
      height: 1,
      timestamp: BASE + 2000,
    };

    const markdown = buildTranscript([sticker, voice, image], {
      characterName: "林笑笑",
      now: BASE,
    });

    expect(markdown).toContain("[开心]");
    expect(markdown).toContain("[语音 8 秒]");
    expect(markdown).toContain("[图片]");
  });

  it("乱序输入也按时间排好", () => {
    const markdown = buildTranscript(
      [text("m2", "char-1", "第二句", 60_000), text("m1", "user", "第一句")],
      { characterName: "林笑笑", now: BASE },
    );

    expect(markdown.indexOf("第一句")).toBeLessThan(markdown.indexOf("第二句"));
  });

  it("空会话也产出一份可读文件（标题 + 0 条）", () => {
    const markdown = buildTranscript([], { characterName: "林笑笑", now: BASE });
    expect(markdown).toContain("# 与 林笑笑 的聊天记录");
    expect(markdown).toContain("共 0 条消息");
  });

  it("用户名可以自定义", () => {
    const markdown = buildTranscript([text("m1", "user", "你好")], {
      characterName: "林笑笑",
      userName: "阿风",
      now: BASE,
    });
    expect(markdown).toContain("**阿风** 15:20");
  });
});
