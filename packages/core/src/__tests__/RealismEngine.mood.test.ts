/**
 * @file RealismEngine.mood.test.ts
 * 心情注入引擎后的两条效果：
 * 1. 心情段进 Prompt（模型能顺着语气说）；
 * 2. 文本看不出情绪时，立绘跟着心情走（而不是一律回到 neutral）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RealismEngine } from "../RealismEngine";
import type { IConnectionTestResult, ILLMAdapter } from "../llm/LLMAdapter";
import type { ILLMAbortHandle, ILLMRequest } from "../llm/types";
import type {
  ICharacterProfile,
  IChunkDeliveredEvent,
  ILlmStreamHandlers,
  IRealismEngineOutput,
  ISimulationConfig,
  ITextMessage,
} from "@wechat-rp/shared-types";

/** 记录最后一次请求的适配器（用来断言 Prompt 内容）。 */
class CapturingAdapter implements ILLMAdapter {
  public lastRequest: ILLMRequest | null = null;

  constructor(private readonly reply: string) {}

  public stream(
    req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    _signal: AbortSignal,
  ): ILLMAbortHandle {
    this.lastRequest = req;
    handlers.onComplete(this.reply);
    return { abort: () => {} };
  }

  public async testConnection(): Promise<IConnectionTestResult> {
    return { ok: true, latencyMs: 1 };
  }
}

function makeProfile(): ICharacterProfile {
  return {
    id: "char-mood",
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
  realismEnabled: false, // 秒回模式：交付同步、断言干净
  typingSpeedCpm: "turbo",
  hesitationProbability: 0,
  typoRate: 0,
  fragmentationThresholdChars: 24,
  scheduleAwarenessEnabled: false,
  typingIndicatorEnabled: true,
  typoAutoCorrectEnabled: true,
  maxInterChunkDelayMs: 100,
};

function createEngine(): {
  engine: RealismEngine;
  events: IRealismEngineOutput[];
} {
  const engine = new RealismEngine({
    profile: makeProfile(),
    config,
    sessionId: "s-mood",
    userId: "user",
  });
  const events: IRealismEngineOutput[] = [];
  engine.subscribe((output) => events.push(output));
  return { engine, events };
}

function deliveredText(
  events: ReadonlyArray<IRealismEngineOutput>,
): ITextMessage | null {
  const found = events.find((e) => e.event.kind === "chunk-delivered");
  if (!found) return null;
  const message = (found.event as IChunkDeliveredEvent).message;
  return message.type === "text" ? message : null;
}

describe("RealismEngine · 心情", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("心情段会写进 Prompt", () => {
    const { engine } = createEngine();
    const adapter = new CapturingAdapter("嗯，好。");
    engine.setMood({ emotion: "sad", intensity: 4, sourceCount: 3 });

    engine.startStreamWithAdapter("在吗", adapter);
    vi.advanceTimersByTime(1000);

    const system = adapter.lastRequest?.messages[0]?.content ?? "";
    expect(system).toContain("【你此刻的心情】");
    expect(system).toContain("低落");
  });

  it("文本看不出情绪时，立绘跟着心情走（不再一律回到 neutral）", () => {
    const { engine, events } = createEngine();
    engine.setMood({ emotion: "sad", intensity: 4, sourceCount: 3 });

    // "嗯，好。" 里没有任何情绪关键词
    engine.startStreamWithAdapter("在吗", new CapturingAdapter("嗯，好。"));
    vi.advanceTimersByTime(1000);

    expect(deliveredText(events)?.emotion).toBe("sad");
  });

  it("文本自己有情绪线索时，以文本为准（心情不覆盖当场的表情）", () => {
    const { engine, events } = createEngine();
    engine.setMood({ emotion: "sad", intensity: 5, sourceCount: 4 });

    engine.startStreamWithAdapter("讲个笑话", new CapturingAdapter("哈哈哈哈笑死我了"));
    vi.advanceTimersByTime(1000);

    expect(deliveredText(events)?.emotion).toBe("happy");
  });

  it("平静的心情不参与兜底（默认仍是 neutral）", () => {
    const { engine, events } = createEngine();
    engine.setMood({ emotion: "neutral", intensity: 5, sourceCount: 3 });

    engine.startStreamWithAdapter("在吗", new CapturingAdapter("嗯，好。"));
    vi.advanceTimersByTime(1000);

    expect(deliveredText(events)?.emotion).toBe("neutral");
  });
});
