/**
 * @file proactiveSession.test.ts
 * 实时 AI 主动消息的会话轮转选择测试。
 */

import { describe, it, expect } from "vitest";
import type { ISession } from "@wechat-rp/shared-types";
import { pickNextProactiveSession } from "../utils/proactiveSession";

function makeSession(
  id: string,
  lastMessageTime: number,
  createdAt: number,
): ISession {
  return {
    id,
    type: "single",
    participantIds: [id, "user"],
    displayName: id,
    avatarUrl: "",
    lastMessagePreview: "",
    lastMessageTime,
    unreadCount: 0,
    isPinned: false,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("pickNextProactiveSession", () => {
  it("候选为空时返回 null", () => {
    expect(pickNextProactiveSession([])).toBeNull();
  });

  it("优先选择最久没有消息的会话", () => {
    const a = makeSession("a", 3000, 1);
    const b = makeSession("b", 1000, 1);
    const c = makeSession("c", 2000, 1);
    expect(pickNextProactiveSession([a, b, c])!.id).toBe("b");
  });

  it("时间戳相同时按创建时间稳定排序", () => {
    const older = makeSession("older", 1000, 100);
    const newer = makeSession("newer", 1000, 200);
    expect(pickNextProactiveSession([newer, older])!.id).toBe("older");
  });

  it("不修改入参数组", () => {
    const a = makeSession("a", 3000, 1);
    const b = makeSession("b", 1000, 1);
    const input = [a, b];
    pickNextProactiveSession(input);
    expect(input.map((s) => s.id)).toEqual(["a", "b"]);
  });
});
