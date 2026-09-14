/**
 * @file RealismEngine.test.ts
 * RealismEngine 集成测试：mock adapter 验证事件序列。
 *
 * 使用 vi.useFakeTimers() 控制定时器，保证测试确定性。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RealismEngine } from "../RealismEngine";
import { createMockAdapter } from "../llm/MockAdapter";
import type { IConnectionTestResult, ILLMAdapter } from "../llm/LLMAdapter";
import type { ILLMAbortHandle, ILLMConfigInternal, ILLMRequest } from "../llm/types";
import { LLMError } from "../llm/types";
import type {
  ICharacterProfile,
  ICharRevealPlanEvent,
  IChunkDeliveredEvent,
  IMemory,
  ILlmStreamHandlers,
  ISimulationConfig,
} from "@wechat-rp/shared-types";
import type { IRealismEngineOutput } from "@wechat-rp/shared-types";
import type { IEngineSubscription } from "@wechat-rp/shared-types";

/**
 * 宿主时区。
 *
 * 本文件多处用**本地时间**造假时刻（`new Date(2026, 8, 13, 10, 0, 0)`），
 * 档案时区必须跟着宿主走：写死 "Asia/Shanghai" 的话，在 UTC 的 CI 上
 * "本地凌晨 2 点"对应上海上午 10 点，睡眠策略的用例就全废了。
 */
const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 捕获请求的假适配器（断言 Prompt 注入用）。 */
class CapturingAdapter implements ILLMAdapter {
  public lastRequest: ILLMRequest | null = null;

  public stream(
    req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    _signal: AbortSignal,
  ): ILLMAbortHandle {
    this.lastRequest = req;
    handlers.onComplete("好的。");
    return { abort: () => {} };
  }

  public async testConnection(): Promise<IConnectionTestResult> {
    return { ok: true, latencyMs: 1 };
  }
}

/**
 * 脚本化适配器：按给定分片同步推送 delta，再以完整文本结束。
 * 用于复现"回复以标点结尾"等流结束边界。
 */
class ScriptedAdapter implements ILLMAdapter {
  constructor(private readonly deltas: ReadonlyArray<string>) {}

  public stream(
    _req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    _signal: AbortSignal,
  ): ILLMAbortHandle {
    for (const delta of this.deltas) {
      handlers.onDelta(delta);
    }
    handlers.onComplete(this.deltas.join(""));
    return { abort: () => {} };
  }

  public async testConnection(): Promise<IConnectionTestResult> {
    return { ok: true, latencyMs: 1 };
  }
}

/**
 * 立即以 aborted 错误结束的适配器。
 * 用于复现"底层超时/外部中止被归类为 aborted"时的收尾路径。
 */
class AbortedErrorAdapter implements ILLMAdapter {
  public stream(
    _req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    _signal: AbortSignal,
  ): ILLMAbortHandle {
    handlers.onError(new LLMError("Stream aborted", "aborted", undefined, false));
    return { abort: () => {} };
  }

  public async testConnection(): Promise<IConnectionTestResult> {
    return { ok: true, latencyMs: 1 };
  }
}

/**
 * 空回复适配器：前 N 次"成功"但正文为空，用来验证空回复重试。
 * 第 N+1 次开始返回正常内容。
 */
class EmptyThenOkAdapter implements ILLMAdapter {
  public calls = 0;

  constructor(private readonly emptyTimes = Infinity) {}

  public stream(
    _req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    _signal: AbortSignal,
  ): ILLMAbortHandle {
    this.calls += 1;
    if (this.calls <= this.emptyTimes) {
      handlers.onComplete("");
      return { abort: () => {} };
    }
    handlers.onDelta("在的。");
    handlers.onComplete("在的。");
    return { abort: () => {} };
  }

  public async testConnection(): Promise<IConnectionTestResult> {
    return { ok: true, latencyMs: 1 };
  }
}

/**
 * 先流一段正文、再以失败结束的适配器。
 * `deltaStarted: true` 让 LLMError 判定为不可重试，复现"流到一半断掉"。
 */
class PartialThenErrorAdapter implements ILLMAdapter {
  constructor(
    private readonly deltas: ReadonlyArray<string>,
    private readonly reason: string,
  ) {}

