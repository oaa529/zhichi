/**
 * @file InputBar.test.tsx
 * 输入栏的表情面板（用户发贴图）。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BASIC_STICKERS } from "@wechat-rp/core";
import { InputBar } from "../components/InputBar";

function renderBar(onSendSticker?: (sticker: {
  stickerPackId: string;
  stickerId: string;
  fallbackText: string;
}) => void) {
  render(
    <InputBar
      value=""
      onChange={() => {}}
      onSubmit={() => {}}
      disabled={false}
      onSendSticker={onSendSticker}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("InputBar · 表情面板", () => {
  it("没接贴图能力时不显示表情按钮", () => {
    renderBar();
    expect(screen.queryByRole("button", { name: "表情" })).toBeNull();
  });

  it("点表情按钮弹出面板，内置表情都在（带无障碍名）", () => {
    renderBar(vi.fn());
    expect(screen.queryByRole("dialog", { name: "选择表情" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "表情" }));

    expect(screen.getByRole("dialog", { name: "选择表情" })).toBeTruthy();
    for (const sticker of BASIC_STICKERS) {
      expect(screen.getByRole("button", { name: sticker.fallbackText })).toBeTruthy();
    }
  });

  it("点一个表情：回调拿到贴图标识，面板自动收起", () => {
    const onSendSticker = vi.fn();
    renderBar(onSendSticker);
    fireEvent.click(screen.getByRole("button", { name: "表情" }));

    fireEvent.click(screen.getByRole("button", { name: "[开心]" }));

    expect(onSendSticker).toHaveBeenCalledWith({
      stickerPackId: "zhichi-basic",
      stickerId: "grin",
      fallbackText: "[开心]",
    });
    expect(screen.queryByRole("dialog", { name: "选择表情" })).toBeNull();
  });

  it("再点一次表情按钮可以收起面板", () => {
    renderBar(vi.fn());
    const button = screen.getByRole("button", { name: "表情" });

    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "选择表情" })).toBeTruthy();

    fireEvent.click(button);
    expect(screen.queryByRole("dialog", { name: "选择表情" })).toBeNull();
  });
});
