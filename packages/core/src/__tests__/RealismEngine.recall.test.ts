/**
 * @file RealismEngine.recall.test.ts
 * 角色"说漏嘴→撤回"的链路测试。
 *
 * 之前这条链路是断的：契约、Store 处理、气泡渲染都在，但引擎从不发撤回事件。
 * 这里验证引擎侧真的会发，而且发的时机/目标/顺序都对。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RealismEngine } from "../RealismEngine";
import type { IConnectionTestResult, ILLMAdapter } from "../llm/LLMAdapter";
import type { ILLMAbortHandle, ILLMRequest } from "../llm/types";
import type {
  ICharacterProfile,
  IChunkDeliveredEvent,
  ILifecycleEvent,
  ILlmStreamHandlers,
  IRecallEvent,
  IRealismEngineOutput,
  ISimulationConfig,
} from "@wechat-rp/shared-types";

/** 一口气把给定文本推完的适配器（不依赖 mock adapter 的 token 间隔）。 */
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

function makeProfile(overrides: Partial<ICharacterProfile> = {}): ICharacterProfile {
  return {
    id: "char-recall",
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
      // 作息关闭：否则测试会随"当前真实时间"变红
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
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ISimulationConfig> = {}): ISimulationConfig {
  return {
    realismEnabled: true,
    typingSpeedCpm: "turbo",
    hesitationProbability: 0,
    typoRate: 0,
    fragmentationThresholdChars: 8,
    scheduleAwarenessEnabled: false,
    typingIndicatorEnabled: true,
    typoAutoCorrectEnabled: true,
    maxInterChunkDelayMs: 100,
    ...overrides,
  };
}

function createEngine(
  profile: ICharacterProfile,
  config: ISimulationConfig,
): { engine: RealismEngine; events: IRealismEngineOutput[] } {
  const engine = new RealismEngine({
    profile,
    config,
    sessionId: "s-recall",
    userId: "user",
  });
  const events: IRealismEngineOutput[] = [];
  engine.subscribe((output) => events.push(output));
  return { engine, events };
}

/** 取事件流里某一类事件。 */
function pick<T extends string>(
  events: ReadonlyArray<IRealismEngineOutput>,
  kind: T,
): ReadonlyArray<IRealismEngineOutput> {
  return events.filter((e) => e.event.kind === kind);
}

describe("RealismEngine · 角色撤回", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("概率命中时撤回最后一条文本，并在撤回之后才收尾", () => {
    const { engine, events } = createEngine(
      makeProfile(),
      makeConfig({ recallProbability: 1 }),
    );

    engine.startStreamWithAdapter("你说吧", new InstantAdapter("我昨天看到你了。"));
    // 推进足够长：交付所有气泡 + 撤回延时（1.2~2.5s）
    vi.advanceTimersByTime(20_000);

    const recalls = pick(events, "recall");
    expect(recalls).toHaveLength(1);
    const recall = recalls[0]!.event as IRecallEvent;
    expect(recall.notice).toBe("苏晚晴撤回了一条消息");

    // 撤回的目标必须是本轮最后交付的那条文本气泡
    const delivered = pick(events, "chunk-delivered").map(
      (e) => (e.event as IChunkDeliveredEvent).message,
    );
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    expect(recall.targetMessageId).toBe(delivered[delivered.length - 1]!.id);

    // 撤回发生在 completed 之前（否则 UI 已经收尾，撤回事件会被丢弃）
    const recallIndex = events.indexOf(recalls[0]!);
    const completedIndex = events.findIndex(
      (e) =>
        e.event.kind === "lifecycle" &&
        (e.event as ILifecycleEvent).phase === "completed",
    );
    expect(completedIndex).toBeGreaterThan(recallIndex);
  });

  it("撤回不是秒撤：先留一段时间让人读完，再撤回", () => {
    const { engine, events } = createEngine(
      makeProfile(),
      // 秒回模式下交付是同步的，能干净地只看撤回延时
      makeConfig({ realismEnabled: false, recallProbability: 1 }),
    );

    engine.startStreamWithAdapter("你说吧", new InstantAdapter("我昨天看到你了。"));
    // 内容已交付
    expect(pick(events, "chunk-delivered")).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(pick(events, "recall")).toHaveLength(0);

    // 延时上限 2.5s，再推 2s 必然到点
    vi.advanceTimersByTime(2000);
    expect(pick(events, "recall")).toHaveLength(1);
  });

  it("没设这个旋钮（老存档）时按 0 处理：一句都不撤", () => {
    // makeConfig() 默认就不带 recallProbability，等同于老存档里的配置对象
    const config = makeConfig();
    const { engine, events } = createEngine(makeProfile(), config);

    engine.startStreamWithAdapter("你说吧", new InstantAdapter("我昨天看到你了。"));
    vi.advanceTimersByTime(20_000);

    expect(pick(events, "recall")).toHaveLength(0);
  });

  it("撤回命中的那一轮不再补贴图（撤回后紧跟一张表情很像在揶揄自己）", () => {
    const { engine, events } = createEngine(
      makeProfile({
        personalityTraits: {
          ...makeProfile().personalityTraits,
          stickerFrequency: 1,
        },
      }),
      makeConfig({ recallProbability: 1 }),
    );

    engine.startStreamWithAdapter("你说吧", new InstantAdapter("我昨天看到你了。"));
    vi.advanceTimersByTime(20_000);

    const delivered = pick(events, "chunk-delivered").map(
      (e) => (e.event as IChunkDeliveredEvent).message,
    );
    expect(delivered.some((m) => m.type === "sticker")).toBe(false);
    expect(pick(events, "recall")).toHaveLength(1);
  });

  it("撤回延时里被中止：撤回事件不再发出（用户已经翻篇了）", () => {
    const { engine, events } = createEngine(
      makeProfile(),
      makeConfig({ realismEnabled: false, recallProbability: 1 }),
    );

    engine.startStreamWithAdapter("你说吧", new InstantAdapter("我昨天看到你了。"));
    // 撤回还没到点就中止
    engine.abort("user-abort");
    vi.advanceTimersByTime(20_000);

    expect(pick(events, "recall")).toHaveLength(0);
  });
});
