/**
 * @file digestRunner.test.ts
 * 后台整理的编排逻辑：触发条件、窗口锚点与游标推进。
 *
 * 重点是一条真实存在过的 bug：窗口固定取"最后 maxWindow 条"，
 * 游标却直接跳到 `messages.length`——未整理消息一旦超过窗口，
 * **中间那批会被永久跳过**（导入备份后、关掉自动整理很久再打开时最容易撞上）。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ICharacterProfile, IMessage } from "@wechat-rp/shared-types";
import { useSessionStore } from "@wechat-rp/ui-wechat";
import type { ILLMAdapter, ILLMMessage } from "@wechat-rp/core";

/** 每次整理请求收到的历史（断言"整理了哪一段"）。 */
const seenHistories: Array<ReadonlyArray<ILLMMessage>> = [];
/** 每次整理请求本身（断言输出预算之类）。 */
const seenRequests: Array<{ maxTokens: number }> = [];

/**
 * 假适配器：直接把固定 JSON 当作完整回复返回。
 * runDigest 走的是 adapter.stream(req, handlers, signal) 那条路。
 */
const DIGEST_JSON = JSON.stringify({
  memories: [
    {
      kind: "fact",
      content: "用户养了一只叫团团的猫",
      keywords: ["团团", "猫"],
      importance: 4,
    },
  ],
  events: [{ summary: "两人约好周末去看展", importance: 3 }],
  plot: { scene: "周末计划" },
});

/** 适配器与供应商配置要能在用例里改（Mock 跳过 / 坏输出），用 hoisted 共享 */
const { adapterState } = vi.hoisted(() => ({
  adapterState: {
    adapter: "openai",
    reply: "{}",
    /** 按顺序取用的回复队列（用完后一直用最后一条）；用来模拟"第一次空、第二次好" */
    replyQueue: [] as string[],
    calls: 0,
    /** ok = 正常返回；pending = 一直不返回（用来测取消）；throw = 直接抛错 */
    mode: "ok" as "ok" | "pending" | "throw",
    /** 适配器收到过几次 abort（取消链路要能看到） */
    aborts: 0,
  },
}));

vi.mock("../llmRuntime", () => ({
  getApiConfigFromStore: () => ({
    adapter: adapterState.adapter,
    baseURL: "http://localhost",
    model: "test-model",
    timeoutMs: 5000,
  }),
  getLLMAdapter: (): ILLMAdapter => ({
    stream: (req, handlers) => {
      adapterState.calls += 1;
      seenHistories.push(req.messages);
      seenRequests.push(req);
      if (adapterState.mode === "throw") {
        throw new Error("适配器直接抛错（模拟意外的空指针之类）");
      }
      if (adapterState.mode === "pending") {
        // 不主动完成：等 cancelAllDigests 把我们取消掉
        return {
          abort: () => {
            adapterState.aborts += 1;
          },
        };
      }
      const next =
        adapterState.replyQueue.length > 0
          ? adapterState.replyQueue.shift()!
          : adapterState.reply;
      handlers.onComplete(next);
      return { abort: () => {} };
    },
    testConnection: async () => ({ ok: true, latencyMs: 1 }),
  }),
}));

import {
  cancelAllDigests,
  getPendingDigestCount,
  maybeRunDigest,
  resetDigestRunnerState,
  runDigestNow,
} from "../digestRunner";

const NOW = new Date(2026, 8, 13, 15, 20, 0).getTime();
const CHAR = "char-1";
const SESSION = "s-digest";

const profile: ICharacterProfile = {
  id: CHAR,
  displayName: "林笑笑",
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

function makeSession() {
  return {
    id: SESSION,
    type: "single" as const,
    participantIds: [CHAR, "user"],
    displayName: "林笑笑",
    avatarUrl: "",
    lastMessagePreview: "",
    lastMessageTime: NOW,
    unreadCount: 0,
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** 生成 n 条交替的对话消息（内容带序号，便于断言"整理了哪一段"）。 */
function makeMessages(count: number): ReadonlyArray<IMessage> {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    type: "text" as const,
    senderId: i % 2 === 0 ? "user" : CHAR,
    recipientId: i % 2 === 0 ? CHAR : "user",
    sessionId: SESSION,
    text: `第${i}条`,
    timestamp: NOW + i * 1000,
    chunkSequence: 0,
    emotion: "neutral" as const,
    sourceOffset: 0,
  }));
}

