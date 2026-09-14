/**
 * @file MessageBubble.test.tsx
 * 消息气泡的操作菜单（长按 / 右键 → 复制 / 引用）与引用块渲染。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type {
  ICharacterProfile,
  IMessageQuote,
  ITextMessage,
} from "@wechat-rp/shared-types";
import type { IMessageRuntime } from "../store/chatStore";
import { MessageBubble } from "../components/MessageBubble";

const profile: ICharacterProfile = {
  id: "char-1",
  displayName: "苏晚晴",
  bio: "邻家姐姐",
  visualMetadata: {
    avatarUrl: "",
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

/** 构造一条文本消息的运行时包装。 */
function makeRuntime(
  overrides: Partial<ITextMessage> = {},
): IMessageRuntime {
  const message: ITextMessage = {
    id: "m1",
    type: "text",
    senderId: "char-1",
    recipientId: "user",
    sessionId: "s1",
    text: "你今天怎么没来上课？",
    timestamp: 1000,
    chunkSequence: 0,
    emotion: "neutral",
    sourceOffset: 0,
    ...overrides,
  };
  return { message, revealed: true, pending: false };
}

/** 触发长按（默认 500ms 判定）。 */
function longPress(element: Element): void {
  fireEvent.pointerDown(element);
  act(() => {
    vi.advanceTimersByTime(600);
  });
  fireEvent.pointerUp(element);
}