  public stream(
    _req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    _signal: AbortSignal,
  ): ILLMAbortHandle {
    for (const delta of this.deltas) {
      handlers.onDelta(delta);
    }
    handlers.onError(new LLMError(this.reason, "server-error", 500, true));
    return { abort: () => {} };
  }

  public async testConnection(): Promise<IConnectionTestResult> {
    return { ok: true, latencyMs: 1 };
  }
}

/** Mock 适配器用的最小 config。 */
const mockLLMConfig: ILLMConfigInternal = {
  baseURL: "http://localhost",
  apiKey: "test-key",
  model: "test-model",
  timeoutMs: 30000,
  maxRetries: 3,
  temperature: 0.8,
  maxTokens: 100,
};

const mockProfile: ICharacterProfile = {
  id: "char-1",
  displayName: "测试角色",
  bio: "测试用",
  visualMetadata: {
    avatarUrl: "",
    sprites: [],
    supportsPinSprite: false,
    defaultSpriteAnchor: "left",
  },
  schedule: {
    wakeTime: "07:00",
    sleepTime: "23:00",
    scheduleEnabled: false,
    timezone: HOST_ZONE,
    sleepReplyPolicy: "next-day-queue",
  },
  personalityTraits: {
    archetype: "gentle",
    typingSpeedMultiplier: 1.0,
    fragmentationBias: 0.3,
    hesitationProbability: 0,
    typoRate: 0,
    stickerFrequency: 0,
  },
  promptTemplateId: "test",
};

const mockConfig: ISimulationConfig = {
  realismEnabled: true,
  typingSpeedCpm: "turbo", // 快速打字，减少等待
  hesitationProbability: 0,
  typoRate: 0,
  fragmentationThresholdChars: 24,
  scheduleAwarenessEnabled: false,
  typingIndicatorEnabled: true,
  typoAutoCorrectEnabled: true,
  maxInterChunkDelayMs: 100,
};

function createEngine(configOverride?: Partial<ISimulationConfig>): RealismEngine {
  return new RealismEngine({
    profile: mockProfile,
    config: { ...mockConfig, ...configOverride },
    sessionId: "test-sess",
    userId: "user-1",
  });
}

function collectEvents(engine: RealismEngine): {
  events: IRealismEngineOutput[];
  sub: IEngineSubscription;
} {
  const events: IRealismEngineOutput[] = [];
  const sub = engine.subscribe((output) => {
    events.push(output);
  });
  return { events, sub };
}

