/**
 * @file MessageSearchPanel.test.tsx
 * 搜索面板的渲染与交互（此前只有 util 有测试，面板是覆盖盲区）。
 *
 * 重点是这次改的东西：多词查询的高亮**每一处都要标出来**，
 * 而不是只标第一处。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { IMessage, ISession } from "@wechat-rp/shared-types";
import { useSessionStore } from "../store/sessionStore";
import { MessageSearchPanel } from "../components/MessageSearchPanel";

const NOW = 1_700_000_000_000;
const SESSION = "s1";

function session(id: string, name: string): ISession {
  return {
    id,
    type: "single",
    participantIds: ["char-1", "user"],
    displayName: name,
    avatarUrl: "",
    lastMessagePreview: "",
    lastMessageTime: NOW,
    unreadCount: 0,
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function textMessage(id: string, text: string, timestamp: number): IMessage {
  return {
    id,
    type: "text",
    senderId: "user",
    recipientId: "char-1",
    sessionId: SESSION,
    text,
    timestamp,
    chunkSequence: 0,
    emotion: "neutral",
    sourceOffset: 0,
  };
}

function seed(messages: ReadonlyArray<IMessage>): void {
  useSessionStore.setState({
    sessions: { [SESSION]: session(SESSION, "苏晚晴") },
    sessionRuntimes: {
      [SESSION]: {
        messages: messages.map((message) => ({
          message,
          revealed: true,
          pending: false,
        })),
        presence: "online",
        presenceText: "在线",
        phase: "completed",
        typingIndicator: { active: false, estimatedRemainingMs: 0 },
        pendingCount: 0,
        simulationConfig: {
          realismEnabled: true,
          typingSpeedCpm: "normal",
          hesitationProbability: 0,
          typoRate: 0,
          fragmentationThresholdChars: 24,
          scheduleAwarenessEnabled: false,
          typingIndicatorEnabled: true,
          typoAutoCorrectEnabled: true,
          maxInterChunkDelayMs: 1000,
        },
      },
    },
  });
}

beforeEach(() => {
  seed([textMessage("m1", "团团明天要去医院复查", NOW)]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MessageSearchPanel", () => {
  it("没输入关键词时不显示结果区", () => {
    render(<MessageSearchPanel query="" onQueryChange={() => {}} />);
    expect(document.querySelector(".zhichi-message-search__results")).toBeNull();
  });

  it("多词查询：命中消息高亮每一处", () => {
    render(<MessageSearchPanel query="团团 医院" onQueryChange={() => {}} />);

    const marks = [...document.querySelectorAll(".zhichi-message-search__mark")];
    expect(marks.map((mark) => mark.textContent)).toEqual(["团团", "医院"]);
    // 会话名与时间也一并显示，方便判断是哪条会话里的
    expect(screen.getByText("苏晚晴")).toBeTruthy();
  });

  it("没命中时给出可读的空状态（而不是空白）", () => {
    render(<MessageSearchPanel query="不存在的词" onQueryChange={() => {}} />);
    expect(screen.getByText(/没有找到包含/)).toBeTruthy();
  });

  it("点结果把会话 ID 与消息 ID 交给上层去跳转", () => {
    const onJump = vi.fn();
    render(
      <MessageSearchPanel
        query="医院"
        onQueryChange={() => {}}
        onJumpToMessage={onJump}
      />,
    );

    fireEvent.click(screen.getByRole("listitem"));

    expect(onJump).toHaveBeenCalledWith(SESSION, "m1");
  });
});
