/**
 * @file NewMessagePill.tsx
 * "新消息 N 条"提示按钮。
 *
 * 当用户翻阅历史时新消息到来，底部显示此 pill。
 * 点击后滚到底部并清零未读。
 */

import { memo } from "react";
import type { FC } from "react";

export interface INewMessagePillProps {
  readonly unreadCount: number;
  readonly onClick: () => void;
}

export const NewMessagePill: FC<INewMessagePillProps> = memo(
  ({ unreadCount, onClick }) => {
    if (unreadCount <= 0) return null;
    return (
      <button
        type="button"
        className="wechat-new-message-pill"
        onClick={onClick}
        aria-label={`${unreadCount} 条新消息，点击回到底部`}
      >
        {unreadCount} 条新消息 ↓
      </button>
    );
  },
);

NewMessagePill.displayName = "NewMessagePill";
