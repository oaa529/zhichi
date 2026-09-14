/**
 * @file ErrorBoundary.tsx
 * 界面错误边界：任何渲染期异常都不该变成一片白屏。
 *
 * 由来：这个项目真出过一次白屏——引入 useShallow 时踩到 React 双副本，
 * 整页直接空白，用户既看不到原因，也不知道数据还在不在。
 * 数据都躺在 IndexedDB 里其实没丢，但界面上完全无从判断。
 *
 * 所以兜底界面除了"重新加载"，还提供**导出数据备份**：
 * 备份逻辑直接读 store，不依赖已经崩掉的渲染树，界面挂了也能把数据救出来。
 */

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

export interface IErrorBoundaryProps {
  readonly children: ReactNode;
  /** 崩溃时仍可用的"抢救数据"入口（直接读 store，不经过渲染树）。 */
  readonly onExportData?: () => void;
  /** 自定义标题。 */
  readonly title?: string;
}

interface IErrorBoundaryState {
  readonly error: Error | null;
  /** 导出结果的提示文案。 */
  readonly note: string | null;
}

export class ErrorBoundary extends Component<
  IErrorBoundaryProps,
  IErrorBoundaryState
> {
  public state: IErrorBoundaryState = { error: null, note: null };

  public static getDerivedStateFromError(error: Error): Partial<IErrorBoundaryState> {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    // 留在控制台供排查（兜底界面里也有简版详情）
    console.error("[ErrorBoundary] 界面渲染出错：", error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleExport = (): void => {
    try {
      this.props.onExportData?.();
      this.setState({ note: "备份已开始下载，找找浏览器的下载列表。" });
    } catch (error) {
      console.warn("[ErrorBoundary] 导出失败：", error);
      this.setState({ note: "导出失败，可以换个浏览器或稍后再试。" });
    }
  };

  public render(): ReactNode {
    const { error, note } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="zhichi-error-boundary" role="alert">
        <h1 className="zhichi-error-boundary__title">
          {this.props.title ?? "界面出错了"}
        </h1>
        <p className="zhichi-error-boundary__text">
          角色、聊天记录、记忆和剧情都存在这台设备的浏览器里，
          <strong>没有丢</strong>。重新加载一般就能恢复。
        </p>
        <div className="zhichi-error-boundary__actions">
          {this.props.onExportData && (
            <button
              type="button"
              className="zhichi-error-boundary__btn"
              onClick={this.handleExport}
            >
              先导出一份数据
            </button>
          )}
          <button
            type="button"
            className="zhichi-error-boundary__btn zhichi-error-boundary__btn--primary"
            onClick={this.handleReload}
          >
            重新加载
          </button>
        </div>
        {note && (
          <p className="zhichi-error-boundary__note" role="status">
            {note}
          </p>
        )}
        <details className="zhichi-error-boundary__details">
          <summary>技术细节</summary>
          <pre className="zhichi-error-boundary__trace">
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ""}
          </pre>
        </details>
      </div>
    );
  }
}
