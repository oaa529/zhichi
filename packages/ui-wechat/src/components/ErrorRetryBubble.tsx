/**
 * @file ErrorRetryBubble.tsx
 * 错误重试气泡。
 *
 * 当消息发送失败时显示，提供重试按钮。
 */

import { memo } from "react";
import type { FC } from "react";

export interface IErrorRetryBubbleProps {
  readonly errorMessage: string;
  readonly onRetry: () => void;
  readonly isSelf?: boolean;
}

export const ErrorRetryBubble: FC<IErrorRetryBubbleProps> = memo(
  ({ errorMessage, onRetry, isSelf = true }) => {
    return (
      <div
        className="wechat-msg-bubble wechat-msg-bubble--error"
        data-self={isSelf}
      >
        <span className="wechat-msg-bubble__error-icon" aria-hidden>⚠</span>
        <span className="wechat-msg-bubble__error-text">{errorMessage}</span>
        <button
          type="button"
          className="wechat-msg-bubble__retry-btn"
          onClick={onRetry}
        >
          重试
        </button>
      </div>
    );
  },
);

ErrorRetryBubble.displayName = "ErrorRetryBubble";
