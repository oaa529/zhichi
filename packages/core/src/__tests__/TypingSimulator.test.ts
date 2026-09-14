/**
 * @file TypingSimulator.test.ts
 * TypingSimulator 单元测试：plan/applyTypo/estimateTypingDurationMs。
 * 使用 seeded RNG 保证可复现性。
 */

import { describe, it, expect } from "vitest";
import { TypingSimulator } from "../TypingSimulator";
import type { IRandomSource } from "../TypingSimulator";
import type { ICharacterProfile, ISimulationConfig } from "@wechat-rp/shared-types";
import type { MessageChunk } from "../types";

/** Mulberry32 seeded RNG（确定性伪随机）。 */
function createSeededRng(seed: number): IRandomSource {
  let state = seed;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

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
  promptTemplateId: "test-template",
};

const mockConfig: ISimulationConfig = {
  realismEnabled: true,
  typingSpeedCpm: "normal",
  hesitationProbability: 0,
  typoRate: 0,
  fragmentationThresholdChars: 24,
  scheduleAwarenessEnabled: false,
  typingIndicatorEnabled: true,
  typoAutoCorrectEnabled: true,
  maxInterChunkDelayMs: 6000,
};

function createChunk(text: string, sequence = 0, isTerminal = false): MessageChunk {
  return {
    id: `chunk-${sequence}`,
    sourceOffset: 0,
    text,
    chunkSequence: sequence,
    emotion: "neutral",
    isTerminal,
  };
}

