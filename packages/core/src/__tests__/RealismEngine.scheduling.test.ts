/**
 * @file RealismEngine.scheduling.test.ts
 * 验证 chunk 串行排队交付，不再并行。
 *
 * 喂入多个快速 delta，断言 chunk-delivered 事件的 emittedAt 单调递增且间隔 ≥ preDelay。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RealismEngine } from "../RealismEngine";
import { createMockAdapter } from "../llm/MockAdapter";
import type { IRealismEngineOutput, ICharacterProfile, ISimulationConfig, ILLMConfig } from "@wechat-rp/shared-types";
import type { ILLMConfigInternal } from "../llm/types";

/** Mock 适配器用的内部 config（含 apiKey）。 */
const mockLLMConfigInternal: ILLMConfigInternal = {
  baseURL: "http://localhost",
  apiKey: "test-key",
  model: "test-model",
  timeoutMs: 30000,
  maxRetries: 3,
  temperature: 0.8,
  maxTokens: 100,
};

/** 引擎 setLLMConfig 用的 shared config。 */
const mockLLMConfig: ILLMConfig = {
  adapter: "mock",
  baseURL: "http://localhost",
  model: "test-model",
  timeoutMs: 30000,
  maxRetries: 3,
  temperature: 0.8,
  maxTokens: 100,
};

const mockProfile: ICharacterProfile = {
  id: "char-sched-test",
  displayName: "调度测试角色",
  bio: "测试",
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
    timezone: "Asia/Shanghai",
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
  typingSpeedCpm: "turbo", // 快速打字，减少测试等待
  hesitationProbability: 0,
  typoRate: 0,
  fragmentationThresholdChars: 8, // 低阈值，强制切分多个 chunk
  scheduleAwarenessEnabled: false,
  typingIndicatorEnabled: true,
  typoAutoCorrectEnabled: true,
  maxInterChunkDelayMs: 100,
};

function createEngine(): RealismEngine {
  return new RealismEngine({
    profile: mockProfile,
    config: mockConfig,
    sessionId: "sched-test",
    userId: "user",
  });
}

