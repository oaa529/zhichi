/**
 * @file PinnedSprite.test.tsx
 * 固定立绘：显隐过渡与情绪交叉淡入。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { ICharacterProfile } from "@wechat-rp/shared-types";
import { PinnedSprite } from "../components/PinnedSprite";

function makeProfile(pinned: boolean): ICharacterProfile {
  return {
    id: "char-1",
    displayName: "苏晚晴",
    bio: "",
    visualMetadata: {
      avatarUrl: "",
      sprites: [
        { emotion: "neutral", url: "data:image/svg+xml,neutral" },
        { emotion: "happy", url: "data:image/svg+xml,happy" },
      ],
      supportsPinSprite: true,
      defaultSpriteAnchor: "left",
      spritePinned: pinned,
    },
    schedule: {
      wakeTime: "07:30",
      sleepTime: "23:30",
      scheduleEnabled: false,
      timezone: "Asia/Shanghai",
      sleepReplyPolicy: "drowsy-burst",
    },
    personalityTraits: {
      archetype: "gentle",
      typingSpeedMultiplier: 1,
      fragmentationBias: 0.5,
      hesitationProbability: 0.1,
      typoRate: 0,
      stickerFrequency: 0,
    },
    promptTemplateId: "",
  };
}

/** 取固定立绘图层（它挂在 body 上）。 */
function layer(): HTMLElement | null {
  return document.querySelector(".wechat-avatar__pinned-sprite");
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PinnedSprite", () => {
  it("没有立绘的角色不渲染这个图层", () => {
    const base = makeProfile(true);
    const bare: ICharacterProfile = {
      ...base,
      visualMetadata: { ...base.visualMetadata, sprites: [] },
    };
    render(<PinnedSprite profile={bare} />);
    expect(layer()).toBeNull();
  });

  it("关闭固定立绘时图层在但不可见（靠过渡淡出，不是直接卸载）", () => {
    render(<PinnedSprite profile={makeProfile(false)} emotion="neutral" />);
    expect(layer()?.getAttribute("data-visible")).toBe("false");
  });

  it("开启时按当前情绪渲染对应立绘", () => {
    render(<PinnedSprite profile={makeProfile(true)} emotion="happy" />);
    const img = layer()?.querySelector("img");
    expect(layer()?.getAttribute("data-visible")).toBe("true");
    expect(img?.getAttribute("src")).toContain("happy");
  });

  it("情绪切换时新旧两张叠在一起做交叉淡入，动画结束后旧图被移除", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <PinnedSprite profile={makeProfile(true)} emotion="neutral" />,
    );
    expect(layer()?.querySelectorAll("img")).toHaveLength(1);

    rerender(<PinnedSprite profile={makeProfile(true)} emotion="happy" />);

    const imgs = layer()?.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    expect(
      layer()?.querySelector(".wechat-avatar__pinned-sprite-img--out")?.getAttribute("src"),
    ).toContain("neutral");
    expect(
      layer()?.querySelector(".wechat-avatar__pinned-sprite-img--in")?.getAttribute("src"),
    ).toContain("happy");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(layer()?.querySelectorAll("img")).toHaveLength(1);
  });

  it("情绪没有对应立绘时退回第一张（不会渲染成空白）", () => {
    render(<PinnedSprite profile={makeProfile(true)} emotion="angry" />);
    expect(layer()?.querySelector("img")?.getAttribute("src")).toContain("neutral");
  });
});