describe("TypingSimulator", () => {
  it("plan() 返回 revealDelays 长度等于 chunk 文本长度", () => {
    const rng = createSeededRng(42);
    const sim = new TypingSimulator(mockProfile, mockConfig, rng);
    const chunk = createChunk("你好世界，今天天气不错。");

    const plan = sim.plan(chunk, true);

    expect(plan.revealDelays).toHaveLength(chunk.text.length);
  });

  it("plan() revealDelays 单调递增", () => {
    const rng = createSeededRng(42);
    const sim = new TypingSimulator(mockProfile, mockConfig, rng);
    const chunk = createChunk("这是一段测试文本。");

    const plan = sim.plan(chunk, true);

    for (let i = 1; i < plan.revealDelays.length; i += 1) {
      expect(plan.revealDelays[i]).toBeGreaterThanOrEqual(plan.revealDelays[i - 1]!);
    }
  });

  it("plan() 首 chunk 的 preDeliveryDelayMs 为 0", () => {
    const rng = createSeededRng(42);
    const sim = new TypingSimulator(mockProfile, mockConfig, rng);
    const chunk = createChunk("测试。");

    const plan = sim.plan(chunk, true);

    expect(plan.preDeliveryDelayMs).toBe(0);
  });

  it("plan() 非首 chunk 的 preDeliveryDelayMs > 0", () => {
    const rng = createSeededRng(42);
    const sim = new TypingSimulator(mockProfile, mockConfig, rng);
    const chunk = createChunk("测试文本。");

    const plan = sim.plan(chunk, false);

    expect(plan.preDeliveryDelayMs).toBeGreaterThan(0);
  });

  it("plan() triggersTypingIndicator 在长文本时为 true", () => {
    const rng = createSeededRng(42);
    const sim = new TypingSimulator(mockProfile, mockConfig, rng);
    const chunk = createChunk("这是一段超过六个字符的测试文本。");

    const plan = sim.plan(chunk, true);

    expect(plan.triggersTypingIndicator).toBe(true);
  });

  it("plan() 短文本时 triggersTypingIndicator 为 false", () => {
    const rng = createSeededRng(42);
    const sim = new TypingSimulator(mockProfile, mockConfig, rng);
    const chunk = createChunk("嗨。");

    const plan = sim.plan(chunk, true);

    expect(plan.triggersTypingIndicator).toBe(false);
  });

  it("plan() typoRate=0 时不注入错别字", () => {
    const rng = createSeededRng(42);
    const sim = new TypingSimulator(mockProfile, mockConfig, rng);
    const chunk = createChunk("这是一段测试文本。");

    const plan = sim.plan(chunk, true);

    expect(plan.containsTypo).toBe(false);
    expect(plan.typoCorrectAtMs).toBeNull();
  });

  it("plan() typoRate=1 时必注入错别字", () => {
    const rng = createSeededRng(42);
    const sim = new TypingSimulator(mockProfile, { ...mockConfig, typoRate: 1 }, rng);
    const chunk = createChunk("这是一段测试文本。");

    const plan = sim.plan(chunk, true);

    expect(plan.containsTypo).toBe(true);
    expect(plan.typoCorrectAtMs).not.toBeNull();
    expect(plan.typoCorrectAtMs).toBeGreaterThan(0);
  });

  it("相同 seed 产生相同 plan（可复现性）", () => {
    const rng1 = createSeededRng(42);
    const rng2 = createSeededRng(42);
    const sim1 = new TypingSimulator(mockProfile, mockConfig, rng1);
    const sim2 = new TypingSimulator(mockProfile, mockConfig, rng2);
    const chunk = createChunk("可复现的测试文本。");

    const plan1 = sim1.plan(chunk, true);
    const plan2 = sim2.plan(chunk, true);

    expect(plan1.revealDelays).toEqual(plan2.revealDelays);
    expect(plan1.preDeliveryDelayMs).toBe(plan2.preDeliveryDelayMs);
  });

  it("不同打字速度档位产生不同延迟", () => {
    const rng1 = createSeededRng(42);
    const rng2 = createSeededRng(42);
    const slowSim = new TypingSimulator(
      mockProfile,
      { ...mockConfig, typingSpeedCpm: "slow" },
      rng1,
    );
    const fastSim = new TypingSimulator(
      mockProfile,
      { ...mockConfig, typingSpeedCpm: "turbo" },
      rng2,
    );
    const chunk = createChunk("测试文本。");

    const slowPlan = slowSim.plan(chunk, true);
    const fastPlan = fastSim.plan(chunk, true);

    // turbo 应比 slow 快（延迟更小）
    expect(fastPlan.revealDelays[fastPlan.revealDelays.length - 1]!).toBeLessThan(
      slowPlan.revealDelays[slowPlan.revealDelays.length - 1]!,
    );
  });

  it("applyTypo() 短文本（<4）不注入错字", () => {
    const rng = createSeededRng(42);
    const sim = new TypingSimulator(mockProfile, mockConfig, rng);

    const result = sim.applyTypo("短");

    expect(result.typoText).toBe("短");
    expect(result.correctedText).toBe("短");
  });

  it("applyTypo() 在包含 TYPO_MAP 字符的文本中替换", () => {
    const rng = createSeededRng(42);
    const sim = new TypingSimulator(mockProfile, mockConfig, rng);

    const result = sim.applyTypo("是的，我在这里。");

    expect(result.typoText).not.toBe(result.correctedText);
  });

  it("applyTypo() 无可替换字符时返回原文", () => {
    const rng = createSeededRng(42);
    const sim = new TypingSimulator(mockProfile, mockConfig, rng);

    const result = sim.applyTypo("ABCD EFGH");

    expect(result.typoText).toBe("ABCD EFGH");
    expect(result.correctedText).toBe("ABCD EFGH");
  });

  it("estimateTypingDurationMs() 返回合理值", () => {
    const sim = new TypingSimulator(mockProfile, mockConfig);

    const duration = sim.estimateTypingDurationMs(200);

    // normal = 200 cpm, multiplier = 1.0
    // 200 chars / 200 cpm * 60000 ms = 60000 ms
    expect(duration).toBe(60000);
  });

  it("personalityTraits.typingSpeedMultiplier 影响延迟", () => {
    const rng1 = createSeededRng(42);
    const rng2 = createSeededRng(42);
    const slowProfile: ICharacterProfile = {
      ...mockProfile,
      personalityTraits: { ...mockProfile.personalityTraits, typingSpeedMultiplier: 0.5 },
    };
    const fastProfile: ICharacterProfile = {
      ...mockProfile,
      personalityTraits: { ...mockProfile.personalityTraits, typingSpeedMultiplier: 2.0 },
    };
    const slowSim = new TypingSimulator(slowProfile, mockConfig, rng1);
    const fastSim = new TypingSimulator(fastProfile, mockConfig, rng2);
    const chunk = createChunk("测试打字速度。");

    const slowPlan = slowSim.plan(chunk, true);
    const fastPlan = fastSim.plan(chunk, true);

    // multiplier=2.0 应比 multiplier=0.5 快（延迟更小）
    expect(fastPlan.revealDelays[fastPlan.revealDelays.length - 1]!).toBeLessThan(
      slowPlan.revealDelays[slowPlan.revealDelays.length - 1]!,
    );
  });
});
