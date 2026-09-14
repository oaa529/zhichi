/**
 * @file SessionList.test.tsx
 * 会话列表：排序、长按进入多选、批量标为已读 / 批量删除。
 *
 * 长按用假定时器推进 500ms 触发；点击项、勾选、批量操作都直接断言真实
 * sessionStore 的结果。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { ICharacterProfile, ISession } from "@wechat-rp/shared-types";
import { useChatStore } from "../store/chatStore";
import { useSessionStore } from "../store/sessionStore";
import { SessionList } from "../components/SessionList";

const NOW = 1_700_000_000_000;

/**
 * 宿主时区。
 *
 * 列表状态标签由"角色作息 + 当前时刻"推导，而用例用**本地时间**
 * 造假时刻（`new Date(2026, 8, 13, 10, 0, 0)`）。档案里必须写宿主时区，
 * 写死 "Asia/Shanghai" 的话在 UTC 的 CI 上"本地 10 点"是上海 18 点，
 * 忙碌标签就不会出现（GitHub Actions 实测红过）。
 */
const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function makeSession(overrides: Partial<ISession> = {}): ISession {
  return {
    id: "s1",
    type: "single",
    participantIds: ["char-1", "user"],
    displayName: "苏晚晴",
    avatarUrl: "",
    lastMessagePreview: "在吗",
    lastMessageTime: NOW,
    unreadCount: 0,
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** 两个会话：s1 有新消息未读，s2 置顶。 */
function seedSessions(): void {
  useSessionStore.setState({
    sessions: {
      s1: makeSession({ id: "s1", displayName: "苏晚晴", unreadCount: 2 }),
      s2: makeSession({
        id: "s2",
        displayName: "林笑笑",
        isPinned: true,
        updatedAt: NOW - 60_000,
      }),
    },
    activeSessionId: "s1",
  });
}

/** 取会话项按钮（会话名所在的按钮）。 */
function itemButton(displayName: string): HTMLButtonElement {
  const node = screen.getByText(displayName);
  const button = node.closest("button");
  if (!button) throw new Error(`找不到「${displayName}」的会话项按钮`);
  return button as HTMLButtonElement;
}

/** 长按某个会话项，触发进入多选。 */
function longPress(displayName: string): void {
  fireEvent.pointerDown(itemButton(displayName));
  act(() => {
    vi.advanceTimersByTime(600);
  });
  fireEvent.pointerUp(itemButton(displayName));
}

beforeEach(() => {
  vi.useFakeTimers();
  seedSessions();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SessionList", () => {
  it("置顶会话排在最前面", () => {
    render(<SessionList />);
    const names = screen
      .getAllByText(/苏晚晴|林笑笑/)
      .map((node) => node.textContent);
    expect(names).toHaveLength(2);
    // 置顶项名字前带 📌 图标
    expect(names[0]).toContain("林笑笑");
    expect(names[1]).toBe("苏晚晴");
  });

  it("点击会话切换当前会话", () => {
    render(<SessionList />);
    fireEvent.click(itemButton("林笑笑"));
    expect(useSessionStore.getState().activeSessionId).toBe("s2");
  });

  it("对方正在输入时，预览那行换成「对方正在输入…」", () => {
    useSessionStore.getState().setSessionTyping("s1", true);
    render(<SessionList />);

    // s1 的预览被替换，s2 保持原样
    expect(screen.getByText("对方正在输入…")).toBeTruthy();
    expect(screen.getByText("在吗")).toBeTruthy();
    // 输入结束后回到正常预览
    act(() => {
      useSessionStore.getState().setSessionTyping("s1", false);
    });
    expect(screen.queryByText("对方正在输入…")).toBeNull();
  });

  it("角色在忙/在睡时，名字后面显示状态；在线的不显示", () => {
    // 固定本地时间 10:00，让"忙碌时段"可复现
    vi.setSystemTime(new Date(2026, 8, 13, 10, 0, 0));
    // 作息感知总开关得开着，否则忙碌/就寝都不判定
    useChatStore.setState({
      simulationConfig: {
        ...useChatStore.getState().simulationConfig,
        scheduleAwarenessEnabled: true,
      },
    });
    const character = (
      id: string,
      name: string,
      busy: boolean,
    ): ICharacterProfile => ({
      id,
      displayName: name,
      bio: "",
      visualMetadata: {
        avatarUrl: "",
        sprites: [],
        supportsPinSprite: false,
        defaultSpriteAnchor: "left",
      },
      schedule: {
        wakeTime: "07:30",
        sleepTime: "23:30",
        scheduleEnabled: true,
        timezone: HOST_ZONE,
        sleepReplyPolicy: "drowsy-burst",
        ...(busy
          ? { busyPeriods: [{ start: "09:00", end: "12:00", label: "在上课" }] }
          : {}),
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
    });
    useSessionStore.setState({
      characters: {
        "char-1": character("char-1", "苏晚晴", true),
        "char-2": character("char-2", "林笑笑", false),
      },
    });
    // s2 换成第二个角色（默认 seed 里两个会话都指向 char-1）
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        s2: { ...state.sessions["s2"]!, participantIds: ["char-2", "user"] },
      },
    }));

    render(<SessionList />);

    const labels = [...document.querySelectorAll(".zhichi-session-list__presence")];
    expect(labels).toHaveLength(1);
    expect(labels[0]!.textContent).toBe("在上课");
    expect(labels[0]!.getAttribute("data-presence")).toBe("away");
  });

  it("长按进入多选并选中该项，不会顺带切换会话", () => {
    render(<SessionList />);

    longPress("林笑笑");

    expect(screen.getByText("已选 1 项")).toBeTruthy();
    expect(screen.getByRole("button", { name: /标为已读/ })).toBeTruthy();
    expect(useSessionStore.getState().activeSessionId).toBe("s1");

    // 长按之后浏览器补的那次 click 要被吃掉
    fireEvent.click(itemButton("林笑笑"));
    expect(useSessionStore.getState().activeSessionId).toBe("s1");
  });

  it("多选模式下点击其它会话是勾选，而不是切换会话", () => {
    render(<SessionList />);
    longPress("林笑笑");

    fireEvent.click(itemButton("苏晚晴"));

    expect(screen.getByText("已选 2 项")).toBeTruthy();
    expect(useSessionStore.getState().activeSessionId).toBe("s1");
  });

  it("批量标为已读会清零未读并退出多选", () => {
    render(<SessionList />);
    longPress("苏晚晴");
    fireEvent.click(itemButton("林笑笑"));

    fireEvent.click(screen.getByRole("button", { name: /标为已读/ }));

    const sessions = useSessionStore.getState().sessions;
    expect(sessions.s1!.unreadCount).toBe(0);
    expect(sessions.s2!.unreadCount).toBe(0);
    expect(screen.queryByText(/已选/)).toBeNull();
  });

  it("批量删除先确认，确认后一次性删掉选中的会话", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SessionList />);
    longPress("苏晚晴");
    fireEvent.click(itemButton("林笑笑"));

    fireEvent.click(screen.getByRole("button", { name: /删除/ }));

    expect(useSessionStore.getState().sessions).toEqual({});
    // 删掉的会话里包含当前活跃会话 → 复位
    expect(useSessionStore.getState().activeSessionId).toBeNull();
    expect(screen.queryByText(/已选/)).toBeNull();
  });

  it("删除确认框点取消时什么都不删", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SessionList />);
    longPress("苏晚晴");

    fireEvent.click(screen.getByRole("button", { name: /删除/ }));

    expect(Object.keys(useSessionStore.getState().sessions)).toHaveLength(2);
    // 仍停留在多选模式，用户可以继续操作
    expect(screen.getByText("已选 1 项")).toBeTruthy();
  });

  it("点「取消」退出多选，会话项恢复为切换会话", () => {
    render(<SessionList />);
    longPress("苏晚晴");

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByText(/已选/)).toBeNull();
    fireEvent.click(itemButton("林笑笑"));
    expect(useSessionStore.getState().activeSessionId).toBe("s2");
  });
});
