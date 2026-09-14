/**
 * @file MessageList.unreadDivider.test.tsx
 * "以下为新消息"分隔线：位置对不对、该不该出现。
 *
 * 微信里这条线画在"你离开期间收到的第一条消息"之前，
 * 让用户一眼看到自己从哪儿接着看。
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ITextMessage } from "@wechat-rp/shared-types";
import type { IMessageRuntime } from "../store/chatStore";
import { MessageList } from "../components/MessageList";

const NOW = 1_700_000_000_000;

function runtime(id: string, text: string, offset: number): IMessageRuntime {
  const message: ITextMessage = {
    id,
    type: "text",
    senderId: offset % 2 === 0 ? "user" : "char-1",
    recipientId: offset % 2 === 0 ? "char-1" : "user",
    sessionId: "s1",
    text,
    timestamp: NOW + offset * 1000,
    chunkSequence: 0,
    emotion: "neutral",
    sourceOffset: 0,
  };
  return { message, revealed: true, pending: false };
}

const MESSAGES = [
  runtime("m-1", "第一句", 0),
  runtime("m-2", "第二句", 1),
  runtime("m-3", "第三句", 2),
];

afterEach(cleanup);

describe("MessageList · 以下为新消息", () => {
  it("画在标记的那条消息之前", () => {
    const { container } = render(
      <MessageList
        sessionKey="s1"
        messages={MESSAGES}
        characterAvatarUrl=""
        typingActive={false}
        unreadMarkerMessageId="m-2"
      />,
    );

    expect(screen.getByText("以下为新消息")).toBeTruthy();
    // 分隔线要紧挨着 m-2（在它的行容器之前）
    const rows = [...container.querySelectorAll(".wechat-msg-row")];
    expect(rows).toHaveLength(3);
    const divider = container.querySelector(".wechat-unread-divider")!;
    expect(divider.nextElementSibling).toBe(rows[1]);
  });

  it("没有标记时整条线不出现", () => {
    render(
      <MessageList
        sessionKey="s1"
        messages={MESSAGES}
        characterAvatarUrl=""
        typingActive={false}
        unreadMarkerMessageId={null}
      />,
    );

    expect(screen.queryByText("以下为新消息")).toBeNull();
  });

  it("标记的消息已经不在列表里时也不画（例如被撤回成提示后重建）", () => {
    render(
      <MessageList
        sessionKey="s1"
        messages={MESSAGES}
        characterAvatarUrl=""
        typingActive={false}
        unreadMarkerMessageId="m-not-exist"
      />,
    );

    expect(screen.queryByText("以下为新消息")).toBeNull();
  });
});
