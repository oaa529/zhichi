/**
 * @file MoodTracker.test.ts
 * 心情推导：权重、时间衰减、稀释、强度换算与 Prompt 渲染。
 */

import { describe, it, expect } from "vitest";
import {
  deriveMood,
  moodEmotionForSprite,
  MOOD_HALF_LIFE_MS,
  MOOD_MIN_INTENSITY,
  renderMoodStatePrompt,
  shouldInjectMood,
} from "../emotion/MoodTracker";
import type { CharacterEmotion, IMessage } from "@wechat-rp/shared-types";

const NOW = 1_700_000_000_000;

/** 造一条角色消息（情绪由调用方指定）。 */
function charMessage(
  index: number,
  emotion: CharacterEmotion,
  options: { readonly ageMs?: number; readonly senderId?: string } = {},
): IMessage {
  return {
    id: `m-${index}`,
    type: "text",
    senderId: options.senderId ?? "char-1",
    recipientId: "user",
    sessionId: "s1",
    timestamp: NOW - (options.ageMs ?? 0) + index,
    chunkSequence: index,
    emotion,
    text: `第 ${index} 句`,
    sourceOffset: 0,
  };
}

describe("deriveMood", () => {
  it("没有角色消息时返回 null（不能凭空造心情）", () => {
    expect(deriveMood([], NOW)).toBeNull();
  });

  it("只有用户消息时也返回 null（用户的情绪不是角色的心情）", () => {
    const messages = [
      charMessage(1, "angry", { senderId: "user" }),
      charMessage(2, "happy", { senderId: "user" }),
    ];

    expect(deriveMood(messages, NOW)).toBeNull();
  });

  it("一条新鲜的情绪 = 强度 3（有些）", () => {
    const mood = deriveMood([charMessage(1, "sad")], NOW);

    expect(mood).toMatchObject({ emotion: "sad", intensity: 3, sourceCount: 1 });
  });

  it("连着两条同向情绪，强度升到 4", () => {
    const mood = deriveMood(
      [charMessage(1, "angry"), charMessage(2, "angry")],
      NOW,
    );

    expect(mood?.emotion).toBe("angry");
    expect(mood?.intensity).toBeGreaterThanOrEqual(4);
  });

  it("最近一条压过更早的那些（刚说完的话最能代表此刻）", () => {
    const mood = deriveMood(
      [
        charMessage(1, "happy"),
        charMessage(2, "happy"),
        charMessage(3, "happy"),
        charMessage(4, "sad"),
      ],
      NOW,
    );

    expect(mood?.emotion).toBe("sad");
  });

  it("平淡的话会把情绪稀释掉（聊几句就回落到平静）", () => {
    const mood = deriveMood(
      [
        charMessage(1, "angry"),
        charMessage(2, "neutral"),
        charMessage(3, "neutral"),
        charMessage(4, "neutral"),
      ],
      NOW,
    );

    // 情绪还在（最早那条还有残余权重），但已经不值得注入 Prompt
    expect(mood?.emotion === "neutral" || mood!.intensity < 3).toBe(true);
    expect(shouldInjectMood(mood)).toBe(false);
  });

  it("时间会冲淡心情：两小时前的情绪强度只剩一半", () => {
    const fresh = deriveMood([charMessage(1, "angry")], NOW);
    const stale = deriveMood(
      [charMessage(1, "angry", { ageMs: MOOD_HALF_LIFE_MS })],
      NOW,
    );

    expect(fresh!.intensity).toBe(3);
    expect(stale!.intensity).toBeLessThan(fresh!.intensity);
    expect(stale!.intensity).toBeLessThan(MOOD_MIN_INTENSITY);
  });

  it("只看最近若干条，很早之前的情绪不再参与", () => {
    const messages: IMessage[] = [
      charMessage(0, "angry"),
      ...Array.from({ length: 9 }, (_, i) => charMessage(i + 1, "happy")),
    ];

    expect(deriveMood(messages, NOW)?.emotion).toBe("happy");
  });

  it("角色发的贴图也算情绪证据（贴图本身带着情绪）", () => {
    const sticker: IMessage = {
      id: "st-1",
      type: "sticker",
      senderId: "char-1",
      recipientId: "user",
      sessionId: "s1",
      timestamp: NOW,
      chunkSequence: 0,
      emotion: "happy",
      stickerPackId: "basic",
      stickerId: "smile",
      fallbackText: "[微笑]",
    };

    expect(deriveMood([sticker], NOW)).toMatchObject({
      emotion: "happy",
      intensity: 3,
    });
  });

  it("系统消息与撤回提示不参与（它们没有情绪可言）", () => {
    const system: IMessage = {
      id: "sys-1",
      type: "system",
      senderId: "char-1",
      recipientId: "user",
      sessionId: "s1",
      timestamp: NOW,
      chunkSequence: 0,
      emotion: "angry",
      systemKind: "time-divider",
      displayText: "昨天 20:00",
    };

    expect(deriveMood([system], NOW)).toBeNull();
  });
});

describe("shouldInjectMood / renderMoodStatePrompt", () => {
  it("平静或强度不足时不注入", () => {
    expect(shouldInjectMood(null)).toBe(false);
    expect(shouldInjectMood({ emotion: "neutral", intensity: 5, sourceCount: 3 })).toBe(false);
    expect(shouldInjectMood({ emotion: "happy", intensity: 2, sourceCount: 1 })).toBe(false);
    expect(renderMoodStatePrompt({ emotion: "happy", intensity: 2, sourceCount: 1 })).toBe("");
  });

  it("值得注入时给出心情、程度与「允许反转」的说明", () => {
    const prompt = renderMoodStatePrompt({
      emotion: "sad",
      intensity: 4,
      sourceCount: 3,
    });

    expect(prompt).toContain("【你此刻的心情】");
    expect(prompt).toContain("低落");
    expect(prompt).toContain("比较明显");
    // 不能把模型钉死在这个情绪上：要留出"被对方改变"的余地
    expect(prompt).toContain("情绪变了");
  });
});

describe("moodEmotionForSprite", () => {
  it("值得注入的心情才拿去当立绘兜底", () => {
    expect(moodEmotionForSprite({ emotion: "angry", intensity: 4, sourceCount: 2 })).toBe("angry");
    expect(moodEmotionForSprite({ emotion: "neutral", intensity: 5, sourceCount: 2 })).toBeNull();
    expect(moodEmotionForSprite({ emotion: "sad", intensity: 2, sourceCount: 1 })).toBeNull();
    expect(moodEmotionForSprite(null)).toBeNull();
  });
});
