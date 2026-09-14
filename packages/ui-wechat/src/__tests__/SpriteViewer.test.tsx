/**
 * @file SpriteViewer.test.tsx
 * 立绘查看器：中文情绪名、键盘操作、缩略图跳转、固定立绘开关。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ICharacterProfile, ICharacterSprite } from "@wechat-rp/shared-types";
import { SpriteViewer } from "../components/SpriteViewer";

const SPRITES: ReadonlyArray<ICharacterSprite> = [
  { emotion: "neutral", url: "data:image/svg+xml,neutral" },
  {
    emotion: "happy",
    url: "data:image/svg+xml,happy",
    // 上传时生成的 96px 缩略图（缩略图条应当优先用它）
    thumbnailUrl: "data:image/svg+xml,happy-thumb",
  },
  { emotion: "sad", url: "data:image/svg+xml,sad" },
];

function makeProfile(): ICharacterProfile {
  return {
    id: "char-1",
    displayName: "苏晚晴",
    bio: "",
    visualMetadata: {
      avatarUrl: "",
      sprites: [...SPRITES],
      supportsPinSprite: true,
      defaultSpriteAnchor: "left",
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

interface IHandlers {
  readonly onClose: ReturnType<typeof vi.fn>;
  readonly onTogglePin: ReturnType<typeof vi.fn>;
}

function renderViewer(initial = SPRITES[0]!, pinned = false): IHandlers {
  const onClose = vi.fn();
  const onTogglePin = vi.fn();
  render(
    <SpriteViewer
      profile={makeProfile()}
      initialSprite={initial}
      onClose={onClose}
      onTogglePin={onTogglePin}
      pinSpriteEnabled={pinned}
    />,
  );
  return { onClose, onTogglePin };
}

/** 舞台里是否已经出现某张立绘（交叉淡入时新旧两张会同时存在）。 */
function stageHas(part: string): boolean {
  const stage = document.querySelector(".wechat-sprite-viewer__stage");
  return Array.from(stage?.querySelectorAll("img") ?? []).some((img) =>
    (img.getAttribute("src") ?? "").includes(part),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SpriteViewer", () => {
  it("打开时显示初始立绘，情绪名是中文（不是英文枚举）", () => {
    renderViewer(SPRITES[1]!);
    expect(stageHas("happy")).toBe(true);
    expect(screen.getByText("开心")).toBeTruthy();
    expect(screen.queryByText("happy")).toBeNull();
  });

  it("键盘左右切换情绪、Esc 关闭", () => {
    const { onClose } = renderViewer(SPRITES[0]!);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(stageHas("happy")).toBe(true);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(stageHas("sad")).toBe(true);

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(stageHas("happy")).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("首尾时键盘不会越界", () => {
    renderViewer(SPRITES[0]!);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(stageHas("neutral")).toBe(true);
  });

  it("缩略图条可以直接跳到任意情绪", () => {
    renderViewer(SPRITES[0]!);

    const thumbs = screen.getAllByRole("tab");
    expect(thumbs).toHaveLength(3);
    expect(thumbs[0]!.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(thumbs[2]!);

    expect(stageHas("sad")).toBe(true);
    expect(screen.getByText("难过")).toBeTruthy();
    expect(thumbs[2]!.getAttribute("aria-selected")).toBe("true");
  });

  it("缩略图带情绪中文名（悬停/读屏都能认出来）", () => {
    renderViewer(SPRITES[0]!);
    expect(screen.getByRole("tab", { name: "开心" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "难过" })).toBeTruthy();
  });

  it("缩略图条优先用 96px 缩略图（没有才回退大图）", () => {
    renderViewer(SPRITES[0]!);
    const thumbs = screen.getAllByRole("tab");

    const happyThumb = thumbs[1]!.querySelector("img")!;
    expect(happyThumb.getAttribute("src")).toBe("data:image/svg+xml,happy-thumb");

    // 没配缩略图的那几张回退到完整立绘
    const sadThumb = thumbs[2]!.querySelector("img")!;
    expect(sadThumb.getAttribute("src")).toBe("data:image/svg+xml,sad");
  });

  it("切换固定立绘开关会回调父级", () => {
    const { onTogglePin } = renderViewer(SPRITES[0]!, false);

    fireEvent.click(screen.getByRole("checkbox"));

    expect(onTogglePin).toHaveBeenCalledWith(true);
  });

  it("箭头按钮在首尾禁用", () => {
    renderViewer(SPRITES[0]!);
    const buttons = screen.getAllByRole("button");
    // 第一个是 ◀（禁用），最后一个是关闭 🗙 之前那个 ▶
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
  });
});
