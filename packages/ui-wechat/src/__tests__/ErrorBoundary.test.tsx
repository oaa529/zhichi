/**
 * @file ErrorBoundary.test.tsx
 * 错误边界：子组件抛错时显示兜底界面，而不是白屏。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ReactElement } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary";

/** 渲染即抛错的组件。 */
function Boom(): ReactElement {
  throw new Error("渲染炸了");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** React 会把渲染期异常打到 console.error，测试里静音掉。 */
function silenceConsole(): void {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("ErrorBoundary", () => {
  it("正常子组件原样渲染", () => {
    render(
      <ErrorBoundary>
        <p>一切正常</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("一切正常")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("子组件抛错时显示兜底界面，并说明数据没丢", () => {
    silenceConsole();
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("界面出错了")).toBeTruthy();
    expect(screen.getByText(/没有丢/)).toBeTruthy();
    // 技术细节折叠区里有原始错误信息
    expect(screen.getByText(/渲染炸了/)).toBeTruthy();
  });

  it("点「先导出一份数据」会调用导出回调并给出反馈", () => {
    silenceConsole();
    const onExportData = vi.fn();
    render(
      <ErrorBoundary onExportData={onExportData}>
        <Boom />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByText("先导出一份数据"));

    expect(onExportData).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("备份已开始下载");
  });

  it("导出回调抛错时兜底界面不跟着崩", () => {
    silenceConsole();
    const onExportData = vi.fn(() => {
      throw new Error("下载被拦截");
    });
    render(
      <ErrorBoundary onExportData={onExportData}>
        <Boom />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByText("先导出一份数据"));

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("导出失败");
  });

  it("没传导出回调时不显示那个按钮", () => {
    silenceConsole();
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.queryByText("先导出一份数据")).toBeNull();
    expect(screen.getByText("重新加载")).toBeTruthy();
  });
});