describe("RealismEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribe() 返回有效订阅句柄", () => {
    const engine = createEngine();
    const sub = engine.subscribe(() => {});

    expect(sub).toBeDefined();
    expect(sub.closed).toBe(false);
    sub.unsubscribe();
    expect(sub.closed).toBe(true);
  });

  it("startStream() 非 realismEnabled 模式秒回", () => {
    const engine = createEngine({ realismEnabled: false });
    const { events } = collectEvents(engine);

    const handlers = engine.startStream("你好");
    handlers.onComplete("这是完整回复。");

    // 秒回模式：chunk-delivered + lifecycle completed
    const kinds = events.map((e) => e.event.kind);
    expect(kinds).toContain("lifecycle");
    expect(kinds).toContain("chunk-delivered");

    const lifecycle = events.filter((e) => e.event.kind === "lifecycle");
    expect(lifecycle[lifecycle.length - 1]!.event).toMatchObject({
      kind: "lifecycle",
      phase: "completed",
    });
  });

  it("startStreamWithAdapter() 用 mock adapter 完成一次流", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    const adapter = createMockAdapter({ config: mockLLMConfig, tokenIntervalMs: 10 });

    const started = engine.startStreamWithAdapter("你好", adapter);
    expect(started).toBe(true);

    // 推进 mock adapter 的 token 生成
    vi.advanceTimersByTime(500);

    // 应收到 lifecycle started + chunk-delivered 事件
    const kinds = events.map((e) => e.event.kind);
    expect(kinds).toContain("lifecycle");
  });

  it("startStreamWithAdapter() silent 策略下不启动 LLM", () => {
    // 构造睡眠时段的 profile
    const sleepingProfile: ICharacterProfile = {
      ...mockProfile,
      schedule: {
        wakeTime: "07:00",
        sleepTime: "23:00",
        scheduleEnabled: true,
        timezone: HOST_ZONE,
        sleepReplyPolicy: "silent",
      },
    };
    const engine = new RealismEngine({
      profile: sleepingProfile,
      config: { ...mockConfig, scheduleAwarenessEnabled: true },
      sessionId: "test-sess",
      userId: "user-1",
    });
    const { events } = collectEvents(engine);
    const adapter = createMockAdapter({ config: mockLLMConfig, tokenIntervalMs: 10 });

    // 当前时间设为凌晨 2 点
    vi.setSystemTime(new Date().setHours(2, 0, 0, 0));

    const started = engine.startStreamWithAdapter("你好", adapter);
    expect(started).toBe(false);

    // 应推送 presence + lifecycle completed，但不调用 LLM
    const kinds = events.map((e) => e.event.kind);
    expect(kinds).toContain("presence");
    expect(kinds).toContain("lifecycle");

    const lifecycle = events.find(
      (e) => e.event.kind === "lifecycle" && (e.event as { phase: string }).phase === "completed",
    );
    expect(lifecycle).toBeDefined();
  });

  it("startStream() 重复调用抛错", () => {
    const engine = createEngine();
    engine.startStream("第一条");

    expect(() => engine.startStream("第二条")).toThrow("stream already in progress");
  });

  it("abort() 推送 aborted 生命周期事件", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);

    engine.startStream("你好");
    engine.abort("test-abort");

    const lifecycleEvents = events
      .map((e) => e.event)
      .filter((e) => e.kind === "lifecycle");
    const aborted = lifecycleEvents.find((e) => (e as { phase: string }).phase === "aborted");
    expect(aborted).toBeDefined();
  });

  it("updateConfig() 更新引擎配置", () => {
    const engine = createEngine({ typingSpeedCpm: "slow" });

    // 更新配置不应报错
    expect(() => engine.updateConfig({ typingSpeedCpm: "fast" })).not.toThrow();
  });

  it("setLLMConfig() 设置 LLM 配置", () => {
    const engine = createEngine();

    expect(() =>
      engine.setLLMConfig({
        adapter: "mock",
        baseURL: "http://localhost",
        model: "test-model",
        timeoutMs: 5000,
        maxRetries: 1,
        temperature: 0.5,
        maxTokens: 100,
      }),
    ).not.toThrow();
  });

  it("setMessageHistory() 更新消息历史", () => {
    const engine = createEngine();

    expect(() =>
      engine.setMessageHistory([{ role: "user", content: "历史消息" }]),
    ).not.toThrow();
  });

  it("startStreamWithAdapter() mock adapter 报错时触发 fallback", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);

    const adapter = createMockAdapter({
      config: mockLLMConfig,
      tokenIntervalMs: 10,
      simulateError: { type: "server-error", atAttempt: 1 },
    });

    engine.setLLMConfig({
      adapter: "mock",
      baseURL: "http://localhost",
      model: "test",
      timeoutMs: 30000,
      maxRetries: 0, // 不重试，直接触发 fallback
      temperature: 0.8,
      maxTokens: 100,
    });

    const started = engine.startStreamWithAdapter("你好", adapter);
    expect(started).toBe(true);

    // 推进时间让 mock adapter 的错误（100ms 后）和 fallback 完成
    vi.advanceTimersByTime(500);

    // 应推送 error 事件（fallback 触发）
    const errorEvents = events.filter((e) => e.event.kind === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);

    // fallback 后应推送 chunk-delivered（秒回短句）
    const chunkEvents = events.filter((e) => e.event.kind === "chunk-delivered");
    expect(chunkEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("mock adapter 正常流式后推送 chunk-delivered", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    const adapter = createMockAdapter({ config: mockLLMConfig, tokenIntervalMs: 5 });

    engine.startStreamWithAdapter("测试消息", adapter);

    // 推进足够时间让 mock adapter 完成所有 token 输出
    vi.advanceTimersByTime(2000);

    const chunkEvents = events.filter((e) => e.event.kind === "chunk-delivered");
    // turbo 模式下应该至少有一个 chunk delivered
    expect(chunkEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("setPromptTemplate()/setMemories()/setPlotSummary() 注入到 LLM 请求", () => {
    const engine = createEngine();
    const adapter = new CapturingAdapter();

    const memory: IMemory = {
      id: "mem-1",
      characterId: "char-1",
      kind: "preference",
      content: "用户喜欢猫",
      keywords: ["猫"],
      importance: 4,
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceMessageIds: [],
    };

    engine.setMessageHistory([{ role: "user", content: "历史消息" }]);
    engine.setPromptTemplate({
      id: "tpl-1",
      name: "测试模板",
      worldSetting: "现代都市",
    });
    engine.setMemories([memory]);
    engine.setPlotSummary("【当前剧情】\n章节：第一章");

    engine.startStreamWithAdapter("你好", adapter);

    const req = adapter.lastRequest;
    expect(req).not.toBeNull();

    const systemMsgs = req!.messages.filter((m) => m.role === "system");
    // 人设模板在开头 system
    expect(systemMsgs[0]!.content).toContain("现代都市");
    // 记忆与剧情在末尾 system（紧贴当前提问，长上下文下影响更大）
    expect(systemMsgs).toHaveLength(2);
    const dynamic = systemMsgs[1]!.content;
    expect(dynamic).toContain("【你记得的事】");
    expect(dynamic).toContain("用户喜欢猫");
    expect(dynamic).toContain("【当前剧情】");

    // 历史消息作为独立消息进入请求，且排在动态注入之前
    const historyIdx = req!.messages.findIndex((m) => m.content === "历史消息");
    const dynamicIdx = req!.messages.indexOf(systemMsgs[1]!);
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    expect(dynamicIdx).toBeGreaterThan(historyIdx);
    // 当前用户消息永远是最后一条
    expect(req!.messages[req!.messages.length - 1]!.content).toBe("你好");
  });

  it("setLastMessageAt() 让模型知道上一句隔了多久（不注入时这段不出现）", () => {
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    const engine = createEngine();
    const adapter = new CapturingAdapter();

    engine.setMessageHistory([{ role: "user", content: "上次说的事我想好了" }]);
    engine.setLastMessageAt(Date.now() - threeDays);

    engine.startStreamWithAdapter("在吗", adapter);

    const head = adapter.lastRequest!.messages[0]!.content;
    // 开头 system 里既有"现在几点"，也有"上一句隔了多久"
    expect(head).toContain("【现在】");
    expect(head).toContain("【上一句】你们上一次说话是 3 天前");

    // 没有历史（不注入）时不该凭空写出这一段
    const fresh = createEngine();
    const freshAdapter = new CapturingAdapter();
    fresh.startStreamWithAdapter("在吗", freshAdapter);
    expect(freshAdapter.lastRequest!.messages[0]!.content).not.toContain(
      "【上一句】",
    );
    // 但"现在"是每轮都要有的
    expect(freshAdapter.lastRequest!.messages[0]!.content).toContain("【现在】");
  });

  it("构造请求时推送 context-usage 事件（界面据此显示「钱花在哪」）", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    const adapter = new CapturingAdapter();

    const memory: IMemory = {
      id: "mem-usage",
      characterId: "char-1",
      kind: "fact",
      content: "用户对花生过敏",
      keywords: ["花生"],
      importance: 5,
      pinned: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceMessageIds: [],
    };
    engine.setMessageHistory([{ role: "user", content: "在吗" }]);
    engine.setMemories([memory]);
    engine.setPlotSummary("【当前剧情】\n章节：第一章");

    engine.startStreamWithAdapter("晚上吃什么", adapter);

    const usageEvent = events
      .map((e) => e.event)
      .find((e) => e.kind === "context-usage");
    expect(usageEvent).toBeDefined();
    if (usageEvent?.kind !== "context-usage") return;

    expect(usageEvent.usage.chars.memory).toBeGreaterThan(0);
    expect(usageEvent.usage.chars.plot).toBeGreaterThan(0);
    expect(usageEvent.usage.chars.history).toBe("在吗".length);
    expect(usageEvent.usage.messageCount).toBeGreaterThan(0);
    expect(usageEvent.usage.estimatedTokens).toBeGreaterThan(0);
    expect(usageEvent.usage.trimmed).toBe(false);
  });

  it("模型按约定在首行标情绪时：整轮用该情绪，且标签不会出现在消息里", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    // 分片刻意把 "happy" 切开，模拟流式分片
    const adapter = new ScriptedAdapter([
      "happ",
      "y\n面条？",
      "要不还是吃饺子吧。",
    ]);

    engine.startStreamWithAdapter("晚上吃什么", adapter);
    vi.advanceTimersByTime(12000);

    const delivered = events
      .map((e) => e.event)
      .filter((e): e is IChunkDeliveredEvent => e.kind === "chunk-delivered");
    const text = delivered
      .map((e) => (e.message.type === "text" ? e.message.text : ""))
      .join("");

    expect(text).toContain("面条");
    // 标签行不能漏进消息
    expect(text).not.toContain("happy");
    // 整轮都用模型标的情绪
    expect(delivered.length).toBeGreaterThan(0);
    expect(
      delivered.every((e) => e.message.emotion === "happy"),
    ).toBe(true);
  });

  it("标签前先来一个换行也不会漏（真机踩到的坑）", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    // 真实流里模型常常先单独吐一个换行，再写情绪词
    const adapter = new ScriptedAdapter([
      "\n",
      "happy",
      "\n太棒了，恭喜你！",
      "姐姐为你开心。",
    ]);

    engine.startStreamWithAdapter("我升职了", adapter);
    vi.advanceTimersByTime(12000);

    const delivered = events
      .map((e) => e.event)
      .filter((e): e is IChunkDeliveredEvent => e.kind === "chunk-delivered");
    const text = delivered
      .map((e) => (e.message.type === "text" ? e.message.text : ""))
      .join("");

    expect(text).not.toContain("happy");
    expect(text).toContain("太棒了");
    expect(delivered.every((e) => e.message.emotion === "happy")).toBe(true);
  });

  it("模型没按约定标情绪时，正文一字不少且退回关键词推断", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    const adapter = new ScriptedAdapter(["唉，", "我今天真的有点难过。"]);

    engine.startStreamWithAdapter("怎么了", adapter);
    vi.advanceTimersByTime(12000);

    const delivered = events
      .map((e) => e.event)
      .filter((e): e is IChunkDeliveredEvent => e.kind === "chunk-delivered");
    const text = delivered
      .map((e) => (e.message.type === "text" ? e.message.text : ""))
      .join("");

    expect(text).toContain("唉");
    expect(text).toContain("难过");
    expect(delivered.some((e) => e.message.emotion === "sad")).toBe(true);
  });

  it("回复以标点结尾（残余 buffer 为空）时也必须发出 completed", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    // 两个分片都以标点结尾：push 阶段全部切分完，complete 时 buffer 为空
    const adapter = new ScriptedAdapter(["好，", "我知道了。"]);

    engine.startStreamWithAdapter("你好", adapter);
    vi.advanceTimersByTime(5000);

    const phases = events
      .map((e) => e.event)
      .filter((e) => e.kind === "lifecycle")
      .map((e) => (e as { phase: string }).phase);
    expect(phases.filter((p) => p === "completed")).toHaveLength(1);

    // completed 必须晚于最后一条消息交付
    const kinds = events.map((e) => e.event.kind);
    const lastDeliveredIdx = kinds.lastIndexOf("chunk-delivered");
    const completedIdx = events.findIndex(
      (e) =>
        e.event.kind === "lifecycle" &&
        (e.event as { phase: string }).phase === "completed",
    );
    expect(lastDeliveredIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(lastDeliveredIdx);
  });

  it("回复无标点结尾时同样只发出一次 completed", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    const adapter = new ScriptedAdapter(["好，", "我知道"]);

    engine.startStreamWithAdapter("你好", adapter);
    vi.advanceTimersByTime(5000);

    const phases = events
      .map((e) => e.event)
      .filter((e) => e.kind === "lifecycle")
      .map((e) => (e as { phase: string }).phase);
    expect(phases.filter((p) => p === "completed")).toHaveLength(1);
  });

  it("空回复（无任何 chunk）也必须结束 run，不悬挂在 streaming", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    const adapter = new ScriptedAdapter([]);

    engine.startStreamWithAdapter("你好", adapter);
    // 空回复会先自动重试（400/800/1600ms 退避），重试耗尽后才收尾
    vi.advanceTimersByTime(20000);

    const phases = events
      .map((e) => e.event)
      .filter((e) => e.kind === "lifecycle")
      .map((e) => (e as { phase: string }).phase);
    expect(phases.filter((p) => p === "completed")).toHaveLength(1);

    // run 结束后必须允许立即开始下一轮（不应抛 "stream already in progress"）
    expect(() => engine.startStream("下一轮")).not.toThrow();
  });

  it("空回复会先自动重试，重试成功后正常交付（不再静默无响应）", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    const adapter = new EmptyThenOkAdapter(1);

    engine.startStreamWithAdapter("在吗", adapter);
    vi.advanceTimersByTime(10000);

    // 第一次空 → 重试一次成功
    expect(adapter.calls).toBe(2);

    const delivered = events
      .map((e) => e.event)
      .filter((e): e is IChunkDeliveredEvent => e.kind === "chunk-delivered");
    const text = delivered
      .map((e) => (e.message.type === "text" ? e.message.text : ""))
      .join("");
    expect(text).toContain("在的。");

    // 没有冒出"空回复"错误
    const errors = events
      .map((e) => e.event)
      .filter((e) => e.kind === "error");
    expect(errors.some((e) => e.code === "llm-empty-reply")).toBe(false);
  });

  it("重试后仍为空则报可重试错误并收尾（用户能看到重试入口）", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    const adapter = new EmptyThenOkAdapter(Infinity);

    engine.startStreamWithAdapter("在吗", adapter);
    vi.advanceTimersByTime(20000);

    // 首发 + maxRetries(3) 次重试
    expect(adapter.calls).toBe(4);

    const errors = events
      .map((e) => e.event)
      .filter((e) => e.kind === "error");
    const emptyError = errors.find((e) => e.code === "llm-empty-reply");
    expect(emptyError).toBeDefined();
    expect(emptyError?.recoverable).toBe(true);

    const phases = events
      .map((e) => e.event)
      .filter((e) => e.kind === "lifecycle")
      .map((e) => (e as { phase: string }).phase);
    expect(phases.filter((p) => p === "completed")).toHaveLength(1);
  });

  it("已交付部分正文后中断：保留正文、不追加罐头短句", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    // 先流一段正文，再抛一个不可重试的服务器错误
    const adapter = new PartialThenErrorAdapter(["晚", "上好呀，"], "server down");

    engine.startStreamWithAdapter("在吗", adapter);
    vi.advanceTimersByTime(10000);

    const deliveredText = events
      .map((e) => e.event)
      .filter((e): e is IChunkDeliveredEvent => e.kind === "chunk-delivered")
      .map((e) => (e.message.type === "text" ? e.message.text : ""))
      .join("");
    expect(deliveredText).toContain("晚上好呀");

    // 关键：不能出现 fallback 的罐头短句
    const errors = events.map((e) => e.event).filter((e) => e.kind === "error");
    expect(errors.some((e) => e.code === "llm-fallback-triggered")).toBe(false);
    // 但要给出可重试的中断提示
    const broken = errors.find((e) => e.code === "llm-stream-broken");
    expect(broken?.recoverable).toBe(true);

    const phases = events
      .map((e) => e.event)
      .filter((e) => e.kind === "lifecycle")
      .map((e) => (e as { phase: string }).phase);
    expect(phases.filter((p) => p === "completed")).toHaveLength(1);
  });

  it("回复里的情绪线索落到气泡上（立绘据此切换）", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    // 分片里带明显的情绪线索
    const adapter = new ScriptedAdapter(["哈哈，", "太好了，今天真开心！"]);

    engine.startStreamWithAdapter("今天怎么样", adapter);
    vi.advanceTimersByTime(10000);

    const emotions = events
      .map((e) => e.event)
      .filter((e): e is IChunkDeliveredEvent => e.kind === "chunk-delivered")
      .map((e) => e.message.emotion);

    expect(emotions.length).toBeGreaterThan(0);
    // 至少有一个气泡被标成开心（此前永远是 neutral）
    expect(emotions).toContain("happy");
  });

  it("低落的回复会被标成难过（情绪不是写死的）", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    const adapter = new ScriptedAdapter(["唉，", "我今天真的有点难过。"]);

    engine.startStreamWithAdapter("怎么了", adapter);
    vi.advanceTimersByTime(10000);

    const emotions = events
      .map((e) => e.event)
      .filter((e): e is IChunkDeliveredEvent => e.kind === "chunk-delivered")
      .map((e) => e.message.emotion);

    expect(emotions).toContain("sad");
  });

  it("char-reveal-plan 携带逐字时间轴（打字机动画生效）", () => {
    const engine = createEngine({ typoRate: 0 });
    const { events } = collectEvents(engine);
    const adapter = new ScriptedAdapter(["你好，", "我是苏晚晴。"]);

    engine.startStreamWithAdapter("在吗", adapter);
    vi.advanceTimersByTime(8000);

    const revealPlans = events
      .map((e) => e.event)
      .filter((e): e is ICharRevealPlanEvent => e.kind === "char-reveal-plan");
    const delivered = events
      .map((e) => e.event)
      .filter((e): e is IChunkDeliveredEvent => e.kind === "chunk-delivered");

    expect(revealPlans.length).toBeGreaterThanOrEqual(2);
    expect(delivered.length).toBe(revealPlans.length);

    // 时间轴长度与交付文本一致，且严格递增（逐字揭示）
    const firstPlan = revealPlans[0]!;
    const firstMessage = delivered[0]!.message;
    expect(firstPlan.revealDelays.length).toBe(
      firstMessage.type === "text" ? firstMessage.text.length : 0,
    );
    expect(firstPlan.revealDelays.length).toBeGreaterThan(0);
    for (let i = 1; i < firstPlan.revealDelays.length; i += 1) {
      expect(firstPlan.revealDelays[i]!).toBeGreaterThan(
        firstPlan.revealDelays[i - 1]!,
      );
    }
  });

  it("错别字：交付错字版本，并提供纠正时间点与正确文本", () => {
    // typoRate=1 必定注入（文本长度需 > 4）
    const engine = createEngine({ typoRate: 1 });
    const { events } = collectEvents(engine);
    const adapter = new ScriptedAdapter(["我在这里等你。"]);

    engine.startStreamWithAdapter("在吗", adapter);
    vi.advanceTimersByTime(8000);

    const plan = events
      .map((e) => e.event)
      .find((e): e is ICharRevealPlanEvent => e.kind === "char-reveal-plan");
    const delivered = events
      .map((e) => e.event)
      .find((e): e is IChunkDeliveredEvent => e.kind === "chunk-delivered");

    expect(plan).toBeDefined();
    expect(delivered).toBeDefined();
    expect(plan!.containsTypo).toBe(true);
    expect(plan!.correctedText).toBe("我在这里等你。");
    expect(plan!.typoCorrectAtMs).toBeGreaterThan(0);

    const message = delivered!.message;
    expect(message.type).toBe("text");
    if (message.type === "text") {
      // 交付的是错字版本
      expect(message.text).toBe("我再这里等你。");
    }
  });

  it("底层中止（非用户触发）也必须收尾，不能悬挂在 streaming", () => {
    const engine = createEngine();
    const { events } = collectEvents(engine);
    // 模拟"超时/外部信号导致的 aborted"：引擎并未调用 abort()
    const adapter = new AbortedErrorAdapter();

    engine.startStreamWithAdapter("你好", adapter);
    vi.advanceTimersByTime(5000);

    const phases = events
      .map((e) => e.event)
      .filter((e) => e.kind === "lifecycle")
      .map((e) => (e as { phase: string }).phase);
    expect(phases).toContain("completed");

    // 应走降级路径交付短句，而不是静默挂起
    const delivered = events.filter((e) => e.event.kind === "chunk-delivered");
    expect(delivered.length).toBeGreaterThanOrEqual(1);

    // 收尾后应能立刻开始下一轮
    expect(() => engine.startStream("下一轮")).not.toThrow();
  });
});
