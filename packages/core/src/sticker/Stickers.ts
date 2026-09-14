/**
 * @file Stickers.ts
 * 内置贴图目录：角色按 `stickerFrequency` 概率发的那张表情。
 *
 * 用内置而不是外链：贴图是聊天的高频内容，外链一旦失效满屏破图；
 * 内置一套按情绪索引的简笔贴图，任何角色开箱即用（配图见 UI 层的
 * `buildPlaceholderSticker`，按 stickerId 现画 SVG）。
 *
 * 纯函数，可直接单测。
 */

import type { CharacterEmotion } from "@wechat-rp/shared-types";

/** 内置贴图包 ID。 */
export const STICKER_PACK_ID = "zhichi-basic";

/** 一张内置贴图。 */
export interface IStickerAsset {
  /** 贴图 ID（UI 据此现画 SVG）。 */
  readonly id: string;
  /** 对应的情绪（角色当前情绪决定发哪张）。 */
  readonly emotion: CharacterEmotion;
  /** 微信风格的表情名，用于降级显示与无障碍文本。 */
  readonly fallbackText: string;
}

/** 八个情绪各一张，顺序与情绪枚举一致。 */
export const BASIC_STICKERS: ReadonlyArray<IStickerAsset> = [
  { id: "smile", emotion: "neutral", fallbackText: "[微笑]" },
  { id: "grin", emotion: "happy", fallbackText: "[开心]" },
  { id: "cry", emotion: "sad", fallbackText: "[流泪]" },
  { id: "rage", emotion: "angry", fallbackText: "[发怒]" },
  { id: "shy", emotion: "shy", fallbackText: "[害羞]" },
  { id: "wow", emotion: "surprised", fallbackText: "[惊讶]" },
  { id: "think", emotion: "thinking", fallbackText: "[思考]" },
  { id: "sleepy", emotion: "sleepy", fallbackText: "[睡]" },
];

/** 情绪 → 贴图；没有对应情绪时退回"微笑"。 */
export function pickSticker(emotion: CharacterEmotion): IStickerAsset {
  return (
    BASIC_STICKERS.find((sticker) => sticker.emotion === emotion) ??
    BASIC_STICKERS[0]!
  );
}

/** 按 ID 取贴图（UI 渲染时用；找不到返回 null）。 */
export function findStickerById(id: string): IStickerAsset | null {
  return BASIC_STICKERS.find((sticker) => sticker.id === id) ?? null;
}
