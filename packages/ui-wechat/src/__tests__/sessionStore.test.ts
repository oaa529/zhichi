/**
 * @file sessionStore.test.ts
 * sessionStore 记忆 / 剧情 / 整理游标的状态机测试。
 *
 * 通过 mock IndexedDB 存储层，测试同步且确定。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockStore } = vi.hoisted(() => ({
  mockStore: new Map<string, string>(),
}));

vi.mock("@wechat-rp/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wechat-rp/core")>();
  return {
    ...actual,
    getItem: vi.fn(async <T>(name: string): Promise<T | null> => {
      const val = mockStore.get(name);
      return val ? (JSON.parse(val) as T) : null;
    }),
    setItem: vi.fn(async (name: string, value: unknown): Promise<void> => {
      mockStore.set(name, typeof value === "string" ? value : JSON.stringify(value));
    }),
    removeItem: vi.fn(async (name: string): Promise<void> => {
      mockStore.delete(name);
    }),
    clearAll: vi.fn(async (): Promise<void> => {
      mockStore.clear();
    }),
  };
});

import {
  SCHEMA_VERSION,
  createEmptyPlotState,
  migrateSnapshot,
} from "@wechat-rp/core";
import type { ICharacterProfile, IMemory, IPlotEvent } from "@wechat-rp/shared-types";
import { useSessionStore } from "../store/sessionStore";

const NOW = 1_700_000_000_000;

const profile: ICharacterProfile = {
  id: "char-1",
  displayName: "苏晚晴",
  bio: "温柔",
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
    characterId: "char-1",
    kind: "fact",
    content: "用户喜欢猫",
    keywords: ["猫"],
    importance: 3,
    pinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    sourceMessageIds: [],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<IPlotEvent> = {}): IPlotEvent {
  return {
    id: "evt-1",
    summary: "两人见面",
    at: NOW,
    importance: 3,
    sourceMessageIds: [],
    manual: true,
    ...overrides,
  };
}

describe("sessionStore · 记忆与剧情", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: {},
      contacts: {},
      characters: {},
      sessionRuntimes: {},
      memories: {},
      loreEntries: {},
      plotStates: {},
      digestCursors: {},
      activeSessionId: null,
      digestConfig: {
        enabled: true,
        threshold: 20,
        maxWindow: 60,
        maxInject: 10,
        maxEvents: 100,
        maxHistory: 5,
      },
    });
  });

  it("新增 / 更新 / 置顶 / 删除记忆", () => {
    const store = useSessionStore.getState();
    store.addMemory("char-1", makeMemory());
    expect(useSessionStore.getState().memories["char-1"]).toHaveLength(1);

    useSessionStore.getState().updateMemory("char-1", "mem-1", {
      content: "用户非常喜欢猫",
    });
    expect(useSessionStore.getState().memories["char-1"]![0]!.content).toBe(
      "用户非常喜欢猫",
    );

    useSessionStore.getState().togglePinMemory("char-1", "mem-1");
    expect(useSessionStore.getState().memories["char-1"]![0]!.pinned).toBe(true);

    useSessionStore.getState().deleteMemory("char-1", "mem-1");
    expect(useSessionStore.getState().memories["char-1"]).toHaveLength(0);
  });

  it("同一角色重复 createSession 复用已有会话（不产生重复）", () => {
    useSessionStore.setState({ characters: { "char-1": profile } });

    const id1 = useSessionStore.getState().createSession("char-1");
    const id2 = useSessionStore.getState().createSession("char-1");

    expect(id2).toBe(id1);
    expect(Object.keys(useSessionStore.getState().sessions)).toHaveLength(1);
  });

  it("不同角色各自创建独立会话", () => {
    const profile2 = { ...profile, id: "char-2", displayName: "林笑笑" };
    useSessionStore.setState({
      characters: { "char-1": profile, "char-2": profile2 },
    });

    const id1 = useSessionStore.getState().createSession("char-1");
    const id2 = useSessionStore.getState().createSession("char-2");

    expect(id2).not.toBe(id1);
    expect(Object.keys(useSessionStore.getState().sessions)).toHaveLength(2);
  });

  it("复用会话时切换到该会话并清零未读", () => {
    useSessionStore.setState({ characters: { "char-1": profile } });
    const id1 = useSessionStore.getState().createSession("char-1");

    // 制造"有未读且不在该会话"的状态
    useSessionStore.setState((state) => ({
      activeSessionId: null,
      sessions: {
        ...state.sessions,
        [id1]: { ...state.sessions[id1]!, unreadCount: 3 },
      },
    }));

    const reused = useSessionStore.getState().createSession("char-1");
    const state = useSessionStore.getState();
    expect(reused).toBe(id1);
    expect(state.activeSessionId).toBe(id1);
    expect(state.sessions[id1]!.unreadCount).toBe(0);
  });

  it("applyMemories 批量替换（后台整理落库）", () => {
    useSessionStore.getState().applyMemories("char-1", [
      makeMemory({ id: "mem-a" }),
      makeMemory({ id: "mem-b", content: "用户住在杭州" }),
    ]);
    expect(useSessionStore.getState().memories["char-1"]).toHaveLength(2);
  });

  it("forgetMemoriesAbout 抹掉来自某句话的记忆，其余不动", () => {
    useSessionStore.getState().applyMemories("char-1", [
      makeMemory({
        id: "mem-a",
        content: "用户下周三要去拔智齿",
        sourceMessageIds: ["msg-1", "msg-2"],
      }),
      makeMemory({ id: "mem-b", content: "用户养了一只叫团团的猫" }),
    ]);

    const removed = useSessionStore
      .getState()
      .forgetMemoriesAbout("char-1", ["我下周三要去拔智齿"], ["msg-1"]);

    expect(removed).toBe(1);
    const left = useSessionStore.getState().memories["char-1"]!;
    expect(left.map((memory) => memory.id)).toEqual(["mem-b"]);
  });

  it("被删消息的 id 会从保留条目的来源里摘掉", () => {
    useSessionStore.getState().applyMemories("char-1", [
      makeMemory({
        id: "mem-a",
        content: "用户养了一只叫团团的猫",
        sourceMessageIds: ["msg-1", "msg-2"],
      }),
    ]);

    const removed = useSessionStore
      .getState()
      .forgetMemoriesAbout("char-1", ["今天天气不错"], ["msg-1"]);

    expect(removed).toBe(0);
    expect(
      useSessionStore.getState().memories["char-1"]![0]!.sourceMessageIds,
    ).toEqual(["msg-2"]);
  });

  it("没有文本 / 没有记忆时不折腾 store", () => {
    expect(
      useSessionStore.getState().forgetMemoriesAbout("char-1", ["  "]),
    ).toBe(0);
    expect(
      useSessionStore.getState().forgetMemoriesAbout("char-1", ["有内容"]),
    ).toBe(0);
  });

  it("forgetPlotEventsAbout 摘掉时间线里来自那句话的事件，状态卡不动", () => {
    useSessionStore.getState().setPlotState("s1", {
      ...createEmptyPlotState("s1", NOW),
      chapter: "第一章",
      events: [
        // 自动整理累积出来的事件（manual: false）
        makeEvent({
          id: "evt-1",
          summary: "用户说自己下周三要去拔智齿",
          manual: false,
        }),
        makeEvent({
          id: "evt-2",
          summary: "两人约好周六下午去看展",
          manual: false,
        }),
      ],
    });

    const removed = useSessionStore
      .getState()
      .forgetPlotEventsAbout("s1", ["我下周三要去拔智齿"]);

    expect(removed).toBe(1);
    const plot = useSessionStore.getState().plotStates["s1"]!;
    expect(plot.events.map((event) => event.id)).toEqual(["evt-2"]);
    // 状态卡（章节/概要）是用户自己写的整体描述，不参与自动遗忘
    expect(plot.chapter).toBe("第一章");
  });

  it("forgetPlotEventsAbout 不动**手写**的事件（相似匹配是启发式的，交给用户自己删）", () => {
    useSessionStore.getState().setPlotState("s1", {
      ...createEmptyPlotState("s1", NOW),
      events: [
        makeEvent({ id: "manual-1", summary: "用户说自己下周三要去拔智齿" }),
        makeEvent({
          id: "auto-1",
          summary: "用户说自己下周三要去拔智齿",
          manual: false,
        }),
      ],
    });

    const removed = useSessionStore
      .getState()
      .forgetPlotEventsAbout("s1", ["我下周三要去拔智齿"]);

    expect(removed).toBe(1);
    const plot = useSessionStore.getState().plotStates["s1"]!;
    expect(plot.events.map((event) => event.id)).toEqual(["manual-1"]);
  });

  it("手动编辑状态卡会压入快照并支持回滚", () => {
    useSessionStore.getState().setPlotState("s1", {
      ...createEmptyPlotState("s1", NOW),
      chapter: "第一章",
      synopsis: "初次见面",
    });

    useSessionStore.getState().updatePlotCard("s1", { chapter: "第二章" });
    const updated = useSessionStore.getState().plotStates["s1"]!;
    expect(updated.chapter).toBe("第二章");
    expect(updated.history).toHaveLength(1);
    expect(updated.history[0]!.chapter).toBe("第一章");

    useSessionStore.getState().rollbackPlot("s1");
    const rolled = useSessionStore.getState().plotStates["s1"]!;
    expect(rolled.chapter).toBe("第一章");
    expect(rolled.history).toHaveLength(0);
  });

  it("首次保存状态卡时自动创建（无既有状态卡）", () => {
    expect(useSessionStore.getState().plotStates["s1"]).toBeUndefined();

    useSessionStore.getState().updatePlotCard("s1", {
      chapter: "第一章 · 重逢",
      synopsis: "两人在街角咖啡馆重逢",
    });

    const created = useSessionStore.getState().plotStates["s1"]!;
    expect(created.chapter).toBe("第一章 · 重逢");
    expect(created.events).toEqual([]);
    // 空白卡首次保存不产生快照
    expect(created.history).toHaveLength(0);

    // 第二次编辑才产生快照
    useSessionStore.getState().updatePlotCard("s1", { chapter: "第二章" });
    expect(useSessionStore.getState().plotStates["s1"]!.history).toHaveLength(1);
  });

  it("时间线事件增删与清空", () => {
    useSessionStore.getState().setPlotState("s1", createEmptyPlotState("s1", NOW));
    useSessionStore.getState().addPlotEvent("s1", makeEvent());
    expect(useSessionStore.getState().plotStates["s1"]!.events).toHaveLength(1);

    useSessionStore.getState().deletePlotEvent("s1", "evt-1");
    expect(useSessionStore.getState().plotStates["s1"]!.events).toHaveLength(0);

    useSessionStore.getState().clearPlotState("s1");
    expect(useSessionStore.getState().plotStates["s1"]).toBeUndefined();
  });

  it("没有状态卡时手动加事件会自动建卡（此前会静默丢弃）", () => {
    expect(useSessionStore.getState().plotStates["s1"]).toBeUndefined();

    useSessionStore.getState().addPlotEvent("s1", makeEvent());

    const state = useSessionStore.getState().plotStates["s1"]!;
    expect(state.events).toHaveLength(1);
    expect(state.chapter).toBe("");
  });

  it("手动加事件同样遵循设置里的「事件时间线保留条数」", () => {
    useSessionStore.getState().setDigestConfig({ maxEvents: 10 });
    for (let i = 1; i <= 12; i += 1) {
      useSessionStore.getState().addPlotEvent(
        "s1",
        makeEvent({ id: `evt-${i}`, summary: `事件 ${i}` }),
      );
    }

    const events = useSessionStore.getState().plotStates["s1"]!.events;
    expect(events).toHaveLength(10);
    // 最老的被挤掉，最新的留下
    expect(events[0]!.summary).toBe("事件 3");
    expect(events[9]!.summary).toBe("事件 12");
  });

  it("整理游标与配置更新", () => {
    useSessionStore.getState().setDigestCursor("s1", 42);
    expect(useSessionStore.getState().digestCursors["s1"]).toBe(42);

    useSessionStore.getState().setDigestConfig({ threshold: 40 });
    expect(useSessionStore.getState().digestConfig.threshold).toBe(40);
    expect(useSessionStore.getState().digestConfig.enabled).toBe(true);
  });

  it("草稿按会话保存，空字符串等于清除", () => {
    useSessionStore.getState().setDraft("s1", "打了一半的话");
    expect(useSessionStore.getState().drafts["s1"]).toBe("打了一半的话");

    useSessionStore.getState().setDraft("s2", "另一个会话的草稿");
    expect(useSessionStore.getState().drafts["s1"]).toBe("打了一半的话");
    expect(useSessionStore.getState().drafts["s2"]).toBe("另一个会话的草稿");

    // 发送后清空草稿：键被移除而不是留空字符串
    useSessionStore.getState().setDraft("s1", "");
    expect("s1" in useSessionStore.getState().drafts).toBe(false);
    expect(useSessionStore.getState().drafts["s2"]).toBe("另一个会话的草稿");
  });

  it("删除会话时清理其草稿", () => {
    useSessionStore.setState({
      sessions: {
        s1: {
          id: "s1",
          type: "single",
          participantIds: ["char-1", "user"],
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
      activeSessionId: "s1",
    });
    useSessionStore.getState().setDraft("s1", "待清理草稿");

    useSessionStore.getState().deleteSession("s1");
    expect("s1" in useSessionStore.getState().drafts).toBe(false);
  });

  it("删除会话时清理剧情与整理游标", () => {
    useSessionStore.setState({
      sessions: {
        s1: {
          id: "s1",
          type: "single",
          participantIds: ["char-1", "user"],
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
      activeSessionId: "s1",
    });
    useSessionStore.getState().setPlotState("s1", createEmptyPlotState("s1", NOW));
    useSessionStore.getState().setDigestCursor("s1", 10);

    useSessionStore.getState().deleteSession("s1");
    const state = useSessionStore.getState();
    expect(state.plotStates["s1"]).toBeUndefined();
    expect(state.digestCursors["s1"]).toBeUndefined();
  });

  it("删除角色时清理记忆与关联会话剧情", () => {
    useSessionStore.setState({ characters: { "char-1": profile } });
    useSessionStore.getState().addMemory("char-1", makeMemory());
    useSessionStore.getState().setPlotState("s1", createEmptyPlotState("s1", NOW));

    useSessionStore.getState().deleteCharacter("char-1");
    const state = useSessionStore.getState();
    expect(state.memories["char-1"]).toBeUndefined();
    expect(state.characters["char-1"]).toBeUndefined();
  });

  it("删除会话时把「按会话归属」的派生数据全部摘干净", () => {
    useSessionStore.setState({
      sessions: {
        s1: {
          id: "s1",
          type: "single",
          participantIds: ["char-1", "user"],
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
      activeSessionId: "s1",
    });
    const store = useSessionStore.getState();
    store.setDraft("s1", "草稿");
    store.setPlotState("s1", createEmptyPlotState("s1", NOW));
    store.setDigestCursor("s1", 7);
    store.setContextUsage("s1", {
      estimatedTokens: 100,
      messageCount: 2,
      chars: { system: 1, template: 0, lore: 0, memory: 0, plot: 0, history: 1 },
      trimmed: false,
      summarized: false,
      removedChars: 0,
    });
    store.setDigestFailure("s1", "adapter-error");

    store.deleteSession("s1");
    const state = useSessionStore.getState();
    // 这七项都按会话归属，删会话时一个都不能留
    expect(state.sessions["s1"]).toBeUndefined();
    expect(state.sessionRuntimes["s1"]).toBeUndefined();
    expect(state.plotStates["s1"]).toBeUndefined();
    expect(state.digestCursors["s1"]).toBeUndefined();
    expect(state.drafts["s1"]).toBeUndefined();
    expect(state.contextUsageBySession["s1"]).toBeUndefined();
    expect(state.digestFailures["s1"]).toBeUndefined();
    expect(state.activeSessionId).toBeNull();
  });

  it("批量删除会话：一次清掉多个会话的全部派生数据，未选中的不动", () => {
    const makeSession = (id: string, displayName: string) => ({
      id,
      type: "single" as const,
      participantIds: ["char-1", "user"],
      displayName,
      avatarUrl: "",
      lastMessagePreview: "",
      lastMessageTime: NOW,
      unreadCount: 0,
      isPinned: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    useSessionStore.setState({
      sessions: {
        s1: makeSession("s1", "苏晚晴"),
        s2: makeSession("s2", "林笑笑"),
        s3: makeSession("s3", "周予安"),
      },
      activeSessionId: "s2",
    });
    const store = useSessionStore.getState();
    store.setDraft("s1", "草稿");
    store.setPlotState("s1", createEmptyPlotState("s1", NOW));
    store.setDraft("s2", "另一份草稿");
    store.setDigestCursor("s2", 3);
    store.addTokenUsage("s2", 420);

    store.deleteSessions(["s1", "s2"]);

    const state = useSessionStore.getState();
    expect(Object.keys(state.sessions)).toEqual(["s3"]);
    expect(state.drafts["s1"]).toBeUndefined();
    expect(state.drafts["s2"]).toBeUndefined();
    expect(state.plotStates["s1"]).toBeUndefined();
    expect(state.digestCursors["s2"]).toBeUndefined();
    expect(state.tokenUsageBySession["s2"]).toBeUndefined();
    // 活跃会话被删掉 → 复位
    expect(state.activeSessionId).toBeNull();
  });

  it("批量标为已读：清掉未读，不动别人的未读与时间", () => {
    const makeSession = (
      id: string,
      displayName: string,
      unreadCount: number,
      updatedAt: number,
    ) => ({
      id,
      type: "single" as const,
      participantIds: ["char-1", "user"],
      displayName,
      avatarUrl: "",
      lastMessagePreview: "",
      lastMessageTime: updatedAt,
      unreadCount,
      isPinned: false,
      createdAt: NOW,
      updatedAt,
    });
    useSessionStore.setState({
      sessions: {
        s1: makeSession("s1", "苏晚晴", 3, NOW),
        s2: makeSession("s2", "林笑笑", 0, NOW - 1_000),
        s3: makeSession("s3", "周予安", 7, NOW - 2_000),
      },
      activeSessionId: "s1",
    });

    useSessionStore.getState().markSessionsAsRead(["s1", "s2"]);

    const state = useSessionStore.getState();
    expect(state.sessions.s1!.unreadCount).toBe(0);
    expect(state.sessions.s2!.unreadCount).toBe(0);
    // 没选中的 s3 保持原样
    expect(state.sessions.s3!.unreadCount).toBe(7);
    expect(state.sessions.s3!.updatedAt).toBe(NOW - 2_000);
  });

  describe("非活跃会话在后台交付消息", () => {
    const config = {
      realismEnabled: true,
      typingSpeedCpm: "normal" as const,
      hesitationProbability: 0.15,
      typoRate: 0,
      fragmentationThresholdChars: 24,
      scheduleAwarenessEnabled: true,
      typingIndicatorEnabled: true,
      typoAutoCorrectEnabled: true,
      maxInterChunkDelayMs: 3500,
    };

    function message(id: string, text: string) {
      return {
        id,
        type: "text" as const,
        senderId: "char-1",
        recipientId: "user",
        sessionId: "s1",
        text,
        timestamp: NOW,
        chunkSequence: 0,
        emotion: "neutral" as const,
        sourceOffset: 0,
      };
    }

    it("快照不存在时创建，消息落库且状态是已完成", () => {
      useSessionStore.getState().appendSessionMessage("s1", message("m1", "在吗"), config);

      const runtime = useSessionStore.getState().sessionRuntimes["s1"]!;
      expect(runtime.messages).toHaveLength(1);
      expect((runtime.messages[0] as { message: { text: string } }).message.text).toBe("在吗");
      // 后台交付完就是这一轮结束，不能停在 streaming
      expect(runtime.phase).toBe("completed");
      expect(runtime.typingIndicator.active).toBe(false);
    });

    it("已有快照时按顺序追加，并保留原有状态字段", () => {
      useSessionStore.getState().saveSessionRuntime("s1", {
        messages: [],
        presence: "sleeping",
        presenceText: "已就寝",
        phase: "completed",
        typingIndicator: { active: false, estimatedRemainingMs: 0 },
        pendingCount: 0,
        simulationConfig: config,
      });

      useSessionStore.getState().appendSessionMessage("s1", message("m1", "第一条"), config);
      useSessionStore.getState().appendSessionMessage("s1", message("m2", "第二条"), config);

      const runtime = useSessionStore.getState().sessionRuntimes["s1"]!;
      expect(
        runtime.messages.map((m) => (m as { message: { text: string } }).message.text),
      ).toEqual(["第一条", "第二条"]);
      // 作息状态不该被一条消息抹掉
      expect(runtime.presence).toBe("sleeping");
      expect(runtime.presenceText).toBe("已就寝");
    });

    it("重建快照不能吃掉别的字段：排队消息必须活过后台投递", () => {
      useSessionStore.getState().saveSessionRuntime("s1", {
        messages: [],
        presence: "online",
        presenceText: "在线",
        phase: "streaming",
        typingIndicator: { active: true, estimatedRemainingMs: 0 },
        pendingCount: 1,
        simulationConfig: config,
        // 用户趁角色回复时又发了两条，正在排队
        queuedUserTexts: [{ text: "第二条" }, { text: "第三条" }],
      });

      // 后台把上一轮回复投递进来（这一步以前会把 queuedUserTexts 整段吃掉，
      // 切回该会话时两条排队消息就凭空消失了）
      useSessionStore
        .getState()
        .appendSessionMessage("s1", message("m1", "第一条的回复"), config);

      const runtime = useSessionStore.getState().sessionRuntimes["s1"]!;
      expect(runtime.messages).toHaveLength(1);
      expect(runtime.queuedUserTexts).toEqual([
        { text: "第二条" },
        { text: "第三条" },
      ]);
    });

    it("撤回后台会话里的消息：正文换成提示，其他字段不动", () => {
      useSessionStore.getState().saveSessionRuntime("s1", {
        messages: [],
        presence: "online",
        presenceText: "在线",
        phase: "completed",
        typingIndicator: { active: false, estimatedRemainingMs: 0 },
        pendingCount: 0,
        simulationConfig: config,
      });
      useSessionStore.getState().appendSessionMessage("s1", message("m1", "说漏嘴了"), config);
      useSessionStore.getState().appendSessionMessage("s1", message("m2", "另一条"), config);

      useSessionStore
        .getState()
        .recallSessionMessage("s1", "m1", "苏晚晴撤回了一条消息");

      const runtime = useSessionStore.getState().sessionRuntimes["s1"]!;
      const first = runtime.messages[0] as { message: Record<string, unknown> };
      expect(first.message.type).toBe("recall");
      expect(first.message.notice).toBe("苏晚晴撤回了一条消息");
      expect(first.message.text).toBeUndefined();
      // 后面那条不受影响
      expect(
        (runtime.messages[1] as { message: { text: string } }).message.text,
      ).toBe("另一条");
    });

    it("撤回不存在的消息/不存在的会话时什么都不发生", () => {
      useSessionStore.getState().appendSessionMessage("s1", message("m1", "在吗"), config);

      useSessionStore.getState().recallSessionMessage("s1", "m-unknown", "撤回");
      useSessionStore.getState().recallSessionMessage("s-unknown", "m1", "撤回");

      const runtime = useSessionStore.getState().sessionRuntimes["s1"]!;
      expect(
        (runtime.messages[0] as { message: { text: string } }).message.text,
      ).toBe("在吗");
    });
  });

  it("用户人设：默认不填、可局部更新", () => {
    expect(useSessionStore.getState().userProfile).toEqual({
      displayName: "我",
      bio: "",
    });

    useSessionStore.getState().setUserProfile({ displayName: "小满" });
    expect(useSessionStore.getState().userProfile.displayName).toBe("小满");
    // 局部更新不该把别的字段冲掉
    useSessionStore.getState().setUserProfile({ bio: "程序员，养猫" });
    expect(useSessionStore.getState().userProfile).toEqual({
      displayName: "小满",
      bio: "程序员，养猫",
    });
  });

  it("整理账本：可以写入、也能按会话清掉", () => {
    const report = {
      at: NOW,
      messageCount: 20,
      added: 2,
      replaced: 1,
      conflicts: 0,
      events: 1,
    };
    useSessionStore.getState().setDigestReport("s1", report);
    expect(useSessionStore.getState().digestReports["s1"]).toEqual(report);

    useSessionStore.getState().setDigestReport("s1", null);
    expect(useSessionStore.getState().digestReports["s1"]).toBeUndefined();
  });

  describe("未读分隔线标记", () => {
    /** 造一个会话，方便反复用。 */
    function seedSessionForUnread(): void {
      useSessionStore.setState({
        sessions: {
          s1: {
            id: "s1",
            type: "single",
            participantIds: ["char-1", "user"],
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
        unreadMarkers: {},
      });
    }

    it("未读从 0 变 1 时记下第一条未读消息", () => {
      seedSessionForUnread();

      useSessionStore.getState().incrementUnread("s1", "第一条", "m-1");
      useSessionStore.getState().incrementUnread("s1", "第二条", "m-2");

      // 记的是"离开期间的第一条"，后面来的不覆盖
      expect(useSessionStore.getState().unreadMarkers["s1"]).toBe("m-1");
      expect(useSessionStore.getState().sessions["s1"]!.unreadCount).toBe(2);
    });

    it("没传消息 ID 时不记标记（老调用方也不会崩）", () => {
      seedSessionForUnread();

      useSessionStore.getState().incrementUnread("s1", "第一条");

      expect(useSessionStore.getState().unreadMarkers["s1"]).toBeUndefined();
    });

    it("取走标记后就没了（看过不该再画一次）", () => {
      seedSessionForUnread();
      useSessionStore.getState().incrementUnread("s1", "第一条", "m-1");

      expect(useSessionStore.getState().consumeUnreadMarker("s1")).toBe("m-1");
      expect(useSessionStore.getState().consumeUnreadMarker("s1")).toBeNull();
      expect(useSessionStore.getState().unreadMarkers["s1"]).toBeUndefined();
    });

    it("手动标记已读会连标记一起清掉（就是不打算回头看了）", () => {
      seedSessionForUnread();
      useSessionStore.getState().incrementUnread("s1", "第一条", "m-1");

      useSessionStore.getState().markSessionAsRead("s1");

      expect(useSessionStore.getState().unreadMarkers["s1"]).toBeUndefined();
      expect(useSessionStore.getState().consumeUnreadMarker("s1")).toBeNull();
    });
  });

  describe("会话列表的「正在输入」", () => {
    it("置位与清位：清位时把键删掉，不留一堆 false", () => {
      const store = useSessionStore.getState();

      store.setSessionTyping("s1", true);
      expect(useSessionStore.getState().typingBySession["s1"]).toBe(true);

      store.setSessionTyping("s1", false);
      expect(useSessionStore.getState().typingBySession["s1"]).toBeUndefined();
    });

    it("状态没变时不产生新对象（避免白触发一轮重渲）", () => {
      const store = useSessionStore.getState();
      store.setSessionTyping("s1", true);
      const before = useSessionStore.getState().typingBySession;

      store.setSessionTyping("s1", true);

      expect(useSessionStore.getState().typingBySession).toBe(before);
    });
  });

  it("世界书条目：整批落库 / 停用 / 删除 / 清空", () => {
    const makeLore = (id: string) => ({
      id,
      keys: ["唱片"],
      secondaryKeys: [],
      content: `设定 ${id}`,
      enabled: true,
      order: 0,
      caseSensitive: false,
      constant: false,
      selective: false,
    });

    const store = useSessionStore.getState();
    store.setLoreEntries("char-1", [makeLore("lore-1"), makeLore("lore-2")]);
    expect(useSessionStore.getState().loreEntries["char-1"]).toHaveLength(2);

    store.updateLoreEntry("char-1", "lore-1", { enabled: false });
    expect(
      useSessionStore.getState().loreEntries["char-1"]![0]!.enabled,
    ).toBe(false);

    store.deleteLoreEntry("char-1", "lore-1");
    expect(useSessionStore.getState().loreEntries["char-1"]).toHaveLength(1);

    // 删到空 = 这本世界书不存在（不留空数组在持久化数据里）
    useSessionStore.getState().deleteLoreEntry("char-1", "lore-2");
    expect(useSessionStore.getState().loreEntries["char-1"]).toBeUndefined();
  });

  it("删除角色时世界书跟着一起清掉", () => {
    useSessionStore.setState({ characters: { "char-1": profile } });
    useSessionStore.getState().setLoreEntries("char-1", [
      {
        id: "lore-1",
        keys: ["唱片"],
        secondaryKeys: [],
        content: "设定",
        enabled: true,
        order: 0,
        caseSensitive: false,
        constant: false,
        selective: false,
      },
    ]);
    expect(useSessionStore.getState().loreEntries["char-1"]).toHaveLength(1);

    useSessionStore.getState().deleteCharacter("char-1");
    expect(useSessionStore.getState().loreEntries["char-1"]).toBeUndefined();
  });

  it("删除角色时同样清理关联会话的派生数据，并复位活跃会话", () => {
    useSessionStore.setState({
      characters: { "char-1": profile },
      sessions: {
        s1: {
          id: "s1",
          type: "single",
          participantIds: ["char-1", "user"],
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
      activeSessionId: "s1",
    });
    const store = useSessionStore.getState();
    store.setDraft("s1", "草稿");
    store.setDigestCursor("s1", 3);
    store.setContextUsage("s1", {
      estimatedTokens: 50,
      messageCount: 1,
      chars: { system: 1, template: 0, lore: 0, memory: 0, plot: 0, history: 0 },
      trimmed: false,
      summarized: false,
      removedChars: 0,
    });
    store.setDigestFailure("s1", "timeout");

    store.deleteCharacter("char-1");
    const state = useSessionStore.getState();
    expect(state.sessions["s1"]).toBeUndefined();
    expect(state.sessionRuntimes["s1"]).toBeUndefined();
    expect(state.drafts["s1"]).toBeUndefined();
    expect(state.contextUsageBySession["s1"]).toBeUndefined();
    expect(state.digestFailures["s1"]).toBeUndefined();
    // 活跃会话指向了被删掉的会话时必须复位，否则界面停在"没有会话"却有脏状态
    expect(state.activeSessionId).toBeNull();
  });

  it("partialize 持久化记忆/剧情字段且不落盘 apiKey", () => {
    useSessionStore.setState({ apiKey: "sk-secret" });
    const partialize = useSessionStore.persist.getOptions().partialize;
    expect(partialize).toBeDefined();
    const partial = partialize!(useSessionStore.getState()) as Record<string, unknown>;

    expect(partial.apiKey).toBeUndefined();
    expect(partial.memories).toBeDefined();
    expect(partial.loreEntries).toBeDefined();
    expect(partial.plotStates).toBeDefined();
    expect(partial.digestCursors).toBeDefined();
    expect(partial.digestConfig).toBeDefined();
    expect(partial.drafts).toBeDefined();
  });

  it("schema v3 迁移：v1 重置、v2 原样保留", () => {
    expect(SCHEMA_VERSION).toBe(3);
    expect(migrateSnapshot({ sessions: {} }, 1)).toBeNull();
    expect(migrateSnapshot({ sessions: { s1: {} } }, 2)).toEqual({
      sessions: { s1: {} },
    });
  });

  it("整理失败原因：记录后可清除（诊断信息不持久化）", () => {
    const store = useSessionStore.getState();

    store.setDigestFailure("s-fail", "adapter-error");
    const recorded = useSessionStore.getState().digestFailures["s-fail"];
    expect(recorded?.reason).toBe("adapter-error");
    expect(typeof recorded?.at).toBe("number");

    store.setDigestFailure("s-fail", null);
    expect(useSessionStore.getState().digestFailures["s-fail"]).toBeUndefined();
  });

  it("累计 token：按会话累加请求数与用量，忽略非法值", () => {
    const store = useSessionStore.getState();
    store.addTokenUsage("s-usage", 1200);
    store.addTokenUsage("s-usage", 800);
    store.addTokenUsage("s-other", 100);

    const usage = useSessionStore.getState().tokenUsageBySession;
    expect(usage["s-usage"]).toEqual({ requests: 2, tokens: 2000 });
    expect(usage["s-other"]).toEqual({ requests: 1, tokens: 100 });

    // 非法值不该污染统计
    store.addTokenUsage("s-usage", Number.NaN);
    store.addTokenUsage("s-usage", -5);
    expect(useSessionStore.getState().tokenUsageBySession["s-usage"]).toEqual({
      requests: 2,
      tokens: 2000,
    });
  });
});
