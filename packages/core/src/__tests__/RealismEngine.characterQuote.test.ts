/**
 * @file RealismEngine.characterQuote.test.ts
 * 角色侧引用的引擎链路：分片切在标记中间也要能认出来，
 * 标记绝不能漏进气泡，引用块只挂在本轮第一条气泡上。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RealismEngine } from "../RealismEngine";
import type { IConnectionTestResult, ILLMAdapter } from "../llm/LLMAdapter";
import type { ILLMAbortHandle, ILLMRequest } from "../llm/types";
import type {
  ICharacterProfile,
  IChunkDeliveredEvent,
  ISimulationConfig,
  ILlmStreamHandlers,
  IRealismEngineOutput,
  ITextMessage,
} from "@wechat-rp/shared-types";

/** 按给定分片推流的适配器（用于复现"分片切在标记中间"）。 */
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

function makeProfile(): ICharacterProfile {
  return {
    id: "char-quote",
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

function makeConfig(overrides: Partial<ISimulationConfig> = {}): ISimulationConfig {
  return {
    realismEnabled: true,
    typingSpeedCpm: "turbo",
    hesitationProbability: 0,
    typoRate: 0,
    fragmentationThresholdChars: 12,
    scheduleAwarenessEnabled: false,
    typingIndicatorEnabled: true,
    typoAutoCorrectEnabled: true,
    maxInterChunkDelayMs: 100,
    ...overrides,
  };
}

function createEngine(
  config: ISimulationConfig = makeConfig(),
): { engine: RealismEngine; events: IRealismEngineOutput[] } {
  const engine = new RealismEngine({
    profile: makeProfile(),
    config,
    sessionId: "s-quote",
    userId: "user",
  });
  const events: IRealismEngineOutput[] = [];
  engine.subscribe((output) => events.push(output));
  return { engine, events };
}

/** 取本轮交付的文本气泡。 */
function deliveredTexts(
  events: ReadonlyArray<IRealismEngineOutput>,
): ReadonlyArray<ITextMessage> {
  return events
    .filter((e) => e.event.kind === "chunk-delivered")
    .map((e) => (e.event as IChunkDeliveredEvent).message)
    .filter((m): m is ITextMessage => m.type === "text");
}

const CANDIDATES = [
  { messageId: "m-1", text: "你今天怎么没来上课？", senderName: "你" },
  { messageId: "m-2", text: "要不要一起去图书馆", senderName: "你" },
];

describe("RealismEngine · 角色引用", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("分片切在标记中间也能认出：气泡里没有标记，第一条挂着引用块", () => {
    const { engine, events } = createEngine();
    engine.setQuoteCandidates(CANDIDATES);

    // 模型输出的分片故意切得很碎，包括切在 【引用： 中间
    engine.startStreamWithAdapter(
      "我今天睡过头了",
      new ScriptedAdapter([
        "happy\n【引",
        "用：你今天怎么没来上课？】",
        "抱歉抱歉，",
        "我睡过头了。",
      ]),
    );
    vi.advanceTimersByTime(20_000);

    const texts = deliveredTexts(events);
    expect(texts.length).toBeGreaterThanOrEqual(1);
    // 标记与标记里的片段都不能漏进气泡
    const joined = texts.map((m) => m.text).join("");
    expect(joined).toContain("抱歉抱歉");
    expect(joined).toContain("我睡过头了。");
    expect(joined).not.toContain("引用");
    expect(joined).not.toContain("】");

    // 引用块挂在第一条气泡上，指向候选里那条消息
    expect(texts[0]!.quote).toEqual({
      messageId: "m-1",
      senderName: "你",
      preview: "你今天怎么没来上课？",
    });
    // 后面的气泡不再重复挂引用
    for (const message of texts.slice(1)) {
      expect(message.quote).toBeUndefined();
    }
  });

  it("标记写在正文末尾（真机遇到过的写法）也不会漏进气泡", () => {
    const { engine, events } = createEngine();
    engine.setQuoteCandidates(CANDIDATES);

    engine.startStreamWithAdapter(
      "你吃饭了吗",
      new ScriptedAdapter([
        "happy\n吃过了，刚吃完晚饭。你呢？ ",
        "【引用：你今天怎么没来上课？】",
      ]),
    );
    vi.advanceTimersByTime(20_000);

    const texts = deliveredTexts(events);
    const joined = texts.map((m) => m.text).join("");
    expect(joined).toContain("吃过了，刚吃完晚饭。你呢？");
    // 格式串绝不能出现在气泡里
    expect(joined).not.toContain("【引用");
    expect(joined).not.toContain("】");
    expect(texts[0]!.quote).toMatchObject({ messageId: "m-1" });
  });

  it("匹配不上候选时只剥掉标记，不挂引用块", () => {
    const { engine, events } = createEngine();
    engine.setQuoteCandidates(CANDIDATES);

    engine.startStreamWithAdapter(
      "嗯",
      new ScriptedAdapter(["neutral\n【引用：海边那家唱片店】我也想去看看。"]),
    );
    vi.advanceTimersByTime(20_000);

    const texts = deliveredTexts(events);
    expect(texts.map((m) => m.text).join("")).toBe("我也想去看看。");
    expect(texts[0]!.quote).toBeUndefined();
  });

  it("没注入候选时不挂引用块（引擎不猜）", () => {
    const { engine, events } = createEngine();

    engine.startStreamWithAdapter(
      "嗯",
      new ScriptedAdapter([
        "neutral\n【引用：你今天怎么没来上课？】我说过的。",
      ]),
    );
    vi.advanceTimersByTime(20_000);

    const texts = deliveredTexts(events);
    expect(texts.map((m) => m.text).join("")).toBe("我说过的。");
    expect(texts[0]!.quote).toBeUndefined();
  });

  it("正文只是以【开头（不是引用标记）时一个字都不动", () => {
    const { engine, events } = createEngine();
    engine.setQuoteCandidates(CANDIDATES);

    engine.startStreamWithAdapter(
      "嗯",
      new ScriptedAdapter(["neutral\n【通知】明天停课一天。"]),
    );
    vi.advanceTimersByTime(20_000);

    expect(deliveredTexts(events).map((m) => m.text).join("")).toBe(
      "【通知】明天停课一天。",
    );
  });

  it("模型给了开头的标记却没写闭括号：正文原样交付，一个字不丢", () => {
    const { engine, events } = createEngine();
    engine.setQuoteCandidates(CANDIDATES);

    engine.startStreamWithAdapter(
      "嗯",
      new ScriptedAdapter(["neutral\n【引用：你今天怎么没来上课？我到教室了。"]),
    );
    vi.advanceTimersByTime(20_000);

    expect(deliveredTexts(events).map((m) => m.text).join("")).toBe(
      "【引用：你今天怎么没来上课？我到教室了。",
    );
  });

  it("秒回模式（关掉拟真）同样剥标记、挂引用块", () => {
    const { engine, events } = createEngine(
      makeConfig({ realismEnabled: false }),
    );
    engine.setQuoteCandidates(CANDIDATES);

    engine.startStreamWithAdapter(
      "嗯",
      new ScriptedAdapter(["happy\n【引用：要不要一起去图书馆】好呀，几点？"]),
    );
    vi.advanceTimersByTime(1000);

    const texts = deliveredTexts(events);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe("好呀，几点？");
    expect(texts[0]!.quote).toEqual({
      messageId: "m-2",
      senderName: "你",
      preview: "要不要一起去图书馆",
    });
  });

  it("整条回复只有引用标记没有正文时不会输出空气泡", () => {
    const { engine, events } = createEngine();
    engine.setQuoteCandidates(CANDIDATES);

    engine.startStreamWithAdapter(
      "嗯",
      new ScriptedAdapter(["neutral\n【引用：你今天怎么没来上课？】"]),
    );
    vi.advanceTimersByTime(20_000);

    expect(deliveredTexts(events)).toHaveLength(0);
  });
});
