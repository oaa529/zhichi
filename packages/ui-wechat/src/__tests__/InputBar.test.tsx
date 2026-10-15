/**
 * @file InputBar.test.tsx
 * 输入栏：表情面板（用户发贴图）+ 高度把手（手动拉高/压低）。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BASIC_STICKERS } from "@wechat-rp/core";
import { InputBar } from "../components/InputBar";

/**
 * jsdom 没有实现 PointerEvent，testing-library 只能退化成普通 Event——
 * 那样 `clientY` 是 undefined，拖拽位移会算出 NaN，高度永远落不下来。
 * 这里按 jsdom 的缺口补一个继承 MouseEvent 的最小实现，
 * 让 fireEvent.pointerX 能带上坐标（浏览器里本来就是 PointerEvent）。
 */
if (!("PointerEvent" in window)) {
  class TestPointerEvent extends MouseEvent {
    public readonly pointerId: number;
    public readonly isPrimary: boolean;
    public readonly pointerType: string;

    public constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
    TestPointerEvent;
  (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
    TestPointerEvent;
}

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

/** 输入框当前被写死的高度（handle 拖 / 方向键都作用在这个内联样式上）。 */
function textareaHeight(): string {
  const el = document.querySelector<HTMLTextAreaElement>(
    ".zhichi-input-bar__textarea",
  );
  return el?.style.height ?? "";
}

/** 把手（role=separator，水平方向）。 */
function getResizer(): HTMLElement {
  return screen.getByRole("separator", { name: "拖动调整输入框高度" });
}

describe("InputBar · 高度把手", () => {
  it("把手可聚焦、水平朝向，并给出当前高度区间", () => {
    renderBar();

    const handle = getResizer();
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-valuemin")).toBe("37");
    // 上限跟着窗口走：至少 220
    expect(Number(handle.getAttribute("aria-valuemax"))).toBeGreaterThanOrEqual(
      220,
    );
  });

  it("向上拖：输入框按位移长高", () => {
    renderBar();
    const handle = getResizer();

    fireEvent.pointerDown(handle, { button: 0, clientY: 300 });
    fireEvent.pointerMove(handle, { clientY: 200 });
    fireEvent.pointerUp(handle, { clientY: 200 });

    // 往上拖 100px → 37（量不到布局时的下限基准）+ 100
    expect(textareaHeight()).toBe("137px");
    expect(Number(getResizer().getAttribute("aria-valuenow"))).toBe(137);
  });

  it("往下拖：输入框按位移压矮", () => {
    renderBar();
    const handle = getResizer();

    fireEvent.pointerDown(handle, { button: 0, clientY: 200 });
    fireEvent.pointerMove(handle, { clientY: 260 });
    fireEvent.pointerUp(handle, { clientY: 260 });

    // 往下拖 60px → 37 - 60 低于下限 → 交回自动增高
    expect(textareaHeight()).toBe("0px");
  });

  it("拖到下限时：正好一行高可以停住，再往下就交回自动增高", () => {
    renderBar();
    const handle = getResizer();

    // 从下限 37 往下拖 10px → 27，低于下限 → 交回自动增高
    fireEvent.pointerDown(handle, { button: 0, clientY: 300 });
    fireEvent.pointerMove(handle, { clientY: 310 });
    fireEvent.pointerUp(handle, { clientY: 310 });

    // 自动模式：高度交给内容，jsdom 里 scrollHeight 为 0
    expect(textareaHeight()).toBe("0px");
  });

  it("松手后标记复位（data-resizing 撤掉）", () => {
    renderBar();
    const handle = getResizer();

    fireEvent.pointerDown(handle, { button: 0, clientY: 300 });
    expect(getResizer().getAttribute("data-resizing")).toBe("true");

    fireEvent.pointerUp(handle, { clientY: 300 });
    expect(getResizer().getAttribute("data-resizing")).toBe("false");
  });

  it("方向键也能调高度：↑ 每次一档，Shift+↑ 一次一大档", () => {
    renderBar();
    const handle = getResizer();

    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(textareaHeight()).toBe("61px"); // 起点 37 + 24

    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(textareaHeight()).toBe("85px");

    fireEvent.keyDown(handle, { key: "ArrowUp", shiftKey: true });
    expect(textareaHeight()).toBe("157px");
  });

  it("ArrowDown 压低，压过下限就还回自动增高", () => {
    renderBar();
    const handle = getResizer();

    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(textareaHeight()).toBe("61px");

    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(textareaHeight()).toBe("37px");

    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(textareaHeight()).toBe("0px");
  });

  it("Home 一键还回自动增高", () => {
    renderBar();
    const handle = getResizer();

    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(textareaHeight()).not.toBe("0px");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(textareaHeight()).toBe("0px");
  });

  it("手动拉高过的高度不会被自动增高覆盖（发完消息也留着）", () => {
    const { rerender } = render(
      <InputBar
        value="第一段"
        onChange={() => {}}
        onSubmit={() => {}}
        disabled={false}
      />,
    );
    const handle = getResizer();

    fireEvent.pointerDown(handle, { button: 0, clientY: 400 });
    fireEvent.pointerMove(handle, { clientY: 200 });
    fireEvent.pointerUp(handle, { clientY: 200 });
    expect(textareaHeight()).toBe("237px"); // 37 + 200

    // 内容变化（父级换 value）不该把手动高度拽回自动值
    rerender(
      <InputBar value="" onChange={() => {}} onSubmit={() => {}} disabled={false} />,
    );
    expect(textareaHeight()).toBe("237px");
  });

  it("拉高超过一行高时切到圆角矩形（多行不该还用胶囊圆角）", () => {
    renderBar();
    const handle = getResizer();

    fireEvent.pointerDown(handle, { button: 0, clientY: 400 });
    fireEvent.pointerMove(handle, { clientY: 260 });
    fireEvent.pointerUp(handle, { clientY: 260 });

    const el = document.querySelector<HTMLTextAreaElement>(
      ".zhichi-input-bar__textarea",
    );
    expect(el?.dataset.tall).toBe("true");
  });
});
