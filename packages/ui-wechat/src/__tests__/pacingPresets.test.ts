/**
 * @file pacingPresets.test.ts
 * 节奏预设映射测试。
 */

import { describe, it, expect } from "vitest";
import { PACING_PRESETS, getPacingPreset } from "../utils/pacingPresets";

describe("PACING_PRESETS", () => {
  it("提供三档预设且 id 唯一", () => {
    expect(PACING_PRESETS).toHaveLength(3);
    const ids = PACING_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("每档都覆盖打字速度 / 犹豫概率 / 气泡间隔上限", () => {
    for (const preset of PACING_PRESETS) {
      expect(preset.patch.typingSpeedCpm).toBeDefined();
      expect(preset.patch.hesitationProbability).toBeGreaterThanOrEqual(0);
      expect(preset.patch.maxInterChunkDelayMs).toBeGreaterThan(0);
    }
  });

  it("轻快档比慢热档更快、间隔更短", () => {
    const chatty = getPacingPreset("chatty")!;
    const slow = getPacingPreset("slow")!;

    const speedRank = { turbo: 4, fast: 3, normal: 2, slow: 1 } as const;
    expect(speedRank[chatty.patch.typingSpeedCpm!]).toBeGreaterThan(
      speedRank[slow.patch.typingSpeedCpm!],
    );
    expect(chatty.patch.maxInterChunkDelayMs!).toBeLessThan(
      slow.patch.maxInterChunkDelayMs!,
    );
    expect(chatty.patch.hesitationProbability!).toBeLessThan(
      slow.patch.hesitationProbability!,
    );
  });

  it("未知 id 返回 null", () => {
    expect(getPacingPreset("unknown")).toBeNull();
  });
});
