/**
 * @file Stickers.test.ts
 * 内置贴图目录：情绪覆盖与兜底。
 */

import { describe, it, expect } from "vitest";
import type { CharacterEmotion } from "@wechat-rp/shared-types";
import {
  BASIC_STICKERS,
  findStickerById,
  pickSticker,
  STICKER_PACK_ID,
} from "../sticker/Stickers";

const ALL_EMOTIONS: ReadonlyArray<CharacterEmotion> = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "shy",
  "surprised",
  "thinking",
  "sleepy",
];

describe("内置贴图", () => {
  it("八种情绪每种都有贴图（不会有情绪发不出表情）", () => {
    for (const emotion of ALL_EMOTIONS) {
      const sticker = pickSticker(emotion);
      expect(sticker.emotion).toBe(emotion);
      expect(sticker.id.length).toBeGreaterThan(0);
      // 表情名是微信风格：[xx]
      expect(sticker.fallbackText).toMatch(/^\[.+\]$/);
    }
  });

  it("贴图 ID 唯一（否则 UI 会画出同一张脸）", () => {
    const ids = BASIC_STICKERS.map((sticker) => sticker.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("按 ID 查找找不到时返回 null", () => {
    expect(findStickerById("grin")?.fallbackText).toBe("[开心]");
    expect(findStickerById("不存在")).toBeNull();
  });

  it("贴图包 ID 固定（落库数据要能对上）", () => {
    expect(STICKER_PACK_ID).toBe("zhichi-basic");
  });
});
