/**
 * @file messageOrder.test.ts
 * 消息显示顺序回归测试：跨轮消息不得因 chunkSequence 重置而错位。
 */

import { describe, it, expect } from "vitest";
import type { ITextMessage } from "@wechat-rp/shared-types";
import type { IMessageRuntime } from "../store/chatStore";
import { sortMessagesForDisplay } from "../utils/messageOrder";

function makeRuntime(
  id: string,
  senderId: string,
  timestamp: number,
  chunkSequence: number,
): IMessageRuntime {
  const message: ITextMessage = {
    id,
    type: "text",
    senderId,
    recipientId: senderId === "user" ? "char-1" : "user",
    sessionId: "s1",
    timestamp,
    chunkSequence,
    emotion: "neutral",
    text: id,
    sourceOffset: 0,
  };
  return { message, revealed: true, pending: false };
}

describe("sortMessagesForDisplay", () => {
  it("跨轮消息按时间顺序排列（不受 chunkSequence 重置影响）", () => {
    // 插入顺序：U1 → R1a(seq0) → R1b(seq1) → U2(seq0) → R2a(seq0)
    // 按 chunkSequence 主序的错误实现会把 R1b 排到 U2、R2a 之后。
    const input = [
      makeRuntime("U1", "user", 1000, 0),
      makeRuntime("R1a", "char-1", 1100, 0),
      makeRuntime("R1b", "char-1", 1400, 1),
      makeRuntime("U2", "user", 2000, 0),
      makeRuntime("R2a", "char-1", 2100, 0),
    ];

    const sorted = sortMessagesForDisplay(input);
    expect(sorted.map((rt) => rt.message.id)).toEqual([
      "U1",
      "R1a",
      "R1b",
      "U2",
      "R2a",
    ]);
  });

  it("同一时间戳的多条消息保持插入顺序", () => {
    const input = [
      makeRuntime("A", "char-1", 1000, 0),
      makeRuntime("B", "char-1", 1000, 1),
      makeRuntime("C", "char-1", 1000, 2),
    ];
    expect(sortMessagesForDisplay(input).map((rt) => rt.message.id)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("时间戳乱序时按时间戳纠正（hydration 兜底）", () => {
    const input = [
      makeRuntime("later", "user", 2000, 0),
      makeRuntime("earlier", "char-1", 1000, 0),
    ];
    expect(sortMessagesForDisplay(input).map((rt) => rt.message.id)).toEqual([
      "earlier",
      "later",
    ]);
  });

  it("不修改入参数组", () => {
    const input = [
      makeRuntime("B", "char-1", 2000, 0),
      makeRuntime("A", "user", 1000, 0),
    ];
    const snapshot = input.map((rt) => rt.message.id);
    sortMessagesForDisplay(input);
    expect(input.map((rt) => rt.message.id)).toEqual(snapshot);
  });
});
