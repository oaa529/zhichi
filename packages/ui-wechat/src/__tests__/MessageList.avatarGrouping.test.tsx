/**
 * @file MessageList.avatarGrouping.test.tsx
 * 同一人连续消息只在第一条显示头像（微信行为）。
 *
 * 微信的聊天区不会给每条消息都挂头像：同一个人的连续几条只在第一条出现，
 * 后面的头像位留空（气泡保持对齐，不会左移），组内间距也更紧。
 * 长对话里一大片重复头像非常吵。
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { ITextMessage } from "@wechat-rp/shared-types";
import type { IMessageRuntime } from "../store/chatStore";
import { MessageList } from "../components/MessageList";

const NOW = 1_700_000_000_000;

/** 造一条消息；sender 决定归属，offset 决定时间先后。 */
function msg(
  id: string,
  senderId: "user" | "char-1",
  text: string,
  offsetSeconds: number,
): IMessageRuntime {
  const message: ITextMessage = {
    id,
    type: "text",
    senderId,
    recipientId: senderId === "user" ? "char-1" : "user",
    sessionId: "s1",
    text,
    timestamp: NOW + offsetSeconds * 1000,
    chunkSequence: 0,
    emotion: "neutral",
    sourceOffset: 0,
  };
  return { message, revealed: true, pending: false };
}

/** 取第 n 行；越界时给出可读报错，而不是让断言拿到 undefined。 */
function rowAt(rows: ReadonlyArray<HTMLElement>, index: number): HTMLElement {
  const row = rows[index];
  if (!row) throw new Error(`没有第 ${index} 行（共 ${rows.length} 行）`);
  return row;
}

/** 这行是不是"连续消息里的后续几条"（被归组、隐藏了头像）。 */
function isGrouped(row: HTMLElement): boolean {
  return row.classList.contains("wechat-msg-row--grouped");
}

function renderList(messages: ReadonlyArray<IMessageRuntime>) {
  const { container } = render(
    <MessageList
      sessionKey="s1"
      messages={messages}
      characterAvatarUrl=""
      typingActive={false}
      scrollerRef={() => {}}
      unreadMarkerMessageId={null}
    />,
  );
  return Array.from(
    container.querySelectorAll<HTMLElement>(".wechat-msg-row"),
  );
}

afterEach(cleanup);

describe("MessageList · 连续消息隐藏重复头像", () => {
  it("同一人连续三条：只有第一条算组首（不带 grouped 标记）", () => {
    const rows = renderList([
      msg("m-1", "char-1", "一", 0),
      msg("m-2", "char-1", "二", 10),
      msg("m-3", "char-1", "三", 20),
    ]);

    expect(rows).toHaveLength(3);
    expect(isGrouped(rowAt(rows, 0))).toBe(false);
    expect(isGrouped(rowAt(rows, 1))).toBe(true);
    expect(isGrouped(rowAt(rows, 2))).toBe(true);
  });

  it("说话人切换后重新算组首（自己的两条不该被并进对方那一组）", () => {
    const rows = renderList([
      msg("m-1", "char-1", "一", 0),
      msg("m-2", "char-1", "二", 10),
      msg("m-3", "user", "三", 20),
      msg("m-4", "user", "四", 30),
    ]);

    expect(rows.map(isGrouped)).toEqual([false, true, false, true]);
  });

  it("间隔太久不算连续（超过 5 分钟就重新出现头像）", () => {
    const rows = renderList([
      msg("m-1", "char-1", "一", 0),
      msg("m-2", "char-1", "很久之后", 6 * 60),
    ]);

    expect(isGrouped(rowAt(rows, 1))).toBe(false);
  });

  it("插入时间分隔线后重新算组首", () => {
    // 跨越 5 分钟必然触发时间分隔线；这里再确认分隔线之后那条不算 grouped
    const rows = renderList([
      msg("m-1", "char-1", "一", 0),
      msg("m-2", "char-1", "二", 10 * 60),
    ]);

    expect(isGrouped(rowAt(rows, 1))).toBe(false);
  });

  it("grouped 类名挂在消息行上，CSS 据此隐藏头像", () => {
    const rows = renderList([
      msg("m-1", "char-1", "一", 0),
      msg("m-2", "char-1", "二", 5),
    ]);
    expect(rowAt(rows, 1).dataset.messageId).toBe("m-2");
    expect(rowAt(rows, 1).className).toContain("wechat-msg-row--grouped");
  });
});