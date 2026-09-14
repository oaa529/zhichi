/**
 * @file emotionLabel.test.ts
 * 情绪中文标签：八种全覆盖、未知值不显示空白。
 */

import { describe, it, expect } from "vitest";
import type { CharacterEmotion } from "@wechat-rp/shared-types";
import { EMOTION_LABELS, emotionLabel } from "../utils/emotionLabel";

const ALL: ReadonlyArray<CharacterEmotion> = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "shy",
  "surprised",
  "thinking",
  "sleepy",
];

describe("emotionLabel", () => {
  it("八种情绪都有中文名（不会露出英文枚举）", () => {
    for (const emotion of ALL) {
      const label = emotionLabel(emotion);
      expect(label).toBeTruthy();
      expect(label).not.toBe(emotion);
      expect(label).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it("未知值原样返回（宁可显示原值也不显示空白）", () => {
    expect(emotionLabel("puzzled")).toBe("puzzled");
  });

  it("映射表覆盖全部枚举（新增情绪时这里会先失败）", () => {
    expect(Object.keys(EMOTION_LABELS).sort()).toEqual([...ALL].sort());
  });
});
