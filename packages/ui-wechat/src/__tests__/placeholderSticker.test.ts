/**
 * @file placeholderSticker.test.ts
 * 内置贴图素材：每个 ID 都要能画出来，未知 ID 退回默认表情。
 */

import { describe, it, expect } from "vitest";
import { BASIC_STICKERS } from "@wechat-rp/core";
import { buildPlaceholderSticker } from "../utils/placeholderSticker";

/** data URL → 原始 SVG 文本（便于断言内容）。 */
function decode(dataUrl: string): string {
  expect(dataUrl.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  return decodeURIComponent(dataUrl.slice("data:image/svg+xml;charset=utf-8,".length));
}

describe("buildPlaceholderSticker", () => {
  it("贴图目录里的每个 ID 都能生成有效 SVG", () => {
    for (const sticker of BASIC_STICKERS) {
      const svg = decode(buildPlaceholderSticker(sticker.id));
      expect(svg).toContain("<svg xmlns=");
      expect(svg).toContain('viewBox="0 0 120 120"');
      expect(svg).toContain("</svg>");
    }
  });

  it("不同 ID 画出不同的表情", () => {
    const smile = buildPlaceholderSticker("smile");
    const cry = buildPlaceholderSticker("cry");
    expect(smile).not.toBe(cry);
  });

  it("未知 ID 退回默认表情（不会渲染出空白）", () => {
    expect(buildPlaceholderSticker("从来没见过的id")).toBe(
      buildPlaceholderSticker("smile"),
    );
  });

  it("SVG 是自包含的（不引用外部资源）", () => {
    const svg = decode(buildPlaceholderSticker("grin"));
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("href=");
    expect(svg).not.toContain("url(http");
  });
});
