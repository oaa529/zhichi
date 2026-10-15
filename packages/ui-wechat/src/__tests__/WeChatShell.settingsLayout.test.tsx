/**
 * @file WeChatShell.settingsLayout.test.tsx
 * 设置面板的版面：切到「设置」后要占满主区，而不是挤在侧边栏里。
 *
 * 背景（实测来的）：设置原本渲染在 300px 的 `zhichi-shell__sidebar` 里，
 * 五个子 Tab 的文字被压成竖排两行（「关于/你」「备/份」），
 * 长标签字段的控件被挤到 25~41px——「一句话背景」那个 textarea 只剩
 * 28px 宽，基本没法用。修法是设置整块接管主区。
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { WeChatShell } from "../components/WeChatShell";

afterEach(cleanup);

/** 渲染一个壳；设置相关断言都要经过它，避免各处重复搭壳。 */
function renderShell() {
  return render(
    <WeChatShell title="咫尺">
      <div data-testid="chat-children">聊天主区</div>
    </WeChatShell>,
  );
}

/** 从左侧竖排导航里点「设置」。 */
function clickSettingsTab() {
  const tabs = document.querySelectorAll(".zhichi-tab-bar__item");
  const settingsTab = Array.from(tabs).find((el) =>
    (el.textContent ?? "").includes("设置"),
  );
  expect(settingsTab).toBeTruthy();
  fireEvent.click(settingsTab!);
}

describe("WeChatShell · 设置版面", () => {
  it("默认在聊天：侧栏在、设置不在主区", () => {
    renderShell();

    expect(document.querySelector(".zhichi-shell__sidebar")).toBeTruthy();
    expect(document.querySelector(".zhichi-settings")).toBeNull();
    expect(screen.getByTestId("chat-children")).toBeTruthy();
  });

  it("切到设置：侧栏和拖拽条收起，设置进主区", () => {
    renderShell();
    clickSettingsTab();

    expect(document.querySelector(".zhichi-shell__sidebar")).toBeNull();
    expect(document.querySelector(".zhichi-shell__resizer")).toBeNull();
    expect(document.querySelector(".zhichi-shell__main .zhichi-settings")).toBeTruthy();
    // 聊天内容让位给设置
    expect(screen.queryByTestId("chat-children")).toBeNull();
  });

  it("设置时主区标题写「设置」，且不显示在场状态与上下文用量", () => {
    renderShell();
    clickSettingsTab();

    expect(document.querySelector(".zhichi-shell__main-title")?.textContent).toBe("设置");
    expect(document.querySelector(".zhichi-shell__main-presence")).toBeNull();
  });

  it("从设置切回聊天：侧栏回来、设置撤走、聊天内容复原", () => {
    renderShell();
    clickSettingsTab();

    const tabs = document.querySelectorAll(".zhichi-tab-bar__item");
    const chatTab = Array.from(tabs).find((el) =>
      (el.textContent ?? "").includes("聊天"),
    );
    fireEvent.click(chatTab!);

    expect(document.querySelector(".zhichi-shell__sidebar")).toBeTruthy();
    expect(document.querySelector(".zhichi-settings")).toBeNull();
    expect(screen.getByTestId("chat-children")).toBeTruthy();
  });

  it("设置里五个子 Tab 文字完整、顺序不乱", () => {
    renderShell();
    clickSettingsTab();

    const tabs = within(document.querySelector(".zhichi-settings__tabs")!).getAllByRole(
      "tab",
    );
    expect(tabs.map((el) => el.textContent?.trim())).toEqual([
      "模型",
      "拟真",
      "关于你",
      "记忆",
      "备份",
    ]);
  });
});