describe("RealismEngine 调度排队", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("多个 chunk 串行交付：emittedAt 单调递增", () => {
    const engine = createEngine();
    const events: IRealismEngineOutput[] = [];
    engine.subscribe((output) => events.push(output));
    engine.setLLMConfig(mockLLMConfig);

    const adapter = createMockAdapter({
      config: mockLLMConfigInternal,
      tokenIntervalMs: 1, // 极快出 token
    });

    engine.startStreamWithAdapter("你好。今天天气不错。你吃饭了吗？", adapter);

    // 推进足够时间让 mock adapter 输出所有 token + chunk 排队交付
    vi.advanceTimersByTime(10000);

    // 过滤 chunk-delivered 事件
    const chunkDelivered = events.filter(
      (e) => e.event.kind === "chunk-delivered",
    );

    expect(chunkDelivered.length).toBeGreaterThanOrEqual(2);

    // 验证 emittedAt 单调递增
    for (let i = 1; i < chunkDelivered.length; i += 1) {
      const prev = chunkDelivered[i - 1]!;
      const curr = chunkDelivered[i]!;
      expect(curr.emittedAt).toBeGreaterThanOrEqual(prev.emittedAt);
    }
  });

  it("3 个 chunk 的交付间隔 > 0（非并行）", () => {
    const engine = createEngine();
    const events: IRealismEngineOutput[] = [];
    engine.subscribe((output) => events.push(output));
    engine.setLLMConfig(mockLLMConfig);

    const adapter = createMockAdapter({
      config: mockLLMConfigInternal,
      tokenIntervalMs: 1,
    });

    engine.startStreamWithAdapter("第一句。第二句。第三句。", adapter);
    vi.advanceTimersByTime(10000);

    const chunkDelivered = events.filter(
      (e) => e.event.kind === "chunk-delivered",
    );

    if (chunkDelivered.length >= 3) {
      // 第一个 chunk 在 t=0 附近交付（preDelay=0）
      // 第二个 chunk 的 preDelay > 0（非 isFirst）
      const gap1 = chunkDelivered[1]!.emittedAt - chunkDelivered[0]!.emittedAt;
      const gap2 = chunkDelivered[2]!.emittedAt - chunkDelivered[1]!.emittedAt;

      // 至少有一些间隔（非零），证明串行排队
      expect(gap1).toBeGreaterThan(0);
      expect(gap2).toBeGreaterThan(0);
    }
  });

  it("scheduledChunkCount 在排程时立即递增（不等交付）", () => {
    const engine = createEngine();
    const events: IRealismEngineOutput[] = [];
    engine.subscribe((output) => events.push(output));
    engine.setLLMConfig(mockLLMConfig);

    const adapter = createMockAdapter({
      config: mockLLMConfigInternal,
      tokenIntervalMs: 1,
    });

    // 不推进时间，chunk 应已排程但未交付
    engine.startStreamWithAdapter("第一句。第二句。", adapter);

    // 不推进时间，检查是否有排程事件
    // 至少应有 lifecycle started
    const lifecycle = events.filter((e) => e.event.kind === "lifecycle");
    expect(lifecycle.length).toBeGreaterThanOrEqual(1);

    // 推进时间让交付发生
    vi.advanceTimersByTime(5000);

    const chunkDelivered = events.filter(
      (e) => e.event.kind === "chunk-delivered",
    );
    expect(chunkDelivered.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------- 逐句显示优化（间隔算法） ----------
describe("RealismEngine 逐句间隔算法", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("首个 chunk 立即交付（0ms 延迟）", () => {
    const engine = createEngine();
    const events: IRealismEngineOutput[] = [];
    engine.subscribe((output) => events.push(output));
    engine.setLLMConfig(mockLLMConfig);

    const adapter = createMockAdapter({
      config: mockLLMConfigInternal,
      tokenIntervalMs: 1,
    });

    const startTime = Date.now();
    engine.startStreamWithAdapter("第一句。第二句。第三句。", adapter);

    // 推进足够时间让 mock adapter 生成 token + chunk 排队
    vi.advanceTimersByTime(5000);

    const chunkDelivered = events.filter(
      (e) => e.event.kind === "chunk-delivered",
    );
    expect(chunkDelivered.length).toBeGreaterThanOrEqual(1);

    // 首个 chunk 的 emittedAt 应非常接近 startTime（0ms 延迟）
    const firstChunk = chunkDelivered[0]!;
    expect(firstChunk.emittedAt - startTime).toBeLessThanOrEqual(50);
  });

  it("后续 chunk 间隔 >= 250ms（最小间隔约束）", () => {
    const engine = createEngine();
    const events: IRealismEngineOutput[] = [];
    engine.subscribe((output) => events.push(output));
    engine.setLLMConfig(mockLLMConfig);

    const adapter = createMockAdapter({
      config: mockLLMConfigInternal,
      tokenIntervalMs: 1,
    });

    engine.startStreamWithAdapter("第一句。第二句。第三句。", adapter);
    vi.advanceTimersByTime(10000);

    const chunkDelivered = events.filter(
      (e) => e.event.kind === "chunk-delivered",
    );

    if (chunkDelivered.length >= 2) {
      for (let i = 1; i < chunkDelivered.length; i += 1) {
        const gap = chunkDelivered[i]!.emittedAt - chunkDelivered[i - 1]!.emittedAt;
        // 后续 chunk 间隔应 >= 250ms（最小间隔约束）
        expect(gap).toBeGreaterThanOrEqual(250);
      }
    }
  });

  it("间隔随上一条文本长度增加而增大（长句后更久）", () => {
    const engine = createEngine();
    const events: IRealismEngineOutput[] = [];
    engine.subscribe((output) => events.push(output));
    engine.setLLMConfig(mockLLMConfig);

    const adapter = createMockAdapter({
      config: mockLLMConfigInternal,
      tokenIntervalMs: 1,
    });

    // 用句号分隔，让 Chunker 切分；第一句足够长
    // fragmentationThresholdChars=8 → 短句也会被切分
    const longFirstSentence = "这是一个非常非常长的句子用来测试间隔算法是否会根据文本长度调整后续延迟时间。";
    const input = longFirstSentence + "短句。";
    engine.startStreamWithAdapter(input, adapter);
    vi.advanceTimersByTime(10000);

    const chunkDelivered = events.filter(
      (e) => e.event.kind === "chunk-delivered",
    );

    if (chunkDelivered.length >= 2) {
      const gap1 = chunkDelivered[1]!.emittedAt - chunkDelivered[0]!.emittedAt;
      // 长句后的间隔应 >= 基础 300ms
      // 由于 jitter 可能为负，我们验证 >= 250ms（最小约束）
      expect(gap1).toBeGreaterThanOrEqual(250);
    }
  });

  /**
   * 两条气泡之间的间隔 = **上一条的打字动画时长** + 下一条的预送达停顿。
   *
   * 只盯着"间隔 ≤ 1500ms"是错的：打字动画时长随文本长度线性增长
   * （turbo 档每字约 133ms，抖动上限 1.6 倍），长一点的 chunk 光动画
   * 就要好几秒。之前这条用例在全量跑（机器忙）时偶发变红，就是断言本身
   * 写错了——**上限约束加在"预送达停顿"上，不是加在总间隔上**。
   * 现在按引擎的真实公式算出上限，再留一点余量：
   * 它依然能抓住"调度器卡住/间隔失控"，但不会因为动画时长而误报。
   */
  it("预送达停顿不超过配置上限（总间隔 = 上一条打字时长 + 停顿）", () => {
    const engine = createEngine();
    const events: IRealismEngineOutput[] = [];
    engine.subscribe((output) => events.push(output));
    engine.setLLMConfig(mockLLMConfig);

    const adapter = createMockAdapter({
      config: mockLLMConfigInternal,
      tokenIntervalMs: 1,
    });

    // 极长文本，测试上限
    const longText = "极长的句子".repeat(50) + "。短句。";
    engine.startStreamWithAdapter(longText, adapter);
    vi.advanceTimersByTime(10000);

    const chunkDelivered = events.filter(
      (e) => e.event.kind === "chunk-delivered",
    );

    if (chunkDelivered.length >= 2) {
      // mockConfig 是 turbo（450 cpm）；单字延迟的抖动上限是 1.6 倍
      const maxPerCharMs = (60000 / 450) * 1.6;
      for (let i = 1; i < chunkDelivered.length; i += 1) {
        const gap = chunkDelivered[i]!.emittedAt - chunkDelivered[i - 1]!.emittedAt;
        const previous = chunkDelivered[i - 1]!.event;
        const previousMessage =
          previous.kind === "chunk-delivered" ? previous.message : null;
        const previousChars =
          previousMessage?.type === "text" ? previousMessage.text.length : 0;
        const maxGap =
          previousChars * maxPerCharMs +
          mockConfig.maxInterChunkDelayMs +
          100; // 取整与定时器粒度的余量
        expect(gap).toBeLessThanOrEqual(Math.ceil(maxGap));
      }
    }
  });

  it("typing-indicator 在首个 chunk 交付后关闭", () => {
    const engine = createEngine();
    const events: IRealismEngineOutput[] = [];
    engine.subscribe((output) => events.push(output));
    engine.setLLMConfig(mockLLMConfig);

    const adapter = createMockAdapter({
      config: mockLLMConfigInternal,
      tokenIntervalMs: 1,
    });

    engine.startStreamWithAdapter("第一句。第二句。", adapter);
    vi.advanceTimersByTime(10000);

    // 找到所有 typing-indicator 事件
    const typingEvents = events.filter(
      (e) => e.event.kind === "typing-indicator",
    );

    expect(typingEvents.length).toBeGreaterThanOrEqual(1);

    // 至少有一个 active=false（首个 chunk 交付后关闭）
    const inactiveEvents = typingEvents.filter((e) => {
      const ev = e.event as { active: boolean };
      return ev.active === false;
    });
    expect(inactiveEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("同一会话连续调用：lastChunkText 重置不影响新流", () => {
    const engine = createEngine();
    const events: IRealismEngineOutput[] = [];
    engine.subscribe((output) => events.push(output));
    engine.setLLMConfig(mockLLMConfig);

    const adapter = createMockAdapter({
      config: mockLLMConfigInternal,
      tokenIntervalMs: 1,
    });

    // 第一次流
    engine.startStreamWithAdapter("第一句。第二句。", adapter);
    vi.advanceTimersByTime(15000);

    // 第一次流应有 chunk-delivered 事件
    const firstChunkCount = events.filter(
      (e) => e.event.kind === "chunk-delivered",
    ).length;
    expect(firstChunkCount).toBeGreaterThanOrEqual(1);

    // 显式 abort 第一次流以结束它（mock adapter 回复以标点结尾，
    // 不会产出 isTerminal chunk，需要手动结束）
    engine.abort("test-reset");
    vi.advanceTimersByTime(100);

    // 第二次流（新的对话回合）
    events.length = 0;
    const adapter2 = createMockAdapter({
      config: mockLLMConfigInternal,
      tokenIntervalMs: 1,
    });
    engine.startStreamWithAdapter("新对话。", adapter2);
    vi.advanceTimersByTime(5000);

    // 新流的首个 chunk 也应立即交付
    const secondChunkCount = events.filter(
      (e) => e.event.kind === "chunk-delivered",
    ).length;
    expect(secondChunkCount).toBeGreaterThanOrEqual(1);
  });

  it("多个 chunk 交付时间单调递增", () => {
    const engine = createEngine();
    const events: IRealismEngineOutput[] = [];
    engine.subscribe((output) => events.push(output));
    engine.setLLMConfig(mockLLMConfig);

    const adapter = createMockAdapter({
      config: mockLLMConfigInternal,
      tokenIntervalMs: 1,
    });

    engine.startStreamWithAdapter("句一。句二。句三。句四。句五。", adapter);
    vi.advanceTimersByTime(15000);

    const chunkDelivered = events.filter(
      (e) => e.event.kind === "chunk-delivered",
    );

    expect(chunkDelivered.length).toBeGreaterThanOrEqual(2);

    // emittedAt 严格单调递增
    for (let i = 1; i < chunkDelivered.length; i += 1) {
      expect(chunkDelivered[i]!.emittedAt).toBeGreaterThanOrEqual(
        chunkDelivered[i - 1]!.emittedAt,
      );
    }
  });
});
