/**
 * @file scrollFollow.test.ts
 * 滚动跟随判定回归测试（对应"消息往上挤"与"打断浏览历史"两类 bug）。
 */

import { describe, it, expect } from "vitest";
import { shouldFollowBottom } from "../utils/scrollFollow";

describe("shouldFollowBottom", () => {
  it("首次填充（0 → N）必须跟随", () => {
    expect(
      shouldFollowBottom({
        prevCount: 0,
        messageCount: 12,
        lastSenderId: "char-1",
        stickyBottom: false,
      }),
    ).toBe(true);
  });

  it("自己发送的消息总是跟随（即使在翻阅历史）", () => {
    expect(
      shouldFollowBottom({
        prevCount: 20,
        messageCount: 21,
        lastSenderId: "user",
        stickyBottom: false,
      }),
    ).toBe(true);
  });

  it("贴底时角色新消息跟随", () => {
    expect(
      shouldFollowBottom({
        prevCount: 20,
        messageCount: 21,
        lastSenderId: "char-1",
        stickyBottom: true,
      }),
    ).toBe(true);
  });

  it("翻阅历史时角色新消息不跟随（避免打断阅读）", () => {
    expect(
      shouldFollowBottom({
        prevCount: 20,
        messageCount: 21,
        lastSenderId: "char-1",
        stickyBottom: false,
      }),
    ).toBe(false);
  });

  it("消息数未增加时不跟随", () => {
    expect(
      shouldFollowBottom({
        prevCount: 20,
        messageCount: 20,
        lastSenderId: "char-1",
        stickyBottom: true,
      }),
    ).toBe(false);
    expect(
      shouldFollowBottom({
        prevCount: 20,
        messageCount: 18,
        lastSenderId: "char-1",
        stickyBottom: true,
      }),
    ).toBe(false);
  });
});
