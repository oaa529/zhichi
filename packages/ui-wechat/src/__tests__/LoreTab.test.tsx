/**
 * @file LoreTab.test.tsx
 * 「设定」Tab：世界书条目的渲染、启用开关、增删改与搜索。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ICharacterProfile, ILoreEntry } from "@wechat-rp/shared-types";
import { useSessionStore } from "../store/sessionStore";
import { LoreTab } from "../components/LoreTab";

const NOW = 1_700_000_000_000;
const CHAR = "char-1";
const SESSION = "s1";

const profile: ICharacterProfile = {
  id: CHAR,
  displayName: "林见夏",
  bio: "唱片店老板",
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

function makeEntry(overrides: Partial<ILoreEntry> = {}): ILoreEntry {
  return {
    id: "lore-1",
    keys: ["唱片"],
    secondaryKeys: [],
    content: "店里收藏了三千张黑胶。",
    enabled: true,
    order: 0,
    caseSensitive: false,
    constant: false,
    selective: false,
    ...overrides,
  };
}

function seedSession(): void {
  useSessionStore.setState({
    characters: { [CHAR]: profile },
    sessions: {
      [SESSION]: {
        id: SESSION,
        type: "single",
        participantIds: [CHAR, "user"],
        displayName: "林见夏",
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
    loreEntries: {},
  });
}

beforeEach(() => {
  seedSession();
});

afterEach(() => {
  cleanup();
});

describe("LoreTab", () => {
  it("没有选中会话时给出提示", () => {
    useSessionStore.setState({ activeSessionId: null });
    render(<LoreTab />);
    expect(screen.getByText("请先选择一个会话")).toBeTruthy();
  });

  it("没有条目时显示空状态，并说明「聊到关键词才注入」", () => {
    render(<LoreTab />);
    expect(screen.getByText(/还没有世界设定/)).toBeTruthy();
    expect(screen.getByText("新增设定")).toBeTruthy();
  });

  it("渲染条目的关键词、内容与类型标签", () => {
    useSessionStore.setState({
      loreEntries: {
        [CHAR]: [
          makeEntry(),
          makeEntry({
            id: "lore-2",
            keys: [],
            constant: true,
            content: "故事发生在海边小镇。",
          }),
        ],
      },
    });
    render(<LoreTab />);

    expect(screen.getByText("店里收藏了三千张黑胶。")).toBeTruthy();
    expect(screen.getByText("唱片")).toBeTruthy();
    expect(screen.getByText("关键词")).toBeTruthy();
    expect(screen.getByText("常驻")).toBeTruthy();
    expect(screen.getByText(/共 2 条设定/)).toBeTruthy();
  });

  it("切换开关会停用/启用条目", () => {
    useSessionStore.setState({ loreEntries: { [CHAR]: [makeEntry()] } });
    render(<LoreTab />);

    fireEvent.click(screen.getByLabelText("停用"));

    expect(useSessionStore.getState().loreEntries[CHAR]![0]!.enabled).toBe(false);
    // 停用后按钮语义翻转
    expect(screen.getByLabelText("启用")).toBeTruthy();
  });

  it("删除会把条目从 store 里去掉", () => {
    useSessionStore.setState({ loreEntries: { [CHAR]: [makeEntry()] } });
    render(<LoreTab />);

    fireEvent.click(screen.getByLabelText("删除"));

    expect(useSessionStore.getState().loreEntries[CHAR]).toBeUndefined();
  });

  it("搜索按内容与关键词过滤", () => {
    useSessionStore.setState({
      loreEntries: {
        [CHAR]: [
          makeEntry(),
          makeEntry({ id: "lore-2", keys: ["台风"], content: "小镇每年夏天都有台风。" }),
        ],
      },
    });
    render(<LoreTab />);

    fireEvent.change(screen.getByPlaceholderText("搜索设定…"), {
      target: { value: "台风" },
    });

    expect(screen.getByText("小镇每年夏天都有台风。")).toBeTruthy();
    expect(screen.queryByText("店里收藏了三千张黑胶。")).toBeNull();
  });

  it("新增条目：关键词与内容落库，order 递增", () => {
    useSessionStore.setState({
      loreEntries: { [CHAR]: [makeEntry({ order: 3 })] },
    });
    render(<LoreTab />);

    fireEvent.click(screen.getByText("新增设定"));
    fireEvent.change(screen.getByPlaceholderText("如：唱片，黑胶"), {
      target: { value: "黑胶，唱机" },
    });
    fireEvent.change(screen.getByPlaceholderText(/三千张黑胶/), {
      target: { value: "唱机是 1972 年的。\n\n" },
    });
    fireEvent.click(screen.getByText("保存"));

    const list = useSessionStore.getState().loreEntries[CHAR]!;
    expect(list).toHaveLength(2);
    const added = list[1]!;
    expect(added.keys).toEqual(["黑胶", "唱机"]);
    expect(added.content).toBe("唱机是 1972 年的。");
    // 排在已有条目之后
    expect(added.order).toBe(4);
    expect(added.enabled).toBe(true);
  });

  it("勾选「常驻」后保存：关键词输入被禁用且条目按常驻落库", () => {
    render(<LoreTab />);

    fireEvent.click(screen.getByText("新增设定"));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByPlaceholderText(/三千张黑胶/), {
      target: { value: "世界观底线设定" },
    });
    fireEvent.click(screen.getByText("保存"));

    const added = useSessionStore.getState().loreEntries[CHAR]![0]!;
    expect(added.constant).toBe(true);
    expect(added.keys).toEqual([]);
  });

  it("编辑已有条目会更新内容", () => {
    useSessionStore.setState({ loreEntries: { [CHAR]: [makeEntry()] } });
    render(<LoreTab />);

    fireEvent.click(screen.getByLabelText("编辑"));
    fireEvent.change(screen.getByPlaceholderText(/三千张黑胶/), {
      target: { value: "改过的设定内容" },
    });
    fireEvent.click(screen.getByText("保存"));

    expect(useSessionStore.getState().loreEntries[CHAR]![0]!.content).toBe(
      "改过的设定内容",
    );
  });
});
