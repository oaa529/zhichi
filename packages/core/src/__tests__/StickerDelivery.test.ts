/**
 * @file StickerDelivery.test.ts
 * 贴图交付：`stickerFrequency` 真的会生效。
 *
 * 由来：这个配置项在角色编辑器里有滑杆、六个性格预设各带默认值，
 * 但引擎从未读它——角色永远不会发贴图，属于"配了没用"的断链。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RealismEngine } from "../RealismEngine";
import type {
  ICharacterProfile,
  ILlmStreamHandlers,
  IStickerMessage,
  ISimulationConfig,
} from "@wechat-rp/shared-types";
import type { IConnectionTestResult, ILLMAdapter } from "../llm/LLMAdapter";
import type { ILLMAbortHandle, ILLMRequest } from "../llm/types";

/** 立刻吐出固定文本的适配器。 */
class InstantAdapter implements ILLMAdapter {
  constructor(private readonly text: string) {}

  public stream(
    _req: ILLMRequest,
    handlers: ILlmStreamHandlers,
    _signal: AbortSignal,
  ): ILLMAbortHandle {
    handlers.onDelta(this.text);
    handlers.onComplete(this.text);
    return { abort: () => {} };
  }

  public async testConnection(): Promise<IConnectionTestResult> {
    return { ok: true, latencyMs: 1 };
  }
}

function makeProfile(stickerFrequency: number): ICharacterProfile {
  return {
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
      archetype: "playful",
      typingSpeedMultiplier: 1,
      fragmentationBias: 0.3,
      hesitationProbability: 0,
      typoRate: 0,
      stickerFrequency,
    },
    promptTemplateId: "",
  };
}

/** 秒回模式：单条消息立即交付，收尾路径最短（贴图逻辑挂在收尾上）。 */
const instantConfig: ISimulationConfig = {
  realismEnabled: false,
  typingSpeedCpm: "turbo",
  hesitationProbability: 0,
  typoRate: 0,
  fragmentationThresholdChars: 24,
  scheduleAwarenessEnabled: false,
  typingIndicatorEnabled: false,
  typoAutoCorrectEnabled: false,
  maxInterChunkDelayMs: 0,
};

/** 跑一轮对话，返回交付出来的贴图消息。 */
async function runOnce(
  stickerFrequency: number,
  text = "好的。",
): Promise<ReadonlyArray<IStickerMessage>> {
  const engine = new RealismEngine({
    profile: makeProfile(stickerFrequency),
    config: instantConfig,
    sessionId: "s1",
    userId: "user",
  });
  const stickers: IStickerMessage[] = [];
  engine.subscribe((output) => {
    if (output.event.kind === "chunk-delivered") {
      const message = output.event.message;
      if (message.type === "sticker") stickers.push(message);
    }
  });
  engine.startStreamWithAdapter("在吗", new InstantAdapter(text));
  // 秒回路径是同步完成的，但留一拍给内部 promise
  await vi.advanceTimersByTimeAsync(0);
  return stickers;
}

describe("贴图交付", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stickerFrequency = 1 时每轮追加一条贴图", async () => {
    const stickers = await runOnce(1);
    expect(stickers).toHaveLength(1);
    expect(stickers[0]!.senderId).toBe("char-1");
    expect(stickers[0]!.fallbackText).toMatch(/^\[.+\]$/);
    expect(stickers[0]!.stickerPackId).toBe("zhichi-basic");
  });

  it("stickerFrequency = 0 时不发贴图（默认就是不打扰）", async () => {
    expect(await runOnce(0)).toHaveLength(0);
  });

  it("每轮最多一张：连续两轮各发一张，而不是一轮发两张", async () => {
    const engine = new RealismEngine({
      profile: makeProfile(1),
      config: instantConfig,
      sessionId: "s1",
      userId: "user",
    });
    const stickers: IStickerMessage[] = [];
    engine.subscribe((output) => {
      if (
        output.event.kind === "chunk-delivered" &&
        output.event.message.type === "sticker"
      ) {
        stickers.push(output.event.message);
      }
    });

    engine.startStreamWithAdapter("第一句", new InstantAdapter("嗯。"));
    await vi.advanceTimersByTimeAsync(0);
    engine.startStreamWithAdapter("第二句", new InstantAdapter("好的。"));
    await vi.advanceTimersByTimeAsync(0);

    expect(stickers).toHaveLength(2);
  });

  it("贴图情绪跟随模型自标的情绪（标签会被剥掉）", async () => {
    const stickers = await runOnce(1, "happy 好呀，今天很开心");
    expect(stickers).toHaveLength(1);
    expect(stickers[0]!.emotion).toBe("happy");
    // happy → 开心那张
    expect(stickers[0]!.stickerId).toBe("grin");
  });

  it("贴图的 chunkSequence 排在文字之后（渲染顺序不能反）", async () => {
    const engine = new RealismEngine({
      profile: makeProfile(1),
      config: instantConfig,
      sessionId: "s1",
      userId: "user",
    });
    const order: string[] = [];
    engine.subscribe((output) => {
      if (output.event.kind === "chunk-delivered") {
        order.push(output.event.message.type);
      }
    });

    engine.startStreamWithAdapter("在吗", new InstantAdapter("在的。"));
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(["text", "sticker"]);
  });

  it("秒回模式下交付的正文不含情绪标签（首行情绪词会被剥掉）", async () => {
    const engine = new RealismEngine({
      profile: makeProfile(0),
      config: instantConfig,
      sessionId: "s1",
      userId: "user",
    });
    const texts: string[] = [];
    engine.subscribe((output) => {
      if (
        output.event.kind === "chunk-delivered" &&
        output.event.message.type === "text"
      ) {
        texts.push(output.event.message.text);
      }
    });

    engine.startStreamWithAdapter("在吗", new InstantAdapter("happy 在呀！"));
    await vi.advanceTimersByTimeAsync(0);

    expect(texts).toEqual(["在呀！"]);
  });
});