/** 把消息塞进会话运行时快照（runner 就是从那里读的）。 */
function seedMessages(count: number): void {
  useSessionStore.getState().saveSessionRuntime(SESSION, {
    messages: makeMessages(count).map((message) => ({
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
  });
}

beforeEach(() => {
  seenHistories.length = 0;
  seenRequests.length = 0;
  adapterState.adapter = "openai";
  adapterState.reply = DIGEST_JSON;
  adapterState.replyQueue = [];
  adapterState.calls = 0;
  adapterState.mode = "ok";
  adapterState.aborts = 0;
  // 失败冷却与在途标记是模块级内存态，用例之间要清干净
  resetDigestRunnerState();
  useSessionStore.setState({
    characters: { [CHAR]: profile },
    sessions: { [SESSION]: makeSession() },
    sessionRuntimes: {},
    memories: {},
    plotStates: {},
    digestCursors: {},
    activeSessionId: SESSION,
  });
});

describe("digestRunner · 触发条件", () => {
  it("待整理条数不足阈值时不动手", async () => {
    seedMessages(10);
    expect(getPendingDigestCount(SESSION)).toBe(10);

    await expect(maybeRunDigest(SESSION)).resolves.toBe(false);
    expect(seenHistories).toHaveLength(0);
  });

  it("达到阈值时整理一次，并推进游标", async () => {
    seedMessages(25);

    await expect(maybeRunDigest(SESSION)).resolves.toBe(true);

    expect(seenHistories).toHaveLength(1);
    // 输出预算要留够：真机出现过"写到一半被截断"
    expect(seenRequests[0]!.maxTokens).toBeGreaterThanOrEqual(2048);
    expect(useSessionStore.getState().digestCursors[SESSION]).toBe(25);
    expect(getPendingDigestCount(SESSION)).toBe(0);
    // 提炼出的记忆与剧情都落库了
    expect(useSessionStore.getState().memories[CHAR]).toHaveLength(1);
    expect(
      useSessionStore.getState().plotStates[SESSION]?.events.length,
    ).toBe(1);
  });

  it("把当前状态卡一起发给模型（否则线索要么被覆盖、要么永远清不掉）", async () => {
    seedMessages(25);
    // 造一张有两条线索的状态卡
    useSessionStore.getState().setPlotState(SESSION, {
      sessionId: SESSION,
      chapter: "第二章",
      scene: "和好之后的周末",
      timeLabel: "周六下午",
      location: "市美术馆",
      relations: [{ characterId: CHAR, label: "关系缓和" }],
      openThreads: ["周六的展还没定下来", "说好要送的摄影集还没送出去"],
      synopsis: "两人和好，约了周六看展。",
      events: [],
      history: [],
      updatedAt: NOW,
    });

    await expect(maybeRunDigest(SESSION)).resolves.toBe(true);

    const userMessage = seenHistories[0]![1]!.content;
    expect(userMessage).toContain("【当前状态卡】");
    expect(userMessage).toContain("说好要送的摄影集还没送出去");
  });

  it("记一条「这次改了什么」的摘要（面板据此回答「它刚才偷偷改了什么」）", async () => {
    seedMessages(25);

    await expect(maybeRunDigest(SESSION)).resolves.toBe(true);

    const report = useSessionStore.getState().digestReports[SESSION];
    expect(report).toBeDefined();
    expect(report!.added).toBe(1); // 假适配器固定返回一条记忆
    expect(report!.events).toBe(1);
    expect(report!.replaced).toBe(0);
    expect(report!.conflicts).toBe(0);
    expect(report!.messageCount).toBe(25);
    expect(report!.at).toBeGreaterThan(0);
  });

  it("取代旧记忆时摘要里记下「取代了几条」", async () => {
    seedMessages(25);
    // 先放一条自动整理的旧记忆，再让"模型"说它被取代
    useSessionStore.getState().applyMemories(CHAR, [
      {
        id: "mem-old",
        characterId: CHAR,
        kind: "preference",
        content: "用户喜欢喝咖啡",
        keywords: ["咖啡"],
        importance: 3,
        pinned: false,
        createdAt: NOW,
        updatedAt: NOW,
        sourceMessageIds: [],
        origin: "auto",
      },
    ]);
    adapterState.reply = JSON.stringify({
      memories: [
        {
          kind: "preference",
          content: "用户戒了咖啡改喝白茶",
          keywords: ["咖啡", "白茶"],
          importance: 4,
          supersedes: "用户喜欢喝咖啡",
        },
      ],
      events: [],
    });

    await expect(maybeRunDigest(SESSION)).resolves.toBe(true);

    const report = useSessionStore.getState().digestReports[SESSION]!;
    expect(report.replaced).toBe(1);
    expect(report.added).toBe(1);
  });

  it("「立即整理」无视阈值（手动路径）", async () => {
    seedMessages(3);

    await expect(runDigestNow(SESSION)).resolves.toBe(true);
    expect(seenHistories).toHaveLength(1);
  });

  it("没有会话快照时待整理条数为 0，也不会去调模型", async () => {
    expect(getPendingDigestCount("不存在的会话")).toBe(0);
    await expect(runDigestNow("不存在的会话")).resolves.toBe(false);
    expect(adapterState.calls).toBe(0);
  });

  it("Mock 供应商直接跳过（它产不出可解析的 JSON）", async () => {
    seedMessages(30);
    adapterState.adapter = "mock";

    await expect(runDigestNow(SESSION)).resolves.toBe(false);
    expect(adapterState.calls).toBe(0);
    // 游标不动：等以后换成真模型还能补上
    expect(useSessionStore.getState().digestCursors[SESSION] ?? 0).toBe(0);
  });

  it("模型输出坏 JSON 时记一次失败，并在冷却期内不再打扰模型", async () => {
    seedMessages(30);
    // 两次都回坏内容：重试用完才认输，不该无限重试
    adapterState.replyQueue = [
      "这不是 JSON，我只是随便说句话",
      "还是不是 JSON，我又随便说了一句",
    ];

    await expect(maybeRunDigest(SESSION)).resolves.toBe(false);
    expect(adapterState.calls).toBe(2);
    expect(useSessionStore.getState().digestCursors[SESSION] ?? 0).toBe(0);

    // 冷却期内再触发：不再调用模型（省 token，也避免每次发消息都重试）
    await expect(maybeRunDigest(SESSION)).resolves.toBe(false);
    expect(adapterState.calls).toBe(2);
  });

  it("模型偶发返回空内容时立刻重试一次，整段记忆不会白丢", async () => {
    seedMessages(30);
    // 真机实测：agnes 偶发返回空内容（3 次里就能撞到 1 次）
    adapterState.replyQueue = ["", DIGEST_JSON];

    await expect(maybeRunDigest(SESSION)).resolves.toBe(true);

    expect(adapterState.calls).toBe(2);
    expect(useSessionStore.getState().digestCursors[SESSION]).toBe(30);
    expect(useSessionStore.getState().memories[CHAR]).toHaveLength(1);
  });

  it("网络类失败不立刻重试（避免等待翻倍），只算一次失败", async () => {
    seedMessages(30);
    adapterState.mode = "throw";

    await expect(maybeRunDigest(SESSION)).resolves.toBe(false);
    expect(adapterState.calls).toBe(1);
  });

  it("适配器意外抛错时不崩：算一次失败，游标不动", async () => {
    seedMessages(30);
    adapterState.mode = "throw";

    await expect(maybeRunDigest(SESSION)).resolves.toBe(false);
    expect(useSessionStore.getState().digestCursors[SESSION] ?? 0).toBe(0);
    expect(useSessionStore.getState().memories[CHAR] ?? []).toHaveLength(0);
  });

  it("落库环节失败时也不崩：游标不推进，下次还能重来", async () => {
    seedMessages(30);
    const original = useSessionStore.getState().applyMemories;
    // 模拟"存储写失败"（写满、事务中断之类）
    useSessionStore.setState({
      applyMemories: () => {
        throw new Error("存储写入失败");
      },
    });

    try {
      await expect(maybeRunDigest(SESSION)).resolves.toBe(false);
      expect(useSessionStore.getState().digestCursors[SESSION] ?? 0).toBe(0);
    } finally {
      useSessionStore.setState({ applyMemories: original });
    }

    // 恢复后照样能整理成功
    await expect(runDigestNow(SESSION)).resolves.toBe(true);
    expect(useSessionStore.getState().digestCursors[SESSION]).toBe(30);
  });

  it("页面卸载时取消在途整理：请求被中止，游标不推进", async () => {
    seedMessages(30);
    adapterState.mode = "pending";

    const pending = maybeRunDigest(SESSION);
    await vi.waitFor(() => expect(adapterState.calls).toBe(1));

    cancelAllDigests();

    await expect(pending).resolves.toBe(false);
    // 取消链路真的传到了适配器
    expect(adapterState.aborts).toBeGreaterThanOrEqual(1);
    expect(useSessionStore.getState().digestCursors[SESSION] ?? 0).toBe(0);
    // 游标没动，所以下次还会重来；这里用 force 绕开失败冷却确认链路完好
    adapterState.mode = "ok";
    await expect(runDigestNow(SESSION)).resolves.toBe(true);
    expect(useSessionStore.getState().digestCursors[SESSION]).toBe(30);
  });
});

describe("digestRunner · 积压时分批整理（回归）", () => {
  it("未整理消息超过窗口时按窗口分批，一条都不跳过", async () => {
    // 100 条积压、窗口 60：旧实现会把游标直接推到 100，
    // 于是第 0~39 条永远不整理（而界面上显示"已整理完"）
    seedMessages(100);
    useSessionStore.setState({
      digestConfig: {
        enabled: true,
        threshold: 20,
        maxWindow: 60,
        maxInject: 10,
        maxEvents: 100,
        maxHistory: 5,
      },
    });

    await expect(maybeRunDigest(SESSION)).resolves.toBe(true);
    // 第一次只吃窗口内的 60 条，游标停在那里
    expect(useSessionStore.getState().digestCursors[SESSION]).toBe(60);
    expect(getPendingDigestCount(SESSION)).toBe(40);
    const firstHistory = seenHistories[0]!.map((m) => m.content).join("\n");
    expect(firstHistory).toContain("第0条");
    expect(firstHistory).not.toContain("第99条");

    // 再跑一次，把剩下的 40 条整理完
    await expect(maybeRunDigest(SESSION)).resolves.toBe(true);
    expect(useSessionStore.getState().digestCursors[SESSION]).toBe(100);
    expect(getPendingDigestCount(SESSION)).toBe(0);
    const secondHistory = seenHistories[1]!.map((m) => m.content).join("\n");
    // 第二次从第 61 条附近接上，并带几条上文当上下文
    expect(secondHistory).toContain("第99条");
    expect(secondHistory).toContain("第60条");
  });

  it("窗口内全是系统消息时只跳过这一段，后面的内容照常整理", async () => {
    const system: IMessage = {
      id: "sys-1",
      type: "system",
      senderId: "system",
      recipientId: "user",
      sessionId: SESSION,
      timestamp: NOW,
      chunkSequence: 0,
      emotion: "neutral",
      systemKind: "time-divider",
      displayText: "昨天 20:00",
    };
    // 窗口设成 1 条：第一次只看得到那条系统消息，第二次才轮到真正的对话
    useSessionStore.setState({
      digestConfig: {
        enabled: true,
        threshold: 20,
        maxWindow: 1,
        maxInject: 10,
        maxEvents: 100,
        maxHistory: 5,
      },
    });
    useSessionStore.getState().saveSessionRuntime(SESSION, {
      messages: [
        { message: system, revealed: true, pending: false },
        ...makeMessages(1).map((message) => ({
          message,
          revealed: true,
          pending: false,
        })),
      ],
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
    });

    // 第一条只有系统消息：这一次没有可整理的内容，但游标只前进到 1
    await expect(runDigestNow(SESSION)).resolves.toBe(false);
    expect(seenHistories).toHaveLength(0);
    expect(useSessionStore.getState().digestCursors[SESSION]).toBe(1);

    // 再跑一次：那条真正的对话照样被整理到（没有被当成"整段都整理完了"吞掉）
    await expect(runDigestNow(SESSION)).resolves.toBe(true);
    expect(seenHistories).toHaveLength(1);
    expect(useSessionStore.getState().digestCursors[SESSION]).toBe(2);
  });
});
