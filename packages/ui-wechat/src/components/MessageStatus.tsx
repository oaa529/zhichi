/**
 * @file MessageStatus.tsx
 * 消息三态状态条（loading / error / sent）。
 *
 * 在消息气泡底部显示状态指示：
 * - loading：动画圆点（流式生成中）
 * - error：红色"发送失败"，带重试按钮
 * - sent：不显示（默认态）
 */

import { memo } from "react";
import type { FC } from "react";

export type MessageStatus = "pending" | "loading" | "delivered" | "error";

export interface IMessageStatusProps {
  readonly status: MessageStatus;
  readonly onRetry?: () => void;
}

export const MessageStatusIndicator: FC<IMessageStatusProps> = memo(
  ({ status, onRetry }) => {
    if (status === "delivered" || status === "pending") return null;

    if (status === "loading") {
      return (
        <span className="wechat-msg__status wechat-msg__status--loading" aria-label="发送中">
          <span className="wechat-msg__status-dot" />
        </span>
      );
    }

    if (status === "error") {
      return (
        <span className="wechat-msg__status wechat-msg__status--error">
          发送失败
          {onRetry && (
            <button
              type="button"
              className="wechat-msg__retry-btn"
              onClick={onRetry}
            >
              重试
            </button>
          )}
        </span>
      );
    }

    return null;
  },
);

MessageStatusIndicator.displayName = "MessageStatusIndicator";
