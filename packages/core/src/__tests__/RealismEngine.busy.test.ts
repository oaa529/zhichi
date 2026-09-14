/**
 * @file RealismEngine.busy.test.ts
 * 忙碌时段的引擎行为：状态事件（away + 文案）与 Prompt 注入。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RealismEngine } from "../RealismEngine";
import type { IConnectionTestResult, ILLMAdapter } from "../llm/LLMAdapter";
import type { ILLMAbortHandle, ILLMRequest } from "../llm/types";
import type {
  ICharacterProfile,
  ILlmStreamHandlers,
  IPresenceEvent,
  IRealismEngineOutput,
  ISimulationConfig,
} from "@wechat-rp/shared-types";

class CapturingAdapter implements ILLMAdapter {
  public lastRequest: ILLMRequest | null = null;

  public stream(
    req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    _signal: AbortSignal,
  ): ILLMAbortHandle {
    this.lastRequest = req;
    handlers.onComplete("下课再说。");
    return { abort: () => {} };
  }

  public async testConnection(): Promise<IConnectionTestResult> {
    return { ok: true, latencyMs: 1 };
  }
}

/** 上午九点到十二点在上课。 */
const MORNING_CLASS = [{ start: "09:00", end: "12:00", label: "在上课" }];

function makeProfile(
  busyPeriods: ReadonlyArray<{ start: string; end: string; label: string }> | null,
): ICharacterProfile {
  return {
    id: "char-busy",
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
      scheduleEnabled: true,
      timezone: "Asia/Shanghai",
      sleepReplyPolicy: "next-day-queue",
      ...(busyPeriods ? { busyPeriods } : {}),
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
  realismEnabled: false, // 秒回模式：交付同步，断言干净
  typingSpeedCpm: "turbo",
  hesitationProbability: 0,
  typoRate: 0,
  fragmentationThresholdChars: 24,
  scheduleAwarenessEnabled: true,
  typingIndicatorEnabled: true,
  typoAutoCorrectEnabled: true,
  maxInterChunkDelayMs: 100,
};

function createEngine(profile: ICharacterProfile): {
  engine: RealismEngine;
  events: IRealismEngineOutput[];
} {
  const engine = new RealismEngine({
    profile,
    config,
    sessionId: "s-busy",
    userId: "user",
  });
  const events: IRealismEngineOutput[] = [];
  engine.subscribe((output) => events.push(output));
  return { engine, events };
}

describe("RealismEngine · 忙碌时段", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 固定"本地时间 10:00"：睡眠窗口 23:30–07:30 之外、忙碌段之内，
    // 这样断言与真实运行时刻无关（否则晚上跑测试会变成"睡着了"）
    vi.setSystemTime(new Date(2026, 8, 13, 10, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("忙碌时推送 away 状态，文案是角色自己在干什么", () => {
    const { engine, events } = createEngine(makeProfile(MORNING_CLASS));

    engine.startStreamWithAdapter("在吗", new CapturingAdapter());
    vi.advanceTimersByTime(1000);

    const presence = events.find((e) => e.event.kind === "presence");
    expect((presence?.event as IPresenceEvent | undefined)?.status).toBe("away");
    expect((presence?.event as IPresenceEvent | undefined)?.displayText).toBe(
      "在上课",
    );
  });

  it("忙碌段会进 Prompt（要求短回复）", () => {
    const { engine } = createEngine(makeProfile(MORNING_CLASS));
    const adapter = new CapturingAdapter();

    engine.startStreamWithAdapter("在吗", adapter);
    vi.advanceTimersByTime(1000);

    const system = adapter.lastRequest?.messages[0]?.content ?? "";
    expect(system).toContain("在上课");
    expect(system).toContain("很短");
  });

  it("没配忙碌时段时不出现在场事件，也不改 Prompt", () => {
    const { engine, events } = createEngine(makeProfile(null));
    const adapter = new CapturingAdapter();

    expect(engine.isBusy()).toBe(false);
    engine.startStreamWithAdapter("在吗", adapter);
    vi.advanceTimersByTime(1000);

    expect(events.some((e) => e.event.kind === "presence")).toBe(false);
    expect(adapter.lastRequest?.messages[0]?.content ?? "").not.toContain(
      "很短",
    );
  });

  it("忙碌段之外（比如下午）一切照旧", () => {
    vi.setSystemTime(new Date(2026, 8, 13, 15, 0, 0));
    const { engine, events } = createEngine(makeProfile(MORNING_CLASS));
    const adapter = new CapturingAdapter();

    expect(engine.isBusy()).toBe(false);
    engine.startStreamWithAdapter("在吗", adapter);
    vi.advanceTimersByTime(1000);

    expect(events.some((e) => e.event.kind === "presence")).toBe(false);
    expect(adapter.lastRequest?.messages[0]?.content ?? "").not.toContain(
      "很短",
    );
  });
});
