/**
 * @file ChatSessionView.emptyState.test.tsx
 * 空会话兜底：没有开场白可展示时不能是一块白板。
 *
 * 触发条件：角色没配开场白（或用户自己建的角色省了这一项），
 * 此时会话里一条消息都没有——必须告诉用户"可以干什么"，
 * 而不是甩一片空白。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ICharacterProfile } from "@wechat-rp/shared-types";
import { useChatStore } from "../store/chatStore";
import { useSessionStore } from "../store/sessionStore";
import { ChatSessionView } from "../components/ChatSessionView";

const profile: ICharacterProfile = {
  id: "char-1",
  displayName: "苏晚晴",
  bio: "邻家姐姐",
  visualMetadata: {
    avatarUrl: "data:image/svg+xml,avatar",
    sprites: [],
    supportsPinSprite: false,
    defaultSpriteAnchor: "left",
  },
  schedule: {
    wakeTime: "07:30",
    sleepTime: "23:30",
    scheduleEnabled: false,
    timezone: "Asia/Shanghai",
    sleepReplyPolicy: "drowsy-burst",
  },
  personalityTraits: {
    archetype: "gentle",
    typingSpeedMultiplier: 1,
    fragmentationBias: 0.5,
    hesitationProbability: 0.1,
    typoRate: 0,
    stickerFrequency: 0,
  },
  promptTemplateId: "",
};

beforeEach(() => {
  useChatStore.setState({ messages: [], phase: "idle", typingIndicator: { active: false, estimatedRemainingMs: 0 } });
  useSessionStore.setState({
    sessions: {
      s1: {
        id: "s1",
        type: "single",
        participantIds: ["char-1", "user"],
        displayName: "苏晚晴",
        avatarUrl: "",
        lastMessagePreview: "",
        lastMessageTime: 0,
        unreadCount: 0,
        isPinned: false,
        createdAt: 0,
        updatedAt: 0,
      },
    },
    characters: { "char-1": profile },
    activeSessionId: "s1",
  });
});

afterEach(cleanup);

function renderView(overrides: Partial<Parameters<typeof ChatSessionView>[0]> = {}) {
  return render(
    <ChatSessionView
      sessionId="s1"
      characterDisplayName="苏晚晴"
      characterAvatarUrl={profile.visualMetadata.avatarUrl}
      characterProfile={profile}
      onQuote={vi.fn()}
      onRetry={vi.fn()}
      onRegenerate={vi.fn()}
      onEditSubmit={vi.fn()}
      onDeleteMessage={vi.fn()}
      {...overrides}
    />,
  );
}

describe("ChatSessionView · 空会话兜底", () => {
  it("没有消息时显示引导（角色名 + 发第一条消息 + 按键提示），而不是白板", () => {
    const { container } = renderView();
    const empty = container.querySelector(".wechat-chat-session__empty")!;
    expect(empty).toBeTruthy();
    expect(empty.textContent).toContain("发第一条消息，开始聊天吧");
    expect(empty.textContent).toContain("Enter 发送 · Shift+Enter 换行");
    expect(empty.textContent).toContain("苏晚晴");
  });

  it("头像也一起展示（空状态顺带介绍角色是谁）", () => {
    const { container } = renderView();
    const avatar = container.querySelector(".wechat-chat-session__empty-avatar");
    expect(avatar).toBeTruthy();
    expect(avatar?.getAttribute("src")).toBe("data:image/svg+xml,avatar");
  });

  it("有消息时不再显示空状态", () => {
    useChatStore.setState({
      messages: [
        {
          message: {
            id: "m-1",
            type: "text",
            senderId: "char-1",
            recipientId: "user",
            sessionId: "s1",
            text: "你好呀",
            timestamp: 1,
            chunkSequence: 0,
            emotion: "neutral",
            sourceOffset: 0,
          },
          revealed: true,
          pending: false,
        },
      ],
    });
    renderView();
    expect(screen.queryByText("发第一条消息，开始聊天吧")).toBeNull();
    expect(screen.getByText("你好呀")).toBeTruthy();
  });

  it("没有消息但对方正在输入时优先渲染输入指示（不抢它的位置）", () => {
    useChatStore.setState({
      messages: [],
      typingIndicator: { active: true, estimatedRemainingMs: 3000 },
    });
    const { container } = renderView();
    expect(container.querySelector(".wechat-chat-session__empty")).toBeNull();
  });
});
