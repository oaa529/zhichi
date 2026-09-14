/**
 * @file MemoryTab.test.tsx
 * 记忆面板的渲染与交互（此前只有浏览器手测，没有回归保护）。
 *
 * 直接读写真实的 sessionStore：面板是纯受控组件，状态全在 store 里，
 * 所以这样测出来的就是用户实际看到的因果链。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ICharacterProfile, IMemory } from "@wechat-rp/shared-types";
import { useSessionStore } from "../store/sessionStore";
import { MemoryTab } from "../components/MemoryTab";

const NOW = 1_700_000_000_000;
const CHAR = "char-1";
const SESSION = "s1";

const profile: ICharacterProfile = {
  id: CHAR,
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

function makeMemory(overrides: Partial<IMemory> = {}): IMemory {
  return {
    id: "mem-1",
    characterId: CHAR,
    kind: "preference",
    content: "用户喜欢喝咖啡",
    keywords: ["咖啡"],
    importance: 4,
    pinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    sourceMessageIds: [],
    ...overrides,
  };
}

/** 准备"已选中一个会话"的最小状态。 */
function seedSession(): void {
  useSessionStore.setState({
    characters: { [CHAR]: profile },
    sessions: {
      [SESSION]: {
        id: SESSION,
        type: "single",
        participantIds: [CHAR, "user"],
        displayName: "苏晚晴",
        avatarUrl: "",
        lastMessagePreview: "",
        lastMessageTime: NOW,
        unreadCount: 0,
        isPinned: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    activeSessionId: SESSION,
    memories: {},
    digestFailures: {},
    digestReports: {},
  });
}

beforeEach(() => {
  seedSession();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MemoryTab", () => {
  it("没有选中会话时给出提示，而不是空面板", () => {
    useSessionStore.setState({ activeSessionId: null });
    render(<MemoryTab />);
    expect(screen.getByText("请先选择一个会话")).toBeTruthy();
  });

  it("没有记忆时显示空状态，并提示可以立即整理", () => {
    render(<MemoryTab onRunDigest={() => {}} />);
    expect(screen.getByText(/还没有记忆/)).toBeTruthy();
    expect(screen.getByText("立即整理")).toBeTruthy();
  });

  it("渲染记忆内容、类别标签与重要度", () => {
    useSessionStore.setState({ memories: { [CHAR]: [makeMemory()] } });
    render(<MemoryTab />);

    expect(screen.getByText("用户喜欢喝咖啡")).toBeTruthy();
    expect(screen.getByText("偏好")).toBeTruthy();
    expect(screen.getByText("★★★★")).toBeTruthy();
    expect(screen.getByText("咖啡")).toBeTruthy();
  });

  it("显示「取代了」记录（让用户看得见自动整理改了什么）", () => {
    useSessionStore.setState({
      memories: {
        [CHAR]: [
          makeMemory({
            id: "mem-tea",
            content: "用户戒了咖啡，改喝茶",
            supersedesContent: "用户喜欢喝咖啡",
            supersededAt: NOW,
          }),
        ],
      },
    });
    render(<MemoryTab />);
    expect(screen.getByText("取代了：用户喜欢喝咖啡")).toBeTruthy();
  });

  it("手动维护的记忆带「手动」标记（用户知道自己写的不会被自动改写）", () => {
    useSessionStore.setState({
      memories: {
        [CHAR]: [makeMemory({ id: "mem-manual", origin: "manual" })],
      },
    });
    render(<MemoryTab />);

    expect(screen.getByText("手动")).toBeTruthy();
    expect(screen.getByText(/后台整理不会改写或删除它/)).toBeTruthy();
  });

  it("与手动/置顶记忆冲突时给出提示（两份说法摆出来让用户定）", () => {
    useSessionStore.setState({
      memories: {
        [CHAR]: [
          makeMemory({
            id: "mem-auto",
            content: "用户现在对花生不过敏了",
            conflictsWith: "用户对花生过敏",
          }),
        ],
      },
    });
    render(<MemoryTab />);

    expect(
      screen.getByText("与你的手动/置顶记忆冲突：用户对花生过敏"),
    ).toBeTruthy();
  });

  it("手动新增记忆时标记来源为 manual（此后自动整理不会改写它）", () => {
    useSessionStore.setState({ memories: { [CHAR]: [] } });
    render(<MemoryTab />);

    fireEvent.click(screen.getByRole("button", { name: /新增记忆/ }));
    fireEvent.change(screen.getByLabelText("内容"), {
      target: { value: "用户不吃香菜" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const saved = useSessionStore.getState().memories[CHAR] ?? [];
    expect(saved).toHaveLength(1);
    expect(saved[0]!.content).toBe("用户不吃香菜");
    expect(saved[0]!.origin).toBe("manual");
  });

  it("改过自动记忆之后也归为手动（我改过的，别再自动改回去）", () => {
    useSessionStore.setState({
      memories: {
        [CHAR]: [
          makeMemory({ id: "mem-auto", content: "用户在准备考研", origin: "auto" }),
        ],
      },
    });
    render(<MemoryTab />);

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("内容"), {
      target: { value: "用户在准备考研，目标是本校" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const saved = useSessionStore.getState().memories[CHAR] ?? [];
    expect(saved).toHaveLength(1);
    expect(saved[0]!.content).toBe("用户在准备考研，目标是本校");
    expect(saved[0]!.origin).toBe("manual");
  });

  it("显示整理失败原因与重试说明", () => {
    useSessionStore.setState({
      digestFailures: { [SESSION]: { at: NOW, reason: "adapter-error" } },
    });
    render(<MemoryTab pendingDigestCount={5} />);

    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("调用模型时出错");
    expect(notice.textContent).toContain("有新消息时会自动重试");
    expect(screen.getByText(/待整理 5 条/)).toBeTruthy();
  });

  it("显示上次整理的变更摘要（新增/取代/事件/覆盖条数）", () => {
    useSessionStore.setState({
      digestReports: {
        [SESSION]: {
          at: NOW,
          messageCount: 60,
          added: 3,
          replaced: 1,
          conflicts: 0,
          events: 2,
        },
      },
    });
    render(<MemoryTab />);

    const report = screen.getByRole("status");
    expect(report.textContent).toContain("覆盖 60 条消息");
    expect(report.textContent).toContain("新增 3 条");
    expect(report.textContent).toContain("取代 1 条");
    expect(report.textContent).toContain("新增事件 2 个");
  });

  it("摘要里有冲突时转成警示样式（提示用户去定夺）", () => {
    useSessionStore.setState({
      digestReports: {
        [SESSION]: {
          at: NOW,
          messageCount: 20,
          added: 1,
          replaced: 0,
          conflicts: 1,
          events: 0,
        },
      },
    });
    render(<MemoryTab />);

    const report = screen.getByRole("status");
    expect(report.textContent).toContain("1 条与你的手动/置顶记忆冲突");
    expect(report.className).toContain("zhichi-memory-tab__report--conflict");
  });

  it("没有整理记录时不显示摘要（不占地方）", () => {
    render(<MemoryTab />);
    expect(document.querySelector(".zhichi-memory-tab__report")).toBeNull();
  });

  describe("检索预览", () => {
    it("输入一句话，列出会被注入的记忆并说明命中了什么", () => {
      useSessionStore.setState({
        memories: {
          [CHAR]: [
            makeMemory({
              id: "mem-cat",
              content: "用户养了一只叫团团的猫",
              keywords: ["团团", "猫"],
            }),
            makeMemory({
              id: "mem-work",
              content: "用户在设计院工作",
              keywords: ["工作", "设计院"],
            }),
          ],
        },
      });
      render(<MemoryTab />);

      // 默认收起
      expect(
        document.querySelector(".zhichi-memory-tab__retrieval"),
      ).toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: /试试这句话会带出哪几条记忆/ }),
      );
      fireEvent.change(screen.getByLabelText("检索预览输入"), {
        target: { value: "团团最近怎么样" },
      });

      const list = document.querySelector(".zhichi-memory-tab__retrieval-list")!;
      expect(list.textContent).toContain("用户养了一只叫团团的猫");
      expect(list.textContent).toContain("命中：团团");
      // 跟这句话无关的那条不该出现
      expect(list.textContent).not.toContain("设计院");
    });

    it("无关的一句话会说清「不会带出任何记忆」", () => {
      useSessionStore.setState({
        memories: {
          [CHAR]: [
            makeMemory({ content: "用户养了一只猫", keywords: ["猫"] }),
          ],
        },
      });
      render(<MemoryTab />);

      fireEvent.click(
        screen.getByRole("button", { name: /试试这句话会带出哪几条记忆/ }),
      );
      fireEvent.change(screen.getByLabelText("检索预览输入"), {
        target: { value: "今天天气不错" },
      });

      expect(
        document.querySelector(".zhichi-memory-tab__retrieval-empty")
          ?.textContent,
      ).toContain("不会带出任何记忆");
    });
  });

  it("搜索按内容与关键词过滤", () => {
    useSessionStore.setState({
      memories: {
        [CHAR]: [
          makeMemory({ id: "m1", content: "用户喜欢喝咖啡", keywords: ["咖啡"] }),
          makeMemory({ id: "m2", content: "用户养了一只猫", keywords: ["猫"] }),
        ],
      },
    });
    render(<MemoryTab />);
    expect(screen.getByText("用户喜欢喝咖啡")).toBeTruthy();
    expect(screen.getByText("用户养了一只猫")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("搜索记忆…"), {
      target: { value: "猫" },
    });
    expect(screen.queryByText("用户喜欢喝咖啡")).toBeNull();
    expect(screen.getByText("用户养了一只猫")).toBeTruthy();
  });

  it("点删除会把这条记忆从 store 里去掉", () => {
    useSessionStore.setState({ memories: { [CHAR]: [makeMemory()] } });
    render(<MemoryTab />);

    fireEvent.click(screen.getByLabelText("删除"));

    expect(useSessionStore.getState().memories[CHAR]).toEqual([]);
  });

  it("点置顶会翻转 pinned（按钮语义随之变化）", () => {
    useSessionStore.setState({ memories: { [CHAR]: [makeMemory()] } });
    render(<MemoryTab />);

    fireEvent.click(screen.getByLabelText("置顶"));

    expect(useSessionStore.getState().memories[CHAR]?.[0]?.pinned).toBe(true);
    expect(screen.getByLabelText("取消置顶")).toBeTruthy();
  });

  it("点「立即整理」会调用注入的回调", () => {
    const onRunDigest = vi.fn();
    render(<MemoryTab onRunDigest={onRunDigest} />);

    fireEvent.click(screen.getByText("立即整理"));

    expect(onRunDigest).toHaveBeenCalledTimes(1);
  });
});
