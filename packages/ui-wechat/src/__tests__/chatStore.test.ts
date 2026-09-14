/**
 * @file chatStore.test.ts
 * chatStore 状态机测试：mock engine output 验证状态转换。
 *
 * 通过 mock IndexedDB 存储层，测试同步且确定。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.hoisted 确保 mockStore 在 vi.mock 工厂函数执行时已初始化
const { mockStore } = vi.hoisted(() => ({
  mockStore: new Map<string, string>(),
}));

// Mock IndexedDB 存储层（在 import store 之前 mock）
// RealismEngine 是 type-only import，不需要 mock
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

import { mergePersistedChatState, useChatStore } from "../store/chatStore";
import { toLLMHistory } from "@wechat-rp/core";
import type { IRealismEngineOutput, ITextMessage } from "@wechat-rp/shared-types";

function makeChunkDeliveredEvent(message: Partial<ITextMessage> = {}): IRealismEngineOutput {
  const msg: ITextMessage = {
    id: `msg-${Date.now()}`,
    type: "text",
    senderId: "char-1",
    recipientId: "user-1",
    sessionId: "test-session",
    timestamp: Date.now(),
    chunkSequence: 0,
    emotion: "neutral",
    text: "测试消息",
    sourceOffset: 0,
    ...message,
  };
  return {
    sessionId: "test",
    characterId: "char-1",
    sequence: 0,
    emittedAt: Date.now(),
    event: { kind: "chunk-delivered", message: msg },
  };
}

function makeLifecycleEvent(phase: "started" | "completed" | "aborted"): IRealismEngineOutput {
  return {
    sessionId: "test",
    characterId: "char-1",
    sequence: 0,
    emittedAt: Date.now(),
    event: { kind: "lifecycle", phase },
  };
}

function makeTypingIndicatorEvent(active: boolean): IRealismEngineOutput {
  return {
    sessionId: "test",
    characterId: "char-1",
    sequence: 0,
    emittedAt: Date.now(),
    event: { kind: "typing-indicator", active, estimatedRemainingMs: 1000 },
  };
}

function makePresenceEvent(): IRealismEngineOutput {
  return {
    sessionId: "test",
    characterId: "char-1",
    sequence: 0,
    emittedAt: Date.now(),
    event: {
      kind: "presence",
      status: "sleeping",
      emotion: "sleepy",
      displayText: "已就寝",
    },
  };
}

describe("chatStore", () => {
  beforeEach(() => {
    mockStore.clear();
    useChatStore.setState({
      messages: [],
      queuedUserTexts: [],
      pendingCount: 0,
      pendingRevealPlans: {},
      presence: "online",
      presenceText: "在线",
      typingIndicator: { active: false, estimatedRemainingMs: 0 },
      phase: "idle",
      lastError: null,
      simulationConfig: {
        realismEnabled: true,
        typingSpeedCpm: "normal",
        hesitationProbability: 0.15,
        typoRate: 0.05,
        fragmentationThresholdChars: 24,
        scheduleAwarenessEnabled: true,
        typingIndicatorEnabled: true,
        typoAutoCorrectEnabled: true,
        maxInterChunkDelayMs: 6000,
      },
      hydrated: false,
      engineSubscription: null,
      engine: null,
    });
  });

  it("初始状态正确", () => {
    const state = useChatStore.getState();
    expect(state.messages).toEqual([]);
    expect(state.pendingCount).toBe(0);
    expect(state.presence).toBe("online");
    expect(state.phase).toBe("idle");
    expect(state.lastError).toBeNull();
  });

  it("_handleEngineOutput: chunk-delivered 插入消息", () => {
    const output = makeChunkDeliveredEvent({ id: "msg-1", text: "你好" });
    useChatStore.getState()._handleEngineOutput(output);

    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.message.id).toBe("msg-1");
    expect((state.messages[0]!.message as ITextMessage).text).toBe("你好");
    expect(state.messages[0]!.revealed).toBe(false);
    expect(state.phase).toBe("streaming");
  });

  it("_handleEngineOutput: 多个 chunk-delivered 累积插入", () => {
    for (let i = 0; i < 3; i += 1) {
      useChatStore.getState()._handleEngineOutput(
        makeChunkDeliveredEvent({ id: `msg-${i}`, text: `消息${i}`, chunkSequence: i }),
      );
    }

    expect(useChatStore.getState().messages).toHaveLength(3);
  });

  it("_handleEngineOutput: lifecycle started 标记 streaming", () => {
    useChatStore.getState()._handleEngineOutput(makeLifecycleEvent("started"));
    expect(useChatStore.getState().phase).toBe("streaming");
  });

  it("_handleEngineOutput: lifecycle completed 标记 completed", () => {
    useChatStore.getState()._handleEngineOutput(makeLifecycleEvent("started"));
    useChatStore.getState()._handleEngineOutput(makeLifecycleEvent("completed"));

    const state = useChatStore.getState();
    expect(state.phase).toBe("completed");
    expect(state.typingIndicator.active).toBe(false);
  });

  it("_handleEngineOutput: lifecycle aborted 标记 aborted", () => {
    useChatStore.getState()._handleEngineOutput(makeLifecycleEvent("aborted"));

    expect(useChatStore.getState().phase).toBe("aborted");
    expect(useChatStore.getState().typingIndicator.active).toBe(false);
  });

  it("_handleEngineOutput: typing-indicator 更新状态", () => {
    useChatStore.getState()._handleEngineOutput(makeTypingIndicatorEvent(true));

    const state = useChatStore.getState();
    expect(state.typingIndicator.active).toBe(true);
    expect(state.typingIndicator.estimatedRemainingMs).toBe(1000);

    useChatStore.getState()._handleEngineOutput(makeTypingIndicatorEvent(false));
    expect(useChatStore.getState().typingIndicator.active).toBe(false);
  });

  it("_handleEngineOutput: presence 更新在场状态", () => {
    useChatStore.getState()._handleEngineOutput(makePresenceEvent());

    const state = useChatStore.getState();
    expect(state.presence).toBe("sleeping");
    expect(state.presenceText).toBe("已就寝");
  });

  it("_handleEngineOutput: chunk-scheduled 增加 pendingCount", () => {
    const output: IRealismEngineOutput = {
      sessionId: "test",
      characterId: "char-1",
      sequence: 0,
      emittedAt: Date.now(),
      event: {
        kind: "chunk-scheduled",
        pendingMessageId: "pending-1",
        delayMs: 0,
      },
    };
    useChatStore.getState()._handleEngineOutput(output);

    expect(useChatStore.getState().pendingCount).toBe(1);
  });

  it("_handleEngineOutput: char-reveal-plan 缓存到 pendingRevealPlans", () => {
    const output: IRealismEngineOutput = {
      sessionId: "test",
      characterId: "char-1",
      sequence: 0,
      emittedAt: Date.now(),
      event: {
        kind: "char-reveal-plan",
        messageId: "msg-1",
        revealDelays: [100, 200, 300],
        containsTypo: false,
      },
    };
    useChatStore.getState()._handleEngineOutput(output);

    const state = useChatStore.getState();
    expect(state.pendingRevealPlans["msg-1"]).toBeDefined();
    expect(state.pendingRevealPlans["msg-1"]!.revealDelays).toEqual([100, 200, 300]);
  });

  it("_handleEngineOutput: char-reveal-plan 在消息已存在时直接合并", () => {
    // 先插入消息
    useChatStore.getState()._handleEngineOutput(
      makeChunkDeliveredEvent({ id: "msg-1", text: "你好" }),
    );

    // 再推送 char-reveal-plan
    const output: IRealismEngineOutput = {
      sessionId: "test",
      characterId: "char-1",
      sequence: 0,
      emittedAt: Date.now(),
      event: {
        kind: "char-reveal-plan",
        messageId: "msg-1",
        revealDelays: [100, 200],
        containsTypo: true,
        typoCorrectAtMs: 500,
        correctedText: "我在这里等你。",
      },
    };
    useChatStore.getState()._handleEngineOutput(output);

    const state = useChatStore.getState();
    expect(state.pendingRevealPlans["msg-1"]).toBeUndefined(); // 不缓存
    expect(state.messages[0]!.revealDelays).toEqual([100, 200]);
    expect(state.messages[0]!.typoCorrectAtMs).toBe(500);
    // 错别字纠正文本随计划一起落到 runtime
    expect(state.messages[0]!.correctedText).toBe("我在这里等你。");
  });

  it("_handleEngineOutput: chunk-delivered 合并缓存的 reveal-plan", () => {
    // 先推送 char-reveal-plan（消息尚未存在）
    useChatStore.getState()._handleEngineOutput({
      sessionId: "test",
      characterId: "char-1",
      sequence: 0,
      emittedAt: Date.now(),
      event: {
        kind: "char-reveal-plan",
        messageId: "msg-1",
        revealDelays: [100, 200],
        containsTypo: true,
        typoCorrectAtMs: 600,
        correctedText: "你好呀",
      },
    });

    // 再推送 chunk-delivered
    useChatStore.getState()._handleEngineOutput(
      makeChunkDeliveredEvent({ id: "msg-1", text: "你好" }),
    );

    const state = useChatStore.getState();
    expect(state.messages[0]!.revealDelays).toEqual([100, 200]);
    expect(state.messages[0]!.correctedText).toBe("你好呀");
    expect(state.pendingRevealPlans["msg-1"]).toBeUndefined(); // 缓存已清除
  });

  it("_handleEngineOutput: error 事件更新 lastError", () => {
    const output: IRealismEngineOutput = {
      sessionId: "test",
      characterId: "char-1",
      sequence: 0,
      emittedAt: Date.now(),
      event: {
        kind: "error",
        code: "llm-stream-broken",
        message: "连接断开",
        recoverable: true,
      },
    };
    useChatStore.getState()._handleEngineOutput(output);

    const state = useChatStore.getState();
    expect(state.lastError).toEqual({ code: "llm-stream-broken", message: "连接断开" });
  });

  it("_handleEngineOutput: 不可恢复 error 标记 aborted", () => {
    const output: IRealismEngineOutput = {
      sessionId: "test",
      characterId: "char-1",
      sequence: 0,
      emittedAt: Date.now(),
      event: {
        kind: "error",
        code: "unknown",
        message: "致命错误",
        recoverable: false,
      },
    };
    useChatStore.getState()._handleEngineOutput(output);

    expect(useChatStore.getState().phase).toBe("aborted");
  });

  it("appendDebugMessage: 追加消息到列表末尾", () => {
    useChatStore.getState().appendDebugMessage({
      id: "debug-1",
      type: "text",
      senderId: "char-1",
      recipientId: "user-1",
      sessionId: "test-session",
      timestamp: Date.now(),
      chunkSequence: 0,
      emotion: "neutral",
      text: "调试消息",
      sourceOffset: 0,
    });

    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(1);
    expect((state.messages[0]!.message as ITextMessage).text).toBe("调试消息");
    expect(state.messages[0]!.revealed).toBe(true);
    expect(state.messages[0]!.pending).toBe(false);
  });

  it("updateSimulationConfig: 合并配置", () => {
    useChatStore.getState().updateSimulationConfig({ typingSpeedCpm: "fast" });

    expect(useChatStore.getState().simulationConfig.typingSpeedCpm).toBe("fast");
    // 其他字段不变
    expect(useChatStore.getState().simulationConfig.realismEnabled).toBe(true);
  });

  // ---------- 撤回 ----------
  describe("recallMessage", () => {
    it("把正文换成提示，位置不变（不是删除）", () => {
      useChatStore.getState().addUserMessage("刚那句说重了", "test-session");
      const id = useChatStore.getState().messages[0]!.message.id;

      useChatStore.getState().recallMessage(id);

      const messages = useChatStore.getState().messages;
      expect(messages).toHaveLength(1);
      const recalled = messages[0]!.message;
      expect(recalled.type).toBe("recall");
      expect(recalled.id).toBe(id);
      expect(recalled).toMatchObject({
        type: "recall",
        targetMessageId: id,
        notice: "你撤回了一条消息",
      });
      // 原文彻底不在（撤回与"自己删掉"的区别）
      expect(toLLMHistory(messages.map((m) => m.message))).toEqual([]);
    });

    it("自定义提示文案（角色撤回时用对方昵称）", () => {
      useChatStore.getState().addUserMessage("喂", "test-session");
      const id = useChatStore.getState().messages[0]!.message.id;

      useChatStore.getState().recallMessage(id, "苏晚晴撤回了一条消息");

      expect(useChatStore.getState().messages[0]!.message).toMatchObject({
        notice: "苏晚晴撤回了一条消息",
      });
    });

    it("重复撤回不覆盖已有提示文案", () => {
      useChatStore.getState().addUserMessage("喂", "test-session");
      const id = useChatStore.getState().messages[0]!.message.id;

      useChatStore.getState().recallMessage(id, "苏晚晴撤回了一条消息");
      useChatStore.getState().recallMessage(id);

      expect(useChatStore.getState().messages[0]!.message).toMatchObject({
        notice: "苏晚晴撤回了一条消息",
      });
    });

    it("撤回不存在的消息时什么都不发生", () => {
      useChatStore.getState().addUserMessage("在的", "test-session");

      useChatStore.getState().recallMessage("不存在的 id");

      const messages = useChatStore.getState().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]!.message.type).toBe("text");
    });

    it("撤回会换掉数组与那条消息的引用（否则会话快照不会重存、气泡也不会重渲）", () => {
      useChatStore.getState().addUserMessage("第一句", "test-session");
      useChatStore.getState().addUserMessage("第二句", "test-session");
      const before = useChatStore.getState().messages;
      const untouched = before[0]!;

      useChatStore.getState().recallMessage(before[0]!.message.id);

      const after = useChatStore.getState().messages;
      // 数组换了引用：App 里"保存会话快照"的 effect 才认得出这次变化
      expect(after).not.toBe(before);
      // 被撤回的那条换了引用：memo 过的气泡才会重渲染成提示
      expect(after[0]).not.toBe(untouched);
      // 其他消息保持原引用，不牵连重渲
      expect(after[1]).toBe(before[1]);
    });
  });

  it("引擎推送 recall 事件时同样丢掉原文", () => {
    useChatStore
      .getState()
      ._handleEngineOutput(makeChunkDeliveredEvent({ id: "msg-r", text: "说漏嘴了" }));

    useChatStore.getState()._handleEngineOutput({
      sessionId: "test",
      characterId: "char-1",
      sequence: 1,
      emittedAt: Date.now(),
      event: {
        kind: "recall",
        targetMessageId: "msg-r",
        notice: "苏晚晴撤回了一条消息",
      },
    });

    const recalled = useChatStore.getState().messages[0]!.message;
    expect(recalled).toMatchObject({
      type: "recall",
      targetMessageId: "msg-r",
      notice: "苏晚晴撤回了一条消息",
    });
    expect("text" in recalled).toBe(false);
  });

  // ---------- 持久化合并 ----------
  describe("mergePersistedChatState", () => {
    it("排队消息真的被写进持久化存储（不只是留在内存里）", async () => {
      useChatStore.setState({
        messages: [],
        queuedUserTexts: [{ text: "我周六想去看展" }],
      });
      // persist 的写入是异步的：等一个微任务再读 mock 存储
      await new Promise((resolve) => setTimeout(resolve, 0));

      const raw = mockStore.get("wechat-rp-session") ?? "";
      expect(raw).toContain("我周六想去看展");
      expect(raw).toContain("queuedUserTexts");
    });

    it("排队消息跟着存档回来（老存档没有这个字段就按空队列）", () => {
      const queue = [
        { text: "你还在吗" },
        { text: "我先去吃饭了" },
      ];
      const restored = mergePersistedChatState(
        { messages: [], queuedUserTexts: queue },
        useChatStore.getState(),
      );
      expect(restored.queuedUserTexts).toEqual(queue);

      const legacy = mergePersistedChatState(
        { messages: [] },
        useChatStore.getState(),
      );
      expect(legacy.queuedUserTexts).toEqual([]);

      // 坏数据（null / 不是数组）也要归一化成空队列，别让消费逻辑炸掉
      const broken = mergePersistedChatState(
        { messages: [], queuedUserTexts: null as never },
        useChatStore.getState(),
      );
      expect(broken.queuedUserTexts).toEqual([]);
    });

    it("老存档里没有的新旋钮会被补上默认值，用户调过的值保留", () => {
      const merged = mergePersistedChatState(
        {
          messages: [],
          presenceText: "离开",
          // 老存档的配置对象：只有当时就存在的字段
          simulationConfig: {
            realismEnabled: true,
            typingSpeedCpm: "fast",
            hesitationProbability: 0.1,
            typoRate: 0,
            fragmentationThresholdChars: 20,
            scheduleAwarenessEnabled: false,
            typingIndicatorEnabled: true,
            typoAutoCorrectEnabled: false,
            maxInterChunkDelayMs: 1000,
          },
        },
        useChatStore.getState(),
      );

      expect(merged.simulationConfig.recallProbability).toBe(0.05);
      expect(merged.simulationConfig.typingSpeedCpm).toBe("fast");
      expect(merged.simulationConfig.maxInterChunkDelayMs).toBe(1000);
      expect(merged.presenceText).toBe("离开");
    });

    it("存档里没有这项配置时整块用默认值兜底", () => {
      const merged = mergePersistedChatState(
        { messages: [] },
        useChatStore.getState(),
      );

      expect(merged.simulationConfig.recallProbability).toBe(0.05);
      expect(merged.simulationConfig.realismEnabled).toBe(true);
    });
  });

  it("resetSession: 清空消息和状态", () => {
    useChatStore.getState()._handleEngineOutput(
      makeChunkDeliveredEvent({ id: "msg-1", text: "你好" }),
    );
    expect(useChatStore.getState().messages).toHaveLength(1);

    useChatStore.getState().resetSession();

    const state = useChatStore.getState();
    expect(state.messages).toEqual([]);
    expect(state.pendingCount).toBe(0);
    expect(state.phase).toBe("idle");
    expect(state.lastError).toBeNull();
  });

  it("markHydrated: 标记 hydration 完成", () => {
    expect(useChatStore.getState().hydrated).toBe(false);
    useChatStore.getState().markHydrated();
    expect(useChatStore.getState().hydrated).toBe(true);
  });

  it("hydrateFromSnapshot: 从快照恢复状态", () => {
    const msg: ITextMessage = {
      id: "restored-1",
      type: "text",
      senderId: "char-1",
      recipientId: "user-1",
      sessionId: "test-session",
      timestamp: Date.now(),
      chunkSequence: 0,
      emotion: "neutral",
      text: "恢复的消息",
      sourceOffset: 0,
    };
    useChatStore.getState().hydrateFromSnapshot({
      schemaVersion: 1,
      sessionId: "test",
      characterId: "char-1",
      messages: [msg],
      messageRuntimes: [{ revealed: true, pending: false }],
      presence: "online",
      presenceText: "在线",
      simulationConfig: {
        realismEnabled: true,
        typingSpeedCpm: "slow",
        hesitationProbability: 0,
        typoRate: 0,
        fragmentationThresholdChars: 24,
        scheduleAwarenessEnabled: false,
        typingIndicatorEnabled: true,
        typoAutoCorrectEnabled: true,
        maxInterChunkDelayMs: 6000,
      },
      lastPhase: "completed",
      lastError: null,
      deliveredChunkCount: 1,
      savedAt: Date.now(),
    });

    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(1);
    expect((state.messages[0]!.message as ITextMessage).text).toBe("恢复的消息");
    expect(state.messages[0]!.revealed).toBe(true);
    expect(state.presence).toBe("online");
    expect(state.simulationConfig.typingSpeedCpm).toBe("slow");
    expect(state.hydrated).toBe(true);
  });

  it("hydrateFromSnapshot: streaming → interrupted", () => {
    useChatStore.getState().hydrateFromSnapshot({
      schemaVersion: 1,
      sessionId: "test",
      characterId: "char-1",
      messages: [],
      messageRuntimes: [],
      presence: "online",
      presenceText: "在线",
      simulationConfig: {
        realismEnabled: true,
        typingSpeedCpm: "normal",
        hesitationProbability: 0.15,
        typoRate: 0.05,
        fragmentationThresholdChars: 24,
        scheduleAwarenessEnabled: true,
        typingIndicatorEnabled: true,
        typoAutoCorrectEnabled: true,
        maxInterChunkDelayMs: 6000,
      },
      lastPhase: "streaming",
      lastError: null,
      deliveredChunkCount: 0,
      savedAt: Date.now(),
    });

    expect(useChatStore.getState().phase).toBe("interrupted");
  });

  // ---------- addUserMessage（用户消息立即显示） ----------
  describe("addUserMessage", () => {
    it("插入用户消息到列表末尾", () => {
      useChatStore.getState().addUserMessage("你好", "test-session");

      const state = useChatStore.getState();
      expect(state.messages).toHaveLength(1);
      const runtime = state.messages[0]!;
      expect(runtime.message.senderId).toBe("user");
      expect((runtime.message as ITextMessage).text).toBe("你好");
      expect(runtime.message.sessionId).toBe("test-session");
    });

    it("设置 revealed=true 确保 UI 立即显示", () => {
      useChatStore.getState().addUserMessage("测试", "s1");

      const runtime = useChatStore.getState().messages[0]!;
      expect(runtime.revealed).toBe(true);
      expect(runtime.pending).toBe(false);
    });

    it("phase 切换为 streaming", () => {
      expect(useChatStore.getState().phase).toBe("idle");
      useChatStore.getState().addUserMessage("消息", "s1");
      expect(useChatStore.getState().phase).toBe("streaming");
    });

    it("多次调用累加消息（顺序保留）", () => {
      useChatStore.getState().addUserMessage("第一条", "s1");
      useChatStore.getState().addUserMessage("第二条", "s1");
      useChatStore.getState().addUserMessage("第三条", "s1");

      const messages = useChatStore.getState().messages;
      expect(messages).toHaveLength(3);
      expect((messages[0]!.message as ITextMessage).text).toBe("第一条");
      expect((messages[1]!.message as ITextMessage).text).toBe("第二条");
      expect((messages[2]!.message as ITextMessage).text).toBe("第三条");
    });

    it("生成的消息 id 唯一", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 20; i += 1) {
        useChatStore.getState().addUserMessage(`msg-${i}`, "s1");
        ids.add(useChatStore.getState().messages[i]!.message.id);
      }
      expect(ids.size).toBe(20);
    });

    it("用户消息后追加 AI chunk-delivered 不覆盖用户消息", () => {
      // 模拟用户发送消息
      useChatStore.getState().addUserMessage("用户输入", "s1");
      expect(useChatStore.getState().messages).toHaveLength(1);

      // 模拟引擎回复（chunk-delivered）
      useChatStore.getState()._handleEngineOutput(
        makeChunkDeliveredEvent({ id: "ai-1", text: "AI 回复" }),
      );

      const messages = useChatStore.getState().messages;
      expect(messages).toHaveLength(2);
      // 用户消息仍在前面
      expect(messages[0]!.message.senderId).toBe("user");
      expect((messages[0]!.message as ITextMessage).text).toBe("用户输入");
      // AI 消息在后面
      expect(messages[1]!.message.senderId).toBe("char-1");
      expect((messages[1]!.message as ITextMessage).text).toBe("AI 回复");
    });

    it("recipientId 设为 'character'", () => {
      useChatStore.getState().addUserMessage("hi", "s1");
      expect(useChatStore.getState().messages[0]!.message.recipientId).toBe("character");
    });

    it("timestamp 为当前时间", () => {
      const before = Date.now();
      useChatStore.getState().addUserMessage("time-test", "s1");
      const after = Date.now();
      const ts = useChatStore.getState().messages[0]!.message.timestamp;
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  // ---------- 回复进行中继续发消息（排队） ----------

  describe("removeMessagesFrom（重新生成用）", () => {
    it("从指定消息开始整段截断，保留它之前的内容", () => {
      useChatStore.getState().addUserMessage("第一条", "s1");
      useChatStore.getState().addUserMessage("第二条", "s1");
      useChatStore.getState().addUserMessage("第三条", "s1");

      const target = useChatStore.getState().messages[1]!.message.id;
      useChatStore.getState().removeMessagesFrom(target);

      const messages = useChatStore.getState().messages;
      expect(messages).toHaveLength(1);
      expect((messages[0]!.message as ITextMessage).text).toBe("第一条");
    });

    it("顺带清掉占位计数与「正在输入」，避免残留状态", () => {
      useChatStore.getState().addUserMessage("你好", "s1");
      useChatStore.setState({
        pendingCount: 3,
        typingIndicator: { active: true, estimatedRemainingMs: 1200 },
      });

      const target = useChatStore.getState().messages[0]!.message.id;
      useChatStore.getState().removeMessagesFrom(target);

      const state = useChatStore.getState();
      expect(state.pendingCount).toBe(0);
      expect(state.typingIndicator.active).toBe(false);
    });

    it("传入不存在的 ID 时不做任何改动", () => {
      useChatStore.getState().addUserMessage("你好", "s1");
      const before = useChatStore.getState().messages;

      useChatStore.getState().removeMessagesFrom("不存在的消息");

      expect(useChatStore.getState().messages).toEqual(before);
    });
  });

  describe("deleteMessage（删除单条）", () => {
    it("只删掉那一条，前后都留着", () => {
      useChatStore.getState().addUserMessage("第一条", "s1");
      useChatStore.getState().addUserMessage("第二条", "s1");
      useChatStore.getState().addUserMessage("第三条", "s1");

      const target = useChatStore.getState().messages[1]!.message.id;
      useChatStore.getState().deleteMessage(target);

      const texts = useChatStore
        .getState()
        .messages.map((m) => (m.message as ITextMessage).text);
      expect(texts).toEqual(["第一条", "第三条"]);
    });

    it("删掉之后它不再出现在 LLM 历史里（等于让角色忘掉这句）", () => {
      useChatStore.getState().addUserMessage("不该说的话", "s1");
      useChatStore.getState().addUserMessage("该说的话", "s1");

      const target = useChatStore.getState().messages[0]!.message.id;
      useChatStore.getState().deleteMessage(target);

      const messages = useChatStore.getState().messages.map((m) => m.message);
      expect(toLLMHistory(messages)).toEqual([
        { role: "user", content: "该说的话" },
      ]);
    });

    it("传入不存在的 ID 时不做任何改动", () => {
      useChatStore.getState().addUserMessage("你好", "s1");
      const before = useChatStore.getState().messages;

      useChatStore.getState().deleteMessage("不存在的消息");

      expect(useChatStore.getState().messages).toEqual(before);
    });
  });

  describe("用户发贴图", () => {
    it("addStickerMessage 上屏一条自己发出的贴图，并进入回复中", () => {
      useChatStore.getState().addStickerMessage("s1", {
        stickerPackId: "zhichi-basic",
        stickerId: "grin",
        fallbackText: "[开心]",
      });

      const state = useChatStore.getState();
      expect(state.messages).toHaveLength(1);
      const message = state.messages[0]!.message;
      expect(message.type).toBe("sticker");
      expect(message.senderId).toBe("user");
      expect(state.phase).toBe("streaming");
    });
  });

  describe("appendCharacterMessage（社区卡开场白）", () => {
    it("追加一条角色消息，且不把界面切到「正在回复」", () => {
      useChatStore.setState({ phase: "idle" });

      useChatStore.getState().appendCharacterMessage({
        text: "外面雨太大了，先坐会儿吧。",
        sessionId: "s1",
        characterId: "char-1",
      });

      const state = useChatStore.getState();
      expect(state.messages).toHaveLength(1);
      const message = state.messages[0]!.message as ITextMessage;
      expect(message.senderId).toBe("char-1");
      expect(message.text).toBe("外面雨太大了，先坐会儿吧。");
      // 开场白不是一次"回复"，输入框不该被锁住
      expect(state.phase).toBe("idle");
      expect(state.messages[0]!.revealed).toBe(true);
      expect(state.pendingCount).toBe(0);
    });

    it("多次调用按顺序追加（不会互相覆盖）", () => {
      useChatStore.getState().appendCharacterMessage({
        text: "第一句",
        sessionId: "s1",
        characterId: "char-1",
      });
      useChatStore.getState().appendCharacterMessage({
        text: "第二句",
        sessionId: "s1",
        characterId: "char-1",
      });

      expect(
        useChatStore.getState().messages.map((m) => (m.message as ITextMessage).text),
      ).toEqual(["第一句", "第二句"]);
    });
  });

  describe("enqueueUserMessage / shiftQueuedUserText", () => {
    it("排队消息立即上屏并进入队列", () => {
      useChatStore.getState().enqueueUserMessage("第二条", "s1");

      const state = useChatStore.getState();
      // 立即上屏，用户能看到自己说的话
      expect(state.messages).toHaveLength(1);
      expect((state.messages[0]!.message as ITextMessage).text).toBe(
        "第二条",
      );
      expect(state.queuedUserTexts).toEqual([{ text: "第二条" }]);
    });

    it("按先进先出顺序取出队首", () => {
      useChatStore.getState().enqueueUserMessage("A", "s1");
      useChatStore.getState().enqueueUserMessage("B", "s1");

      expect(useChatStore.getState().shiftQueuedUserText()).toEqual({
        text: "A",
      });
      expect(useChatStore.getState().queuedUserTexts).toEqual([{ text: "B" }]);
      expect(useChatStore.getState().shiftQueuedUserText()).toEqual({
        text: "B",
      });
      expect(useChatStore.getState().shiftQueuedUserText()).toBeNull();
    });

    it("resetSession 清空待发队列（避免跨会话串消息）", () => {
      useChatStore.getState().enqueueUserMessage("排队消息", "s1");
      useChatStore.getState().resetSession();

      expect(useChatStore.getState().queuedUserTexts).toEqual([]);
    });

    it("入队不改变 phase（否则消费者会误判引擎忙而永不发送）", () => {
      useChatStore.setState({ phase: "completed" });

      useChatStore.getState().enqueueUserMessage("排队消息", "s1");

      expect(useChatStore.getState().phase).toBe("completed");
      expect(useChatStore.getState().queuedUserTexts).toEqual([
        { text: "排队消息" },
      ]);
    });

    it("引用随消息一起上屏、一起排队（不能在队列里丢掉）", () => {
      const quote = {
        messageId: "m1",
        senderName: "苏晚晴",
        preview: "你今天怎么没来上课？",
      };

      useChatStore.getState().enqueueUserMessage("我睡过头了", "s1", quote);

      const state = useChatStore.getState();
      expect((state.messages[0]!.message as ITextMessage).quote).toEqual(quote);
      expect(state.queuedUserTexts).toEqual([
        { text: "我睡过头了", quote },
      ]);
      expect(useChatStore.getState().shiftQueuedUserText()).toEqual({
        text: "我睡过头了",
        quote,
      });
    });

    it("addUserMessage 把引用写进消息（气泡上方要渲染引用块）", () => {
      const quote = {
        messageId: "m2",
        senderName: "我",
        preview: "那明天见",
      };

      useChatStore.getState().addUserMessage("嗯，明天见", "s1", quote);

      expect(
        (useChatStore.getState().messages[0]!.message as ITextMessage).quote,
      ).toEqual(quote);
    });
  });
});
