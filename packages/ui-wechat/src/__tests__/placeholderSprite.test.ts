/**
 * @file placeholderSprite.test.ts
 * 内置占位素材：自包含、确定性、转义正确。
 */

import { describe, it, expect } from "vitest";
import {
  buildPlaceholderAvatar,
  buildPlaceholderSprite,
} from "../utils/placeholderSprite";

/** 把 data URL 还原成 SVG 文本，方便断言。 */
function decode(dataUrl: string): string {
  expect(dataUrl.startsWith("data:image/svg+xml")).toBe(true);
  return decodeURIComponent(dataUrl.split(",")[1] ?? "");
}

describe("buildPlaceholderSprite", () => {
  it("产出内联 SVG，不依赖网络", () => {
    const url = buildPlaceholderSprite("苏晚晴", "happy", 210);
    expect(url.startsWith("data:image/svg+xml")).toBe(true);
    expect(url).not.toContain("http://");
    expect(url).not.toContain("https://");
  });

  it("带上角色名与情绪标签", () => {
    const svg = decode(buildPlaceholderSprite("林笑笑", "sleepy", 25));
    expect(svg).toContain("林笑笑");
    expect(svg).toContain("困倦");
  });

  it("同输入结果稳定（可安全重复生成）", () => {
    const a = buildPlaceholderSprite("苏晚晴", "neutral", 210);
    const b = buildPlaceholderSprite("苏晚晴", "neutral", 210);
    expect(a).toBe(b);
  });

  it("不同情绪画出不同表情", () => {
    const happy = decode(buildPlaceholderSprite("苏晚晴", "happy", 210));
    const sad = decode(buildPlaceholderSprite("苏晚晴", "sad", 210));
    expect(happy).not.toBe(sad);
  });

  it("名字里的 XML 特殊字符被转义（不会画出坏掉的 SVG）", () => {
    const svg = decode(buildPlaceholderSprite('A<b>&"c"', "neutral", 120));
    expect(svg).toContain("&lt;b&gt;");
    expect(svg).toContain("&amp;");
    expect(svg).not.toContain("<b>");
  });
});

describe("buildPlaceholderAvatar", () => {
  it("取名字首字并内联", () => {
    const svg = decode(buildPlaceholderAvatar("苏晚晴", 210));
    expect(svg).toContain(">苏<");
    expect(svg).toContain("viewBox=\"0 0 256 256\"");
  });

  it("空名字退化为问号（不产出空文本节点）", () => {
    const svg = decode(buildPlaceholderAvatar("   ", 210));
    expect(svg).toContain(">?<");
  });
});
