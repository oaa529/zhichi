/**
 * @file Recall.test.ts
 * 撤回规则的纯函数测试：两分钟窗口、提示文案、撤回后的消息形状。
 */

import { describe, it, expect } from "vitest";
import {
  buildRecallNotice,
  canRecall,
  RECALL_WINDOW_MS,
  SELF_RECALL_NOTICE,
  toRecallMessage,
} from "../recall/Recall";
import type { IMessage, IRecallMessage, ITextMessage } from "@wechat-rp/shared-types";

const NOW = 1_700_000_000_000;

function textMessage(overrides: Partial<ITextMessage> = {}): ITextMessage {
  return {
    id: "m1",
    type: "text",
    senderId: "user",
    recipientId: "char-1",
    sessionId: "s1",
    timestamp: NOW,
    chunkSequence: 3,
    emotion: "neutral",
    text: "刚才那句话说重了，对不起",
    sourceOffset: 0,
    ...overrides,
  };
}

describe("canRecall", () => {
  it("自己刚发（两分钟内）的消息可以撤回", () => {
    expect(canRecall(textMessage(), NOW + 1000)).toBe(true);
  });

  it("刚好卡在两分钟整还算可以撤回，超过一秒就不行", () => {
    expect(canRecall(textMessage(), NOW + RECALL_WINDOW_MS)).toBe(true);
    expect(canRecall(textMessage(), NOW + RECALL_WINDOW_MS + 1)).toBe(false);
  });

  it("角色发的消息不能撤回（只有自己那条才轮得到）", () => {
    expect(canRecall(textMessage({ senderId: "char-1" }), NOW + 1000)).toBe(
      false,
    );
  });

  it("系统提示与撤回提示本身不可撤回", () => {
    const system: IMessage = {
      id: "sys-1",
      type: "system",
      senderId: "user",
      recipientId: "char-1",
      sessionId: "s1",
      timestamp: NOW,
      chunkSequence: 0,
      emotion: "neutral",
      systemKind: "time-divider",
      displayText: "昨天 20:00",
    };
    const recall: IRecallMessage = {
      id: "r1",
      type: "recall",
      senderId: "user",
      recipientId: "char-1",
      sessionId: "s1",
      timestamp: NOW,
      chunkSequence: 0,
      emotion: "neutral",
      targetMessageId: "m1",
      notice: SELF_RECALL_NOTICE,
    };

    expect(canRecall(system, NOW + 1000)).toBe(false);
    expect(canRecall(recall, NOW + 1000)).toBe(false);
  });

  it("时间戳在未来（时钟回拨/导入数据）时按不可撤回处理", () => {
    expect(canRecall(textMessage(), NOW - 60_000)).toBe(false);
  });
});

describe("buildRecallNotice", () => {
  it("带上发送者名字，读起来像微信的提示", () => {
    expect(buildRecallNotice("苏晚晴")).toBe("苏晚晴撤回了一条消息");
  });
});

describe("toRecallMessage", () => {
  it("保留定位字段，丢掉正文（撤回之后不该还能捞出原文）", () => {
    const recalled = toRecallMessage(textMessage(), SELF_RECALL_NOTICE);

    expect(recalled.id).toBe("m1");
    expect(recalled.type).toBe("recall");
    expect(recalled.senderId).toBe("user");
    expect(recalled.sessionId).toBe("s1");
    expect(recalled.timestamp).toBe(NOW);
    expect(recalled.chunkSequence).toBe(3);
    expect(recalled.targetMessageId).toBe("m1");
    expect(recalled.notice).toBe(SELF_RECALL_NOTICE);
    // 正文不在结果里——这是"撤回"与"删除"之外的第三层含义
    expect("text" in recalled).toBe(false);
  });

  it("贴图也能被撤回（贴图没有 text，但有内联文案）", () => {
    const sticker = toRecallMessage(
      {
        id: "st-1",
        type: "sticker",
        senderId: "user",
        recipientId: "char-1",
        sessionId: "s1",
        timestamp: NOW,
        chunkSequence: 1,
        emotion: "happy",
        stickerPackId: "basic",
        stickerId: "smile",
        fallbackText: "[微笑]",
      },
      SELF_RECALL_NOTICE,
    );

    expect(sticker.type).toBe("recall");
    expect("fallbackText" in sticker).toBe(false);
  });
});