/** 打开操作菜单的通用入口（右键，避免每次都要推进假定时器）。 */
function openMenu(container: HTMLElement): void {
  const article = container.querySelector(".wechat-msg");
  if (!article) throw new Error("找不到消息节点");
  fireEvent.contextMenu(article);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MessageBubble · 操作菜单", () => {
  it("长按弹出菜单，含「复制」与「引用」", () => {
    vi.useFakeTimers();
    render(<MessageBubble runtime={makeRuntime()} avatarUrl="" onQuote={() => {}} />);

    expect(screen.queryByRole("menu")).toBeNull();
    longPress(screen.getByText("你今天怎么没来上课？"));

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "复制" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "引用" })).toBeTruthy();
  });

  it("右键同样弹出菜单", () => {
    const { container } = render(
      <MessageBubble runtime={makeRuntime()} avatarUrl="" onQuote={() => {}} />,
    );
    openMenu(container);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("没有 onQuote 时只提供复制", () => {
    const { container } = render(
      <MessageBubble runtime={makeRuntime()} avatarUrl="" />,
    );
    openMenu(container);

    expect(screen.getByRole("menuitem", { name: "复制" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "引用" })).toBeNull();
  });

  it("接了删除能力时菜单里有「删除」，点了回调拿消息 ID", () => {
    const onDelete = vi.fn();
    const { container } = render(
      <MessageBubble
        runtime={makeRuntime({ id: "m-del" })}
        avatarUrl=""
        onDelete={onDelete}
      />,
    );
    openMenu(container);

    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));

    expect(onDelete).toHaveBeenCalledWith("m-del");
    // 菜单随之收起
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("没接删除能力时菜单里没有「删除」", () => {
    const { container } = render(
      <MessageBubble runtime={makeRuntime()} avatarUrl="" />,
    );
    openMenu(container);
    expect(screen.queryByRole("menuitem", { name: "删除" })).toBeNull();
  });

  it("系统消息不弹菜单（没有可复制/可引用的文本）", () => {
    const runtime: IMessageRuntime = {
      message: {
        id: "sys-1",
        type: "system",
        senderId: "system",
        recipientId: "user",
        sessionId: "s1",
        timestamp: 1000,
        chunkSequence: 0,
        emotion: "neutral",
        systemKind: "time-divider",
        displayText: "昨天 20:00",
      },
      revealed: true,
      pending: false,
    };
    const { container } = render(
      <MessageBubble runtime={runtime} avatarUrl="" onQuote={() => {}} />,
    );
    openMenu(container);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("MessageBubble · 引用回复", () => {
  it("点「引用」把被引用消息的摘要交给父级（带角色名）", () => {
    const onQuote = vi.fn();
    const { container } = render(
      <MessageBubble
        runtime={makeRuntime()}
        avatarUrl=""
        characterProfile={profile}
        onQuote={onQuote}
      />,
    );
    openMenu(container);

    fireEvent.click(screen.getByRole("menuitem", { name: "引用" }));

    const expected: IMessageQuote = {
      messageId: "m1",
      senderName: "苏晚晴",
      preview: "你今天怎么没来上课？",
    };
    expect(onQuote).toHaveBeenCalledWith(expected);
    // 引用后菜单收起
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("引用自己发的消息时署名是「我」", () => {
    const onQuote = vi.fn();
    const { container } = render(
      <MessageBubble
        runtime={makeRuntime({ id: "m9", senderId: "user", text: "那明天见" })}
        avatarUrl=""
        isSelf
        onQuote={onQuote}
      />,
    );
    openMenu(container);
    fireEvent.click(screen.getByRole("menuitem", { name: "引用" }));

    expect(onQuote).toHaveBeenCalledWith({
      messageId: "m9",
      senderName: "我",
      preview: "那明天见",
    });
  });

  it("长文本的引用摘要会被截断（不把整段话塞进引用条）", () => {
    const onQuote = vi.fn();
    const long = "很长的内容".repeat(40);
    const { container } = render(
      <MessageBubble
        runtime={makeRuntime({ text: long })}
        avatarUrl=""
        characterProfile={profile}
        onQuote={onQuote}
      />,
    );
    openMenu(container);
    fireEvent.click(screen.getByRole("menuitem", { name: "引用" }));

    const quote = onQuote.mock.calls[0]![0] as IMessageQuote;
    expect(quote.preview.length).toBeLessThanOrEqual(80);
    expect(quote.preview.endsWith("…")).toBe(true);
  });

  it("带引用的消息把引用块渲染在气泡里（发送者 + 摘要）", () => {
    const quote: IMessageQuote = {
      messageId: "m0",
      senderName: "苏晚晴",
      preview: "周末有安排吗",
    };
    render(<MessageBubble runtime={makeRuntime({ quote })} avatarUrl="" />);

    expect(screen.getByText("苏晚晴")).toBeTruthy();
    expect(screen.getByText("周末有安排吗")).toBeTruthy();
  });

  it("点引用块跳到被引用的那条消息", () => {
    const onJumpToQuote = vi.fn();
    const quote: IMessageQuote = {
      messageId: "m0",
      senderName: "苏晚晴",
      preview: "周末有安排吗",
    };
    render(
      <MessageBubble
        runtime={makeRuntime({ quote })}
        avatarUrl=""
        onJumpToQuote={onJumpToQuote}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /跳到被引用的消息/ }));

    expect(onJumpToQuote).toHaveBeenCalledWith("m0");
  });

  it("没接跳转回调时引用块是死的（不是可点按钮）", () => {
    const quote: IMessageQuote = {
      messageId: "m0",
      senderName: "苏晚晴",
      preview: "周末有安排吗",
    };
    render(<MessageBubble runtime={makeRuntime({ quote })} avatarUrl="" />);

    expect(screen.queryByRole("button", { name: /跳到被引用的消息/ })).toBeNull();
    // 但内容照常显示
    expect(screen.getByText("周末有安排吗")).toBeTruthy();
  });
});

describe("MessageBubble · 撤回", () => {
  it("自己发的、两分钟内的消息菜单里有「撤回」，点了回调拿消息 ID", () => {
    const onRecall = vi.fn();
    const { container } = render(
      <MessageBubble
        runtime={makeRuntime({
          id: "m-recall",
          senderId: "user",
          text: "刚那句说重了",
          timestamp: Date.now(),
        })}
        avatarUrl=""
        isSelf
        onRecall={onRecall}
      />,
    );
    openMenu(container);

    fireEvent.click(screen.getByRole("menuitem", { name: "撤回" }));

    expect(onRecall).toHaveBeenCalledWith("m-recall");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("超过两分钟的消息没有「撤回」入口（右键菜单仍可用）", () => {
    const { container } = render(
      <MessageBubble
        runtime={makeRuntime({
          senderId: "user",
          timestamp: Date.now() - 3 * 60 * 1000,
        })}
        avatarUrl=""
        isSelf
        onRecall={() => {}}
      />,
    );
    openMenu(container);

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "撤回" })).toBeNull();
  });

  it("对方发的消息不出现「撤回」", () => {
    const { container } = render(
      <MessageBubble
        runtime={makeRuntime({ timestamp: Date.now() })}
        avatarUrl=""
        onRecall={() => {}}
      />,
    );
    openMenu(container);

    expect(screen.queryByRole("menuitem", { name: "撤回" })).toBeNull();
  });

  it("没接撤回能力时菜单里没有「撤回」", () => {
    const { container } = render(
      <MessageBubble
        runtime={makeRuntime({ senderId: "user", timestamp: Date.now() })}
        avatarUrl=""
        isSelf
      />,
    );
    openMenu(container);

    expect(screen.queryByRole("menuitem", { name: "撤回" })).toBeNull();
  });
});

describe("MessageBubble · 复制", () => {
  it("点「复制」把消息原文写进剪贴板并提示", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    Object.defineProperty(window, "isSecureContext", {
      value: true,
      configurable: true,
    });

    const { container } = render(
      <MessageBubble runtime={makeRuntime()} avatarUrl="" />,
    );
    openMenu(container);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "复制" }));
    });

    expect(writeText).toHaveBeenCalledWith("你今天怎么没来上课？");
    expect(screen.getByRole("status").textContent).toBe("已复制");
  });
});
