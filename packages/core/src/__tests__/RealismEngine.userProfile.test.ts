/**
 * @file RealismEngine.userProfile.test.ts
 * "关于你"（用户人设）要真的进 Prompt。
 *
 * 这一环只有 App 会调用（`syncEngineContext` → `engine.setUserProfile`），
 * 所以用假适配器把请求抓下来断言，别让它变成"写了但没接上"的空壳。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RealismEngine } from "../RealismEngine";
import type { IConnectionTestResult, ILLMAdapter } from "../llm/LLMAdapter";
import type { ILLMAbortHandle, ILLMRequest } from "../llm/types";
import type {
  ICharacterProfile,
  ILlmStreamHandlers,
  ISimulationConfig,
} from "@wechat-rp/shared-types";

/** 记录最后一次请求的适配器（秒回模式，交付同步）。 */
class CapturingAdapter implements ILLMAdapter {
  public lastRequest: ILLMRequest | null = null;

  public stream(
    req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    _signal: AbortSignal,
  ): ILLMAbortHandle {
    this.lastRequest = req;
    handlers.onComplete("在的。");
    return { abort: () => {} };
  }

  public async testConnection(): Promise<IConnectionTestResult> {
    return { ok: true, latencyMs: 1 };
  }
}

function makeProfile(): ICharacterProfile {
  return {
    id: "char-profile",
    displayName: "苏晚晴",
    bio: "测试",
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
      sleepReplyPolicy: "next-day-queue",
    },
    personalityTraits: {
      archetype: "gentle",
      typingSpeedMultiplier: 1,
      fragmentationBias: 0.3,
      hesitationProbability: 0,
      typoRate: 0,
      stickerFrequency: 0,
    },
    promptTemplateId: "",
  };
}

const config: ISimulationConfig = {
  realismEnabled: false,
  typingSpeedCpm: "turbo",
  hesitationProbability: 0,
  typoRate: 0,
  fragmentationThresholdChars: 24,
  scheduleAwarenessEnabled: false,
  typingIndicatorEnabled: true,
  typoAutoCorrectEnabled: true,
  maxInterChunkDelayMs: 100,
};

function createEngine(): RealismEngine {
  const engine = new RealismEngine({
    profile: makeProfile(),
    config,
    sessionId: "s-profile",
    userId: "user",
  });
  engine.subscribe(() => {});
  return engine;
}

describe("RealismEngine · 关于你", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("注入用户人设后写进开头 system", () => {
    const engine = createEngine();
    const adapter = new CapturingAdapter();
    engine.setUserProfile({
      displayName: "小满",
      bio: "25 岁，程序员，养了一只猫",
    });

    engine.startStreamWithAdapter("在吗", adapter);
    vi.advanceTimersByTime(1000);

    const system = adapter.lastRequest?.messages[0]?.content ?? "";
    expect(system).toContain("【关于对方】");
    expect(system).toContain("小满");
    expect(system).toContain("25 岁，程序员，养了一只猫");
  });

  it("没设置（null）时不产生这一段", () => {
    const engine = createEngine();
    const adapter = new CapturingAdapter();
    engine.setUserProfile(null);

    engine.startStreamWithAdapter("在吗", adapter);
    vi.advanceTimersByTime(1000);

    expect(adapter.lastRequest?.messages[0]?.content ?? "").not.toContain(
      "【关于对方】",
    );
  });
});